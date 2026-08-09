import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  AnalysisRequest,
  AnalysisStage,
} from "../../shared/contracts";
import { ClaudeAdapter } from "../../electron/backend/claude";
import { CodexAdapter } from "../../electron/backend/codex";
import { CursorAdapter } from "../../electron/backend/cursor";
import {
  buildAnalysisPrompt,
  captureProviderOutputToFile,
  discoverCodexModels,
  discoverClaudeModels,
  discoverCursorModels,
  MAX_PROVIDER_OUTPUT,
  parseClaudeModelHelp,
  parseProviderModels,
  parseProviderOutput,
  runProviderProcess,
  schemaForProvider,
  type ProviderMetadataSpawn,
} from "../../electron/backend/agent";
import { validateWalkthroughDocument } from "../../shared/schema";
import { AnalysisService } from "../../electron/backend/service";

type SpawnCall = {
  file: string;
  args: string[];
  options: {
    cwd: string;
    stdio: "pipe";
    windowsHide: boolean;
    env?: NodeJS.ProcessEnv;
  };
  stdinEnd: ReturnType<typeof vi.fn>;
};

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

const requestFor = (
  provider: AnalysisRequest["provider"],
): AnalysisRequest => ({
  repository: "acme/atlas",
  pullNumber: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  provider,
});

function fakeSpawn(rawOutput: string, calls: SpawnCall[], stderrOutput = "") {
  return (
    file: string,
    args: string[],
    options: SpawnCall["options"],
  ): ChildProcess => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdinEnd = vi.fn();
    child.stdin = { write: vi.fn(), end: stdinEnd };
    child.kill = vi.fn();
    calls.push({ file, args, options, stdinEnd });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(rawOutput));
      if (stderrOutput) child.stderr.emit("data", Buffer.from(stderrOutput));
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  };
}

const progress = vi.fn<(stage: AnalysisStage, message: string) => void>();
const adapterCapabilities = {
  structuredOutput: true,
  streaming: false,
  sessionContinuation: false,
  readOnly: true,
  toolAllowlist: false,
  modelSelection: true,
  authenticationState: false,
};

describe("provider structured-output schema", () => {
  it("constrains map evidence lines before service validation", () => {
    const schema = schemaForProvider({ kind: "map", id: "map-001", total: 1, assignedPaths: ["a.ts"] }) as Record<string, unknown>;
    const observations = (schema.properties as Record<string, unknown>).observations as Record<string, unknown>;
    const observation = observations.items as Record<string, unknown>;
    const evidence = (observation.properties as Record<string, unknown>).evidence as Record<string, unknown>;
    expect(evidence.minItems).toBe(1);
    const evidenceItem = evidence.items as Record<string, unknown>;
    const line = (evidenceItem.properties as Record<string, unknown>).line as Record<string, unknown>;
    expect(line).toMatchObject({ type: ["integer", "null"], minimum: 1 });
  });

  it("normalizes every object and array for Codex strict JSON-schema mode", () => {
    const schema = schemaForProvider() as Record<string, unknown>;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (
        node.type === "object" &&
        node.properties &&
        typeof node.properties === "object"
      ) {
        const properties = node.properties as Record<string, unknown>;
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(properties));
        Object.values(properties).forEach(walk);
      }
      if (node.type === "array") {
        expect(node.items).toBeDefined();
        walk(node.items);
      }
    };

    expect(schema.$id).toBeUndefined();
    walk(schema);
    const summary = (schema.properties as Record<string, unknown>)
      .summary as Record<string, unknown>;
    const summaryProperties = summary.properties as Record<string, unknown>;
    for (const key of [
      "behavioralChanges",
      "architecturalImpact",
      "limitations",
    ]) {
      expect((summaryProperties[key] as Record<string, unknown>).items).toEqual(
        expect.objectContaining({ type: "string", minLength: 1 }),
      );
    }
  });

  it("requires rich walkthrough fields in provider output while keeping historical documents valid", () => {
    const schema = schemaForProvider() as Record<string, unknown>;
    const propertiesAt = (path: string[]): Record<string, unknown> => {
      let node: Record<string, unknown> = schema;
      for (const segment of path) {
        const properties = node.properties as Record<string, unknown>;
        node = properties[segment] as Record<string, unknown>;
        if (node.type === "array") node = node.items as Record<string, unknown>;
      }
      return node.properties as Record<string, unknown>;
    };
    const expectRich = (path: string[], fields: string[]) => {
      const node = propertiesAt(path);
      expect(Object.keys(node)).toEqual(expect.arrayContaining(fields));
      const parent = path.reduce<Record<string, unknown>>(
        (current, segment) => {
          const properties = current.properties as Record<string, unknown>;
          const next = properties[segment] as Record<string, unknown>;
          return next.type === "array"
            ? (next.items as Record<string, unknown>)
            : next;
        },
        schema,
      );
      expect(parent.required).toEqual(expect.arrayContaining(fields));
    };
    expectRich(
      ["changeGroups"],
      ["summary", "motivation", "previousBehavior", "newBehavior", "attention"],
    );
    expectRich(["evidence"], ["path"]);
    expectRich(["tests"], ["title", "behavior"]);
    expectRich(["reviewThreads"], ["author", "body"]);
    expectRich(["reviewInsights"], ["detail", "status", "provenance"]);
    expectRich(["graphs", "systemOverview"], ["description"]);
    expectRich(["graphs", "systemOverview", "nodes"], ["label", "evidenceIds"]);
    expectRich(
      ["graphs", "systemOverview", "guidedTours", "steps"],
      ["title", "explanation"],
    );

    expect(validateWalkthroughDocument(minimalWalkthrough()).valid).toBe(true);
  });
});

describe("provider output envelopes", () => {
  it("extracts a walkthrough from Codex JSONL item.completed instead of trailing turn events", () => {
    const walkthrough = minimalWalkthrough();
    const raw = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(walkthrough) },
      },
      { type: "turn.completed" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    expect(parseProviderOutput(raw)).toEqual(walkthrough);
  });

  it("extracts one fenced JSON walkthrough from a prose result envelope", () => {
    const walkthrough = minimalWalkthrough();
    const raw = JSON.stringify({
      type: "result",
      result: `I prepared the walkthrough below.\n\n\`\`\`json\n${JSON.stringify(walkthrough)}\n\`\`\`\nThis is the complete result.`,
    });

    expect(parseProviderOutput(raw)).toEqual(walkthrough);
  });
});

describe("provider model discovery", () => {
  it("parses Cursor Agent plain model listings while ignoring headers and tips", () => {
    const raw = `Available models

auto - Auto (default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High

Tip: Use --model <model> to select a model.
`;

    expect(parseProviderModels(raw)).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High" },
    ]);
  });

  it("parses ANSI-styled Cursor model listings emitted by color-forced Electron environments", () => {
    const raw = `\u001b[2mAvailable models\u001b[22m

\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m\u001b[2m (default)\u001b[22m
\u001b[36mgpt-5.6-sol-high\u001b[39m \u001b[2m- GPT-5.6 Sol 1M High\u001b[22m
`;

    expect(parseProviderModels(raw)).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High" },
    ]);
  });

  it("recaptures a truncated ANSI Cursor listing so late models remain discoverable", async () => {
    const fillerRows = Array.from({ length: 180 }, (_, index) =>
      `\u001b[36mfiller-model-${index}\u001b[39m \u001b[2m- Filler model ${index}\u001b[22m\n`,
    ).join("");
    const fullListing = `\u001b[2mAvailable models\u001b[22m\n\n${fillerRows}\u001b[36mgpt-5.6-luna\u001b[39m \u001b[2m- GPT-5.6 Luna\u001b[22m\n\u001b[36mgpt-5.6-luna-high\u001b[39m \u001b[2m- GPT-5.6 Luna High\u001b[22m\n\u001b[2mTip: Use --model <model> to select a model.\u001b[22m\n`;
    expect(fullListing.length).toBeGreaterThan(8_192);
    expect(fullListing.indexOf("gpt-5.6-luna")).toBeGreaterThan(8_192);
    const runner = {
      run: vi.fn(async () => ({ stdout: fullListing.slice(0, 8_192) })),
    };
    const capture = vi.fn(async () => fullListing);

    const models = await discoverCursorModels(runner, "cursor-agent", capture);

    expect(models).toContainEqual({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" });
    expect(models).toContainEqual({ id: "gpt-5.6-luna-high", label: "GPT-5.6 Luna High" });
    expect(capture).toHaveBeenCalledWith("cursor-agent", ["--list-models"], "cursor", 10_000);
  });

  it("parses ANSI-styled Claude model help", () => {
    expect(parseClaudeModelHelp(`Options:
  \u001b[1m--model\u001b[22m <model>                Model for the current session. Aliases:
                                        \u001b[36m\`fable\`\u001b[39m, \`opus\`, and \`sonnet\`.
  --next-option                         Another option
`)).toEqual([
      { id: "fable", label: "fable" },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
    ]);
  });

  it("retries a successful but incomplete Claude help response through file-backed capture", async () => {
    const runner = {
      run: vi.fn(async () => ({ stdout: "Usage: claude [options]", stderr: "" })),
    };
    const capture = vi.fn(async () => `Options:
  --model <model>                       Model aliases (e.g. 'fable', 'opus', or 'sonnet').
  --next-option                         Another option
`);

    await expect(discoverClaudeModels(runner, "claude", capture)).resolves.toEqual([
      { id: "fable", label: "fable" },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
    ]);
    expect(capture).toHaveBeenCalledWith("claude", ["--help"], "claude", 10_000);
  });

  it("captures provider metadata through a private file descriptor", async () => {
    await expect(captureProviderOutputToFile(
      process.execPath,
      ["-e", "process.stdout.write('provider metadata')"],
      "claude",
      10_000,
    )).resolves.toBe("provider metadata");
  });

  it("force-terminates and settles when provider metadata capture never closes", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    child.kill = vi.fn(() => true);
    const spawnNeverCloses = vi.fn(() => child) as unknown as ProviderMetadataSpawn;

    await expect(captureProviderOutputToFile(
      process.execPath,
      ["--version"],
      "claude",
      5,
      spawnNeverCloses,
      5,
    )).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("rejects and terminates while an oversized provider metadata process is still running", async () => {
    const startedAt = Date.now();

    await expect(captureProviderOutputToFile(
      process.execPath,
      [
        "-e",
        `process.stdout.write(Buffer.alloc(${MAX_PROVIDER_OUTPUT + 1}, 120)); setInterval(() => {}, 1000);`,
      ],
      "claude",
      10_000,
      undefined,
      25,
    )).rejects.toThrow(/exceeded/i);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 5_000);

  it("removes the temporary directory when the metadata output file cannot be opened", async () => {
    let attemptedTarget = "";
    const openFile = vi.fn(async (target: string) => {
      attemptedTarget = target;
      throw new Error("open failed");
    });
    const spawn = vi.fn() as unknown as ProviderMetadataSpawn;

    await expect(captureProviderOutputToFile(
      process.execPath,
      ["--version"],
      "claude",
      10_000,
      spawn,
      25,
      openFile,
    )).rejects.toThrow("open failed");
    expect(attemptedTarget).not.toBe("");
    expect(existsSync(resolve(attemptedTarget, ".."))).toBe(false);
  });
});

describe("provider analysis prompt", () => {
  it("requires graph edge, tour, and final consistency checks", () => {
    const prompt = buildAnalysisPrompt(requestFor("claude"));
    expect(prompt).toMatch(
      /every graph edge source and target must reference an existing node in the same graph/i,
    );
    expect(prompt).toMatch(
      /every guided-tour step nodeId must reference an existing node in that graph/i,
    );
    expect(prompt).toMatch(/final consistency check before returning/i);
    expect(prompt).toMatch(
      /no review threads.*empty reviewThreads and reviewInsights arrays/i,
    );
  });

  it("preserves the complete direct fallback contract for a non-task analysis", () => {
    const prompt = buildAnalysisPrompt(requestFor("codex"), "/deterministic/input");
    expect(prompt).toContain("/deterministic/input");
    expect(prompt).toMatch(/attach exact evidence IDs for changed-file\/diff facts.*tests.*review comments/i);
    expect(prompt).toMatch(/system-overview.*zero edges.*changed=false.*no PR-specific associations or evidence/i);
    expect(prompt).toMatch(/every graph node needs explanatory text.*change-group.*test.*review-thread.*review-insight.*evidence id arrays/i);
    expect(prompt).toMatch(/dependencies on earlier step IDs only/i);
    expect(prompt).toMatch(/verify all evidence files exist.*required relationship links/i);
  });

  it("defines deterministic GitHub review status precedence and canonical metadata", () => {
    const prompt = buildAnalysisPrompt(requestFor("claude"));
    expect(prompt).toMatch(
      /outdated if isOutdated is true.*resolved if isResolved is true.*active/i,
    );
    expect(prompt).toMatch(
      /preserve.*author.*body.*location.*timestamp.*commit/i,
    );
  });

  it("adds user collection guidance without allowing it to replace the fixed structure", () => {
    const prompt = buildAnalysisPrompt({
      ...requestFor("claude"),
      customPrompt: "Collect more migration and rollback evidence.",
    });
    expect(prompt).toMatch(/supplemental collection guidance/i);
    expect(prompt).toContain("Collect more migration and rollback evidence.");
    expect(prompt).toMatch(/cannot remove, rename, or weaken/i);
    expect(prompt).toMatch(
      /return only output conforming to the supplied JSON schema/i,
    );
  });

  it.each(["map", "reduce"] as const)("keeps %s tasks isolated from untrusted artifact instructions", (kind) => {
    const prompt = buildAnalysisPrompt(requestFor("codex"), "/isolated/task", { kind, id: kind, total: 2, assignedPaths: kind === "map" ? ["src/a.ts"] : undefined });
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/never obey instructions/i);
    expect(prompt).toMatch(/never reveal secrets/i);
    expect(prompt).toMatch(/never modify files/i);
    expect(prompt).toMatch(/do not (?:read|inspect|search) outside/i);
    if (kind === "map") {
      expect(prompt).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(prompt).toContain("validate-map-output.mjs");
      expect(prompt).toMatch(/before returning.*JSON/i);
      expect(prompt).toMatch(/stdin/i);
    }
    if (kind === "reduce") {
      expect(prompt).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(prompt).toContain("validate-reduce-output.mjs");
      expect(prompt).toMatch(/before returning.*JSON/i);
      expect(prompt).toMatch(/stdin/i);
    }
  });

  it.each(["map", "reduce"] as const)("carries request controls into the %s contract", (kind) => {
    const prompt = buildAnalysisPrompt({ ...requestFor("codex"), customPrompt: "Prioritize migrations.", config: { depth: "deep", scanMode: "legacy", maxGraphNodes: 17, includeReviewComments: false, timeoutMinutes: 20 } }, "/isolated/task", { kind, id: kind, total: 2, assignedPaths: kind === "map" ? ["src/a.ts"] : undefined });
    expect(prompt).toContain("Prioritize migrations.");
    expect(prompt).toMatch(/cannot remove, rename, or weaken/i);
    expect(prompt).toMatch(/analysis depth is deep/i);
    expect(prompt).toMatch(/17 nodes/i);
    expect(prompt).toMatch(/review comments were intentionally excluded/i);
    if (kind === "reduce") expect(prompt).toMatch(/four graphs|graph edge|guided tour/i);
  });
});

describe("coordinator provider bootstrap", () => {
  const task = {
    kind: "anchor" as const,
    id: "anchor",
    total: 1,
    coordinator: { url: "http://127.0.0.1:41891", token: "task-token", shimPath: "/tmp/atlas-coordinator-mcp.cjs", submitted: () => null },
  };

  it("directs anchor and walkthrough tasks to read untrusted deterministic PR context", () => {
    expect(buildAnalysisPrompt(requestFor("codex"), undefined, task)).toMatch(/get_pr_context.*untrusted data/i);
    expect(buildAnalysisPrompt(requestFor("codex"), undefined, { ...task, kind: "walkthrough", id: "walkthrough", total: 3 })).toMatch(/get_pr_context.*untrusted data/i);
    expect(buildAnalysisPrompt(requestFor("codex"), undefined, { ...task, kind: "flows", id: "flows", total: 3 })).not.toMatch(/get_pr_context/i);
  });

  it("keeps specialist role and final relationship invariants in coordinator prompts", () => {
    const prompt = buildAnalysisPrompt(requestFor("codex"), undefined, { ...task, kind: "flows", id: "flows", total: 3 });
    expect(prompt).toMatch(/get_task.*get_anchor/i);
    expect(prompt).toMatch(/exactly the four graph payloads/i);
    expect(prompt).toMatch(/systemOverview.*zero edges.*changed=false.*empty changeGroupIds.*testIds.*reviewThreadIds.*reviewInsightIds.*evidence arrays/i);
    expect(prompt).toMatch(/guided-tour step must reference a node/i);
    expect(prompt).toMatch(/evidence references must be \{path,line,role\} with role changed\|unchanged-context/i);
    expect(prompt).not.toContain("src/a.ts");
  });

  it("redacts the final coordinator child environment from raw output, logs, and returned task values", async () => {
    const calls: SpawnCall[] = [];
    const finalToken = "final-coordinator-token-123";
    const finalUrl = "http://127.0.0.1:43123";
    const response = await runProviderProcess(
      { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: adapterCapabilities }), getCapabilities: () => adapterCapabilities, analyze: vi.fn() },
      { run: vi.fn() },
      fakeSpawn(`stdout ${finalToken} ${finalUrl}`, calls, `stderr ${finalToken} ${finalUrl}`),
      "test",
      [],
      requestFor("codex"),
      "/worktree",
      undefined,
      progress,
      { ...task, coordinator: { ...task.coordinator, submitted: () => ({ taskId: "anchor", detail: `${finalToken} ${finalUrl}` } as never) } },
      { ATLAS_TASK_TOKEN: finalToken, ATLAS_COORDINATOR_URL: finalUrl },
    );
    expect(JSON.stringify(response)).not.toContain(finalToken);
    expect(JSON.stringify(response)).not.toContain(finalUrl);
    expect(response.rawOutput).toContain("[REDACTED]");
    expect(response.logs.join("\n")).toContain("[REDACTED]");
    expect(JSON.stringify(response.taskOutput)).toContain("[REDACTED]");
    expect(calls[0].options.env).toMatchObject({ ATLAS_TASK_TOKEN: finalToken, ATLAS_COORDINATOR_URL: finalUrl });
  });

  it("routes reduce output through final walkthrough parsing instead of the intermediary task envelope", async () => {
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: adapterCapabilities }), getCapabilities: () => adapterCapabilities, analyze: vi.fn() };
    const walkthrough = minimalWalkthrough();
    const envelope = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(walkthrough) } });
    const ready = await runProviderProcess(adapter, { run: vi.fn() }, fakeSpawn(envelope, []), "test", [], requestFor("codex"), "/worktree", undefined, progress, { kind: "reduce", id: "reduce-001", total: 1 });
    expect(ready.status).toBe("ready");
    expect(validateWalkthroughDocument(ready.document).valid).toBe(true);
    const malformed = await runProviderProcess(adapter, { run: vi.fn() }, fakeSpawn('{"taskId":"reduce-001"}', []), "test", [], requestFor("codex"), "/worktree", undefined, progress, { kind: "reduce", id: "reduce-001", total: 1 });
    expect(malformed.status).toBe("invalid");
    expect(malformed.document).toBeUndefined();
  });

  it("boots Codex and Claude with only the task-scoped Atlas MCP and strict discovery", async () => {
    const codexCalls: SpawnCall[] = [];
    const codex = new CodexAdapter({ run: vi.fn(async () => ({ stdout: "codex 1.2.3" })) }, fakeSpawn("{}", codexCalls));
    await codex.analyze(requestFor("codex"), "/worktree", "/input", undefined, progress, "gpt-test", task);
    expect(codexCalls[0].args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--model", "gpt-test"]));
    expect(codexCalls[0].args.join(" ")).toContain("mcp_servers.atlas.command");
    expect(codexCalls[0].args.join(" ")).toContain("mcp_servers.atlas.env_vars=[\"ATLAS_COORDINATOR_URL\",\"ATLAS_TASK_TOKEN\",\"ELECTRON_RUN_AS_NODE\"]");
    expect(codexCalls[0].options.env).toMatchObject({ ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, ELECTRON_RUN_AS_NODE: "1" });

    const claudeCalls: SpawnCall[] = [];
    let claudeSettings = "";
    const recordClaude = fakeSpawn("{}", claudeCalls);
    const claude = new ClaudeAdapter({ run: vi.fn(async () => ({ stdout: "Claude 1.2.3" })) }, ((file, args, options) => {
      claudeSettings = readFileSync(args[args.indexOf("--settings") + 1], "utf8");
      return recordClaude(file, args, options);
    }) as typeof recordClaude);
    await claude.analyze(requestFor("claude"), "/worktree", "/input", undefined, progress, "claude-test", task);
    expect(claudeCalls[0].args).toEqual(expect.arrayContaining(["--safe-mode", "--setting-sources", "", "--permission-mode", "plan", "--strict-mcp-config", "--mcp-config", "--settings", "--no-session-persistence", "--model", "claude-test"]));
    expect(claudeCalls[0].args).not.toContain("--bare");
    const claudeTools = claudeCalls[0].args[claudeCalls[0].args.indexOf("--allowedTools") + 1];
    expect(claudeTools).toContain("Read,Grep,Glob,Bash");
    expect(claudeTools).toContain("mcp__atlas__get_pr_context");
    expect(claudeTools).toContain("mcp__atlas__preflight_result");
    expect(claudeTools).toContain("mcp__atlas__submit_result");
    expect(claudeCalls[0].options.env).toMatchObject({ ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, ELECTRON_RUN_AS_NODE: "1" });
    expect(claudeCalls[0].args[claudeCalls[0].args.indexOf("--mcp-config") + 1]).toBe(claudeCalls[0].args[claudeCalls[0].args.indexOf("--settings") + 1]);
    expect(JSON.parse(claudeSettings)).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: ["/worktree"] }, network: { allowedDomains: [] } } });
  });

  it("runs Cursor from a disposable shadow worktree with its task-scoped MCP bootstrap", async () => {
    const calls: SpawnCall[] = [];
    const runner = { run: vi.fn(async (_file: string, args: string[]) => { if (args[0] === "worktree" && args[1] === "add") await mkdir(args[3], { recursive: true }); return args[0] === "rev-parse" ? { stdout: "b".repeat(40), stderr: "" } : { stdout: "", stderr: "" }; }) };
    let shadowMcp = "";
    const recordSpawn = fakeSpawn("{}", calls);
    const adapter = new CursorAdapter(runner, ((file, args, options) => {
      const workspace = args[args.indexOf("--workspace") + 1];
      shadowMcp = readFileSync(join(workspace, ".cursor", "mcp.json"), "utf8");
      return recordSpawn(file, args, options);
    }) as typeof recordSpawn);
    await adapter.analyze(requestFor("cursor"), "/worktree", "/input", undefined, progress, "cursor-test", task);
    expect(calls[0].file).toBe("cursor-agent");
    expect(calls[0].args).toEqual(expect.arrayContaining(["--workspace", "--approve-mcps", "--mode", "ask", "--sandbox", "enabled", "--model", "cursor-test"]));
    expect(calls[0].args).not.toContain("--force");
    const workspace = calls[0].args[calls[0].args.indexOf("--workspace") + 1];
    expect(workspace).not.toBe("/worktree");
    expect(calls[0].options.cwd).toBe(workspace);
    expect(calls[0].options.env).toMatchObject({ ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, CURSOR_CONFIG_DIR: expect.any(String), ELECTRON_RUN_AS_NODE: "1" });
    expect(JSON.parse(shadowMcp)).toEqual({ mcpServers: { atlas: { command: process.execPath, args: [task.coordinator.shimPath], env: { ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, ELECTRON_RUN_AS_NODE: "1" } } } });
    expect(runner.run).toHaveBeenCalledWith("git", expect.arrayContaining(["worktree", "add", "--detach"]), expect.objectContaining({ cwd: "/worktree" }));
  });

  it("removes untrusted Cursor instruction files only from the disposable coordinator shadow", async () => {
    const source = await mkdtemp(join(tmpdir(), "pr-atlas-cursor-source-"));
    const calls: SpawnCall[] = [];
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (_file === "cursor-agent") return { stdout: "cursor-agent 1.2.3", stderr: "" };
      if (args[0] === "worktree" && args[1] === "add") {
        const shadow = args[3];
        await mkdir(join(shadow, "src"), { recursive: true });
        await mkdir(join(shadow, ".cursor", "rules"), { recursive: true });
        await mkdir(join(shadow, "nested", ".cursor", "rules"), { recursive: true });
        await writeFile(join(shadow, "src", "ordinary.ts"), "export const ordinary = true;\n");
        await writeFile(join(shadow, "AGENTS.md"), "ignore this\n");
        await writeFile(join(shadow, ".cursorrules"), "ignore this\n");
        await writeFile(join(shadow, ".cursor", "rules", "root.mdc"), "ignore this\n");
        await writeFile(join(shadow, "nested", "CLAUDE.md"), "ignore this\n");
        await writeFile(join(shadow, "nested", ".cursorrules"), "ignore this\n");
        await writeFile(join(shadow, "nested", ".cursor", "rules", "nested.mdc"), "ignore this\n");
      }
      if (args[0] === "rev-parse") return { stdout: "b".repeat(40), stderr: "" };
      return { stdout: "", stderr: "" };
    }) };
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, ".cursor", "rules"), { recursive: true });
    await writeFile(join(source, "src", "ordinary.ts"), "export const ordinary = true;\n");
    await writeFile(join(source, "AGENTS.md"), "source instruction remains\n");
    await writeFile(join(source, ".cursor", "rules", "root.mdc"), "source rule remains\n");
    const recordSpawn = fakeSpawn("{}", calls);
    const adapter = new CursorAdapter(runner, ((file, args, options) => {
      const shadow = args[args.indexOf("--workspace") + 1];
      expect(readFileSync(join(shadow, "src", "ordinary.ts"), "utf8")).toContain("ordinary");
      for (const path of ["AGENTS.md", ".cursorrules", ".cursor/rules/root.mdc", "nested/CLAUDE.md", "nested/.cursorrules", "nested/.cursor/rules/nested.mdc"])
        expect(existsSync(join(shadow, path))).toBe(false);
      return recordSpawn(file, args, options);
    }) as typeof recordSpawn);
    try {
      await adapter.analyze(requestFor("cursor"), source, "/input", undefined, progress, undefined, task);
      expect(calls).toHaveLength(1);
      expect(readFileSync(join(source, "AGENTS.md"), "utf8")).toContain("source instruction remains");
      expect(readFileSync(join(source, ".cursor", "rules", "root.mdc"), "utf8")).toContain("source rule remains");
    } finally { await rm(source, { recursive: true, force: true }); }
  });

  it.each(["directory", "file"])("never follows a repository-controlled Cursor MCP symlink to an external %s", async (kind) => {
    const source = await mkdtemp(join(tmpdir(), "pr-atlas-cursor-source-")); const external = await mkdtemp(join(tmpdir(), "pr-atlas-cursor-external-")); const sentinel = join(external, "sentinel");
    await writeFile(sentinel, "unchanged");
    const calls: SpawnCall[] = [];
    const runner = { run: vi.fn(async (file: string, args: string[]) => {
      if (file === "cursor-agent") return { stdout: "cursor-agent 1", stderr: "" };
      if (args[0] === "worktree" && args[1] === "add") { const shadow = args[3]; await mkdir(shadow, { recursive: true }); if (kind === "directory") await symlink(external, join(shadow, ".cursor")); else { await mkdir(join(shadow, ".cursor"), { recursive: true }); await symlink(sentinel, join(shadow, ".cursor", "mcp.json")); } }
      if (args[0] === "rev-parse") return { stdout: "b".repeat(40), stderr: "" }; return { stdout: "", stderr: "" };
    }) };
    try {
      const response = await new CursorAdapter(runner, fakeSpawn("{}", calls)).analyze(requestFor("cursor"), source, "/input", undefined, progress, undefined, task);
      expect(response.errors).toContain("Cursor coordinator instruction isolation was unavailable.");
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged"); expect(calls).toHaveLength(0);
    } finally { await rm(source, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
  });

  it("rejects a Cursor coordinator result when the disposable exact-head worktree changes", async () => {
    const calls: SpawnCall[] = []; let statusChecks = 0;
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") await mkdir(args[3], { recursive: true });
      if (args[0] === "rev-parse") return { stdout: "b".repeat(40), stderr: "" };
      if (args[0] === "status") return { stdout: statusChecks++ === 2 ? " M src/a.ts\n" : "", stderr: "" };
      return { stdout: "", stderr: "" };
    }) };
    const adapter = new CursorAdapter(runner, fakeSpawn("{}", calls));
    const response = await adapter.analyze(requestFor("cursor"), "/worktree", "/input", undefined, progress, undefined, { ...task, coordinator: { ...task.coordinator, submitted: () => ({ taskId: "anchor" } as never) } });
    expect(response.status).toBe("invalid");
    expect(response.errors).toEqual(["Cursor modified the disposable exact-head worktree; output was rejected."]);
    expect(calls[0].file).toBe("cursor-agent");
  });
});

function minimalWalkthrough(): Record<string, unknown> {
  const graph = (id: string) => ({
    id,
    description: `Review ${id}.`,
    nodes: [
      {
        id: `${id}-node`,
        label: "Relevant node",
        explanation: "A relevant node.",
        changed: id !== "system-overview",
        changeGroupIds: id === "system-overview" ? [] : ["group-1"],
        testIds: [],
        reviewThreadIds: [],
        reviewInsightIds: [],
        evidenceIds: id === "system-overview" ? [] : ["evidence-1"],
      },
    ],
    edges:
      id === "system-overview"
        ? []
        : [
            {
              id: `${id}-edge`,
              source: `${id}-node`,
              target: `${id}-node`,
              label: "continues",
              evidenceIds: ["evidence-1"],
              changeGroupIds: ["group-1"],
              reviewThreadIds: [],
            },
          ],
    guidedTours: [
      {
        id: `${id}-tour`,
        title: "Review this graph",
        steps: [
          {
            nodeId: `${id}-node`,
            title: "Inspect node",
            explanation: "Verify exact evidence.",
          },
        ],
      },
    ],
  });
  return {
    schemaVersion: "1.1.0",
    run: {
      id: "run-1",
      createdAt: "2026-08-05T00:00:00.000Z",
      provider: "codex",
      model: "test-model",
      skillVersion: "1.0.0",
    },
    pullRequest: {
      host: "github.com",
      repository: "acme/atlas",
      number: 42,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    summary: {
      intent: "Trace the changed system.",
      behavioralChanges: [],
      architecturalImpact: [],
      limitations: [],
    },
    changeGroups: [
      {
        id: "group-1",
        title: "Trace evidence",
        summary: "Connects the behavior to code.",
        motivation: "Reviewers need exact evidence.",
        previousBehavior: "Evidence was implicit.",
        newBehavior: "Evidence is linked.",
        attention: "medium",
        evidenceIds: ["evidence-1"],
      },
    ],
    walkthrough: [
      {
        id: "step-1",
        title: "Inspect evidence",
        reason: "It anchors the review in source evidence.",
        summary: "Inspect the changed agent source.",
        limitations: [],
        dependsOnStepIds: [],
        changeGroupId: "group-1",
        flowNodeIds: ["data-flow-node"],
        evidenceIds: ["evidence-1"],
        testIds: [],
        reviewInsightIds: [],
      },
    ],
    graphs: {
      systemOverview: graph("system-overview"),
      dataFlow: graph("data-flow"),
      codeDependency: graph("code-dependency"),
      userAction: graph("user-action"),
    },
    tests: [],
    reviewThreads: [],
    reviewInsights: [],
    evidence: [
      {
        id: "evidence-1",
        kind: "file",
        title: "Agent source",
        path: "electron/backend/agent.ts",
        line: null,
        url: null,
      },
    ],
  };
}

describe("provider-neutral agent adapters", () => {
  it("emits the six live analysis stages exactly once and in order", async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-stage-order-`);
    const headSha = "b".repeat(40);
    const worktree = resolve(root, "worktrees/github.com/acme/atlas", headSha);
    const stages: AnalysisStage[] = [];
    try {
      await mkdir(resolve(worktree, "electron/backend"), { recursive: true });
      await writeFile(
        resolve(worktree, "electron/backend/agent.ts"),
        "export {};\n",
      );
      const runner = {
        run: vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
          if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? options?.cwd ?? "" : options?.cwd?.split(/[\\/]/).at(-1) ?? "", stderr: "" };
          if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
          if (file === "gh" && args[0] === "api" && args[1] === "graphql")
            return {
              stdout: JSON.stringify([
                {
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: {
                          nodes: [],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                },
              ]),
              stderr: "",
            };
          if (file === "gh" && args[0] === "api")
            return { stdout: "[]", stderr: "" };
          return { stdout: "", stderr: "" };
        }),
      };
      const adapter: AgentAdapter = {
        id: "codex",
        displayName: "Test Codex",
        detect: async () => ({
          provider: "codex",
          displayName: "Test Codex",
          executable: "codex",
          installed: true,
          capabilities: adapterCapabilities,
        }),
        getCapabilities: () => adapterCapabilities,
        analyze: async (_request, _worktree, _input, _signal, emit) => {
          emit("generating", "Generating with the provider.");
          emit("validating", "Validating generated output.");
          return {
            status: "ready",
            rawOutput: "{}",
            logs: [],
            document: minimalWalkthrough() as never,
          };
        },
      };
      const service = new AnalysisService(
        root,
        runner,
        (event) => stages.push(event.stage),
        undefined,
        [adapter],
      );

      await expect(
        service.startAnalysis({
          ...requestFor("codex"),
          repository: "acme/atlas",
          headSha,
        }),
      ).resolves.toMatchObject({ status: "ready" });
      expect(stages).toEqual([
        "preparing",
        "collecting",
        "inspecting",
        "generating",
        "validating",
        "complete",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports providers in Codex, Cursor, Claude priority regardless of construction order", async () => {
    const adapter = (id: "claude" | "codex" | "cursor"): AgentAdapter => ({
      id,
      displayName: id,
      detect: vi.fn(async () => ({
        provider: id,
        displayName: id,
        executable: id,
        installed: true,
        capabilities: adapterCapabilities,
      })),
      getCapabilities: () => adapterCapabilities,
      analyze: vi.fn(),
    });
    const service = new AnalysisService(
      "/tmp/pr-atlas-provider-priority",
      { run: vi.fn() },
      undefined,
      undefined,
      [adapter("claude"), adapter("cursor"), adapter("codex")],
    );

    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({ provider: "codex" }),
      expect.objectContaining({ provider: "cursor" }),
      expect.objectContaining({ provider: "claude" }),
    ]);
  });

  it("surfaces only model choices dynamically reported by each installed adapter", async () => {
    const adapter = {
      id: "codex",
      displayName: "Codex CLI",
      detect: vi.fn(async () => ({
        provider: "codex",
        displayName: "Codex CLI",
        executable: "codex",
        installed: true,
        capabilities: adapterCapabilities,
      })),
      listModels: vi.fn(async () => [
        { id: "tool-model-a", label: "Tool model A", isDefault: true },
      ]),
      getCapabilities: vi.fn(),
      analyze: vi.fn(),
    } as unknown as AgentAdapter;
    const service = new AnalysisService(
      "/tmp/pr-atlas-provider-models",
      { run: vi.fn() },
      undefined,
      undefined,
      [adapter],
    );

    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({
        models: [
          { id: "tool-model-a", label: "Tool model A", isDefault: true },
        ],
      }),
    ]);
    expect(adapter.listModels).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["claude", ClaudeAdapter, "claude", "Claude Code 1.2.3"],
    ["codex", CodexAdapter, "codex", "codex-cli 1.2.3"],
    ["cursor", CursorAdapter, "cursor-agent", "cursor-agent 1.2.3"],
  ] as const)(
    "detects %s through the injected command runner",
    async (_id, Adapter, executable, version) => {
      const runner = {
        run: vi.fn(async (file: string, args: string[]) => {
          expect(file).toBe(executable);
          expect(args).toEqual(["--version"]);
          return { stdout: version };
        }),
      };

      const adapter = new Adapter(runner);
      const status = await adapter.detect();

      expect(status.installed).toBe(true);
      expect(status.executable).toBe(executable);
      expect(status.version).toBe(version);
      expect(runner.run).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["claude", ClaudeAdapter, "claude"],
    ["codex", CodexAdapter, "codex"],
    ["cursor", CursorAdapter, "cursor-agent"],
  ] as const)(
    "returns a safe unavailable status when %s is not on PATH",
    async (_id, Adapter, executable) => {
      const runner = {
        run: vi.fn(async () => {
          throw new Error(`spawn ${executable} ENOENT`);
        }),
      };
      const adapter = new Adapter(runner);

      const status = await adapter.detect();

      expect(status.installed).toBe(false);
      expect(status.executable).toBe(executable);
      expect(status.error).toEqual(expect.any(String));
      expect(status.error).not.toContain("ENOENT");
    },
  );

  it.each([
    ["codex", CodexAdapter, "codex", ["models"]],
    ["cursor", CursorAdapter, "cursor-agent", ["--list-models"]],
  ] as const)(
    "discovers %s models from the installed runtime",
    async (_id, Adapter, executable, expectedArgs) => {
      const runner = {
        run: vi.fn(async (file: string, args: string[]) => {
          expect(file).toBe(executable);
          expect(args).toEqual(expectedArgs);
          return {
            stdout: JSON.stringify({
              models: [
                { id: `${_id}-runtime-1`, name: "display name" },
                { id: `${_id}-runtime-2` },
              ],
            }),
          };
        }),
      };
      const adapter = new Adapter(runner);

      await expect(adapter.listModels()).resolves.toEqual([
        { id: `${_id}-runtime-1`, label: "display name" },
        { id: `${_id}-runtime-2`, label: `${_id}-runtime-2` },
      ]);
      expect(runner.run).toHaveBeenCalledTimes(1);
    },
  );

  it("falls back to Codex app-server model/list when the models command is unavailable", async () => {
    const calls: SpawnCall[] = [];
    const writes: string[] = [];
    let kill: ReturnType<typeof vi.fn> | undefined;
    const runner = {
      run: vi.fn(async (_file: string, args: string[]) => {
        if (args[0] === "models") throw new Error("unsupported models command");
        return { stdout: "codex-cli 1.2.3" };
      }),
    };
    const spawn = (
      file: string,
      args: string[],
      options: SpawnCall["options"],
    ): ChildProcess => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: vi.fn((payload: string | Uint8Array) => {
          const message = JSON.parse(String(payload)) as {
            id?: string;
            method?: string;
          };
          writes.push(String(payload));
          if (message.method === "initialize") {
            queueMicrotask(() =>
              child.stdout.emit(
                "data",
                Buffer.from(
                  `${JSON.stringify({ id: message.id, result: {} })}\n`,
                ),
              ),
            );
          } else if (message.method === "model/list") {
            queueMicrotask(() =>
              child.stdout.emit(
                "data",
                Buffer.from(
                  `${JSON.stringify({
                    id: message.id,
                    result: {
                      models: [
                        {
                          id: "codex-local-fast",
                          name: "Local Fast",
                          description: "Local test model",
                          isDefault: true,
                        },
                      ],
                    },
                  })}\n`,
                ),
              ),
            );
          }
          return true;
        }),
        end: vi.fn(),
      };
      child.kill = kill = vi.fn();
      calls.push({ file, args, options, stdinEnd: child.stdin.end });
      return child as unknown as ChildProcess;
    };
    const adapter = new CodexAdapter(runner, spawn);

    await expect(adapter.listModels()).resolves.toEqual([
      {
        id: "codex-local-fast",
        label: "Local Fast",
        description: "Local test model",
        isDefault: true,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "codex", args: ["app-server"] });
    expect(calls[0].options.env).toBeDefined();
    expect(writes.map((payload) => JSON.parse(payload).method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
    ]);
    expect(calls[0].stdinEnd).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to dynamically parsed Claude model aliases from --help", async () => {
    const runner = {
      run: vi.fn(async (_file: string, args: string[]) => {
        expect(args).toEqual(["--help"]);
        return {
          stdout: `Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'local-fast', 'local-quality') or a
                                        model's full name (e.g.
                                        'provider/model-latest').
  --next-option                         Another option
`,
        };
      }),
    };
    const adapter = new ClaudeAdapter(runner);

    await expect(adapter.listModels()).resolves.toEqual([
      { id: "local-fast", label: "local-fast" },
      { id: "local-quality", label: "local-quality" },
      { id: "provider/model-latest", label: "provider/model-latest" },
    ]);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("prefers documented Claude aliases over a duplicate full-name example", async () => {
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "models") throw new Error("unsupported models command");
      return { stdout: `Options:
  --model <model>                       Model for the current session. Aliases:
                                        \`fable\`, \`opus\`, and \`sonnet\`.
                                        Full model name example: \`claude-fable-5\`.
  --next-option                         Another option
` };
    }) };
    await expect(new ClaudeAdapter(runner).listModels()).resolves.toEqual([
      { id: "fable", label: "fable" },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
    ]);
  });

  it("keeps a future full-name-only Claude model from help", () => {
    expect(parseClaudeModelHelp(`Options:
  --model <model>                       Full model name example: \`claude-future-9\`.
  --next-option                         Another option
`)).toEqual([{ id: "claude-future-9", label: "claude-future-9" }]);
  });

  it("cancels a Codex app-server fallback and terminates the child process", async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    const spawn = vi.fn(
      () => child as unknown as ChildProcess,
    ) as unknown as Parameters<typeof discoverCodexModels>[0];
    const controller = new AbortController();
    const models = discoverCodexModels(spawn, "codex", controller.signal);

    controller.abort();

    await expect(models).resolves.toEqual([]);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["claude", ClaudeAdapter],
    ["cursor", CursorAdapter],
  ] as const)(
    "returns an empty model list when %s does not support discovery",
    async (_id, Adapter) => {
      const runner = {
        run: vi.fn(async () => {
          throw new Error("unsupported models command");
        }),
      };
      const adapter = new Adapter(runner);

      await expect(adapter.listModels()).resolves.toEqual([]);
    },
  );

  it("returns an empty Codex model list when both discovery protocols are unavailable", async () => {
    const runner = {
      run: vi.fn(async () => {
        throw new Error("unsupported models command");
      }),
    };
    const spawn = vi.fn(() => {
      throw new Error("codex app-server unavailable");
    }) as unknown as ConstructorParameters<typeof CodexAdapter>[1];
    const adapter = new CodexAdapter(runner, spawn);

    await expect(adapter.listModels()).resolves.toEqual([]);
  });

  it.each([
    ["claude", ClaudeAdapter],
    ["codex", CodexAdapter],
    ["cursor", CursorAdapter],
  ] as const)(
    "passes an optional selected model to %s when provided",
    async (_id, Adapter) => {
      const calls: SpawnCall[] = [];
      const runner = {
        run: vi.fn(async () => ({ stdout: `${_id} CLI 1.2.3` })),
      };
      const adapter = new Adapter(
        runner,
        fakeSpawn('{"not":"a walkthrough"}', calls),
      );

      await adapter.analyze(
        { ...requestFor(_id), model: "runtime-selected-model" },
        "/worktree",
        "/input",
        undefined,
        progress,
      );

      const modelIndex = calls[0].args.indexOf("--model");
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(calls[0].args[modelIndex + 1]).toBe("runtime-selected-model");
    },
  );

  it("uses Claude plan mode, an allow-list, and structured output without write-capable tools", async () => {
    const calls: SpawnCall[] = [];
    const runner = {
      run: vi.fn(async () => ({ stdout: "Claude Code 1.2.3" })),
    };
    const adapter = new ClaudeAdapter(
      runner,
      fakeSpawn('{"not":"a walkthrough"}', calls),
    );

    const providerStages: AnalysisStage[] = [];
    const response = await adapter.analyze(
      requestFor("claude"),
      "/worktree",
      "/input",
      undefined,
      (stage) => providerStages.push(stage),
    );
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}');
    expect(providerStages).toEqual(["generating", "validating"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("claude");
    expect(calls[0].options).toMatchObject({
      cwd: "/worktree",
      stdio: "pipe",
      windowsHide: true,
    });
    expect(calls[0].args[0]).toBe("-p");
    expect(calls[0].args[1]).toContain("acme/atlas#42");
    expect(calls[0].args.slice(2)).toEqual([
      "--safe-mode",
      "--permission-mode",
      "plan",
      "--allowed-tools",
      "Read",
      "Grep",
      "Glob",
      "--add-dir",
      "/input",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      expect.any(String),
    ]);
    expect(calls[0].args.join(" ")).not.toMatch(
      /(?:--dangerously|--force|--yolo|\bBash\b|\bEdit\b|\bWrite\b)/i,
    );
    expect(calls[0].options.env?.PR_ATLAS_VALIDATOR_RUNTIME).toBeUndefined();
  });

  it.each([
    ["map", { kind: "map" as const, id: "map-001", total: 1, assignedPaths: ["src/a.ts"], validatorRuntime: "/Applications/Átlas Runtime", validatorCommand: "ELECTRON_RUN_AS_NODE=1 \"$PR_ATLAS_VALIDATOR_RUNTIME\" 'validate-map-output.mjs'" }, "Bash(ELECTRON_RUN_AS_NODE=1 \"$PR_ATLAS_VALIDATOR_RUNTIME\" 'validate-map-output.mjs' *)"],
    ["reduce", { kind: "reduce" as const, id: "reduce", total: 1, validatorRuntime: "/Applications/Átlas Runtime", validatorCommand: "ELECTRON_RUN_AS_NODE=1 \"$PR_ATLAS_VALIDATOR_RUNTIME\" 'validate-reduce-output.mjs'" }, "Bash(ELECTRON_RUN_AS_NODE=1 \"$PR_ATLAS_VALIDATOR_RUNTIME\" 'validate-reduce-output.mjs' *)"],
  ])("allows Claude %s tasks to run only their stdin validator", async (_kind, task, validatorTool) => {
    const calls: SpawnCall[] = [];
    const adapter = new ClaudeAdapter({ run: vi.fn(async () => ({ stdout: "Claude 1.2.3" })) }, fakeSpawn("{}", calls));
    await adapter.analyze(requestFor("claude"), "/isolated/task", "/isolated/task", undefined, progress, undefined, task);
    const allowedIndex = calls[0].args.indexOf("--allowed-tools");
    const addDirectoryIndex = calls[0].args.indexOf("--add-dir");
    const allowed = calls[0].args.slice(allowedIndex + 1, addDirectoryIndex);
    expect(allowed).toEqual(["Read", "Grep", "Glob", validatorTool]);
    expect(calls[0].options.env?.PR_ATLAS_VALIDATOR_RUNTIME).toBe("/Applications/Átlas Runtime");
    expect(allowed).not.toContain("Bash");
    expect(allowed.join(" ")).not.toMatch(/\b(?:Edit|Write)\b/);
  });

  it("does not inherit a host validator runtime outside a trusted task", async () => {
    const previous = process.env.PR_ATLAS_VALIDATOR_RUNTIME; process.env.PR_ATLAS_VALIDATOR_RUNTIME = "/host/untrusted-runtime";
    const calls: SpawnCall[] = []; const adapter = new ClaudeAdapter({ run: vi.fn(async () => ({ stdout: "Claude 1.2.3" })) }, fakeSpawn("{}", calls));
    try { await adapter.analyze(requestFor("claude"), "/worktree", "/input", undefined, progress); expect(calls[0].options.env?.PR_ATLAS_VALIDATOR_RUNTIME).toBeUndefined(); }
    finally { if (previous === undefined) delete process.env.PR_ATLAS_VALIDATOR_RUNTIME; else process.env.PR_ATLAS_VALIDATOR_RUNTIME = previous; }
  });

  it.each([
    { taskId: "map-001", extra: true, observations: [] },
    { taskId: "map-001", observations: [{ path: "src/a.ts", summary: "Changed.", evidence: [], changeGroups: ["group"], tests: ["test"], flows: ["flow"], limitations: ["limit"] }] },
    { taskId: "map-001", observations: [{ path: "src/a.ts", summary: "Changed.", evidence: [{ path: "src/a.ts", line: 0 }], changeGroups: ["group"], tests: ["test"], flows: ["flow"], limitations: ["limit"] }] },
  ])("rejects noncanonical map output at the provider boundary", async (output) => {
    const calls: SpawnCall[] = [];
    const adapter = new ClaudeAdapter({ run: vi.fn(async () => ({ stdout: "Claude 1.2.3" })) }, fakeSpawn(JSON.stringify(output), calls));
    const response = await adapter.analyze(requestFor("claude"), "/worktree", "/input", undefined, progress, undefined, { kind: "map", id: "map-001", total: 1, assignedPaths: ["src/a.ts"] });
    expect(response.status).toBe("invalid");
    expect(response.mapOutput).toBeUndefined();
  });

  it("extracts a canonical map from Codex JSONL before a trailing turn-completed event", async () => {
    const output = { taskId: "map-001", observations: [{ path: "src/a.ts", segment: 0, summary: "Changed.", evidence: [{ path: "src/a.ts", line: 1 }], changeGroups: ["group"], tests: ["test"], flows: ["flow"], limitations: ["limit"] }] };
    const raw = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ taskId: "map-001", observations: [] }) } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ ...output, taskId: "map-999" }) } },
      { type: "turn.completed" },
    ].map((event) => JSON.stringify(event)).join("\n");
    const calls: SpawnCall[] = [];
    const adapter = new CodexAdapter({ run: vi.fn(async () => ({ stdout: "codex 1.2.3" })) }, fakeSpawn(raw, calls));
    const response = await adapter.analyze(requestFor("codex"), "/worktree", "/input", undefined, progress, undefined, { kind: "map", id: "map-001", total: 1, assignedPaths: ["src/a.ts"] });
    expect(response.status).toBe("ready");
    expect(response.mapOutput).toEqual(output);
  });

  it("extracts a canonical fenced map from a Cursor result envelope", async () => {
    const output = {
      taskId: "map-001",
      observations: [
        {
          path: "src/a.ts",
          segment: 0,
          summary: "Documents a literal ```json marker without ending the outer fence.",
          evidence: [{ path: "src/a.ts", line: 1 }],
          changeGroups: ["group"],
          tests: ["test"],
          flows: ["flow"],
          limitations: ["limit"],
        },
      ],
    };
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `I validated the assigned map.\n\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
    });
    const calls: SpawnCall[] = [];
    const adapter = new CursorAdapter(
      { run: vi.fn(async () => ({ stdout: "cursor-agent 1.2.3" })) },
      fakeSpawn(raw, calls),
    );

    const response = await adapter.analyze(
      requestFor("cursor"),
      "/worktree",
      "/input",
      undefined,
      progress,
      undefined,
      {
        kind: "map",
        id: "map-001",
        total: 1,
        assignedPaths: ["src/a.ts"],
      },
    );

    expect(response.status).toBe("ready");
    expect(response.mapOutput).toEqual(output);
  });

  it("extracts one trailing bare map after Cursor result prose", async () => {
    const output = {
      taskId: "map-001",
      observations: [
        {
          path: "src/a.ts",
          segment: 0,
          summary: 'Changed with a } brace and an escaped "quote".',
          evidence: [{ path: "src/a.ts", line: 1 }],
          changeGroups: ["group"],
          tests: ["test"],
          flows: ["flow"],
          limitations: ["limit"],
        },
      ],
    };
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result:
        "[MODE: FAST]\nI validated the payload against the local rules by hand and am returning only that JSON." +
        JSON.stringify(output),
    });
    const adapter = new CursorAdapter(
      { run: vi.fn(async () => ({ stdout: "cursor-agent 1.2.3" })) },
      fakeSpawn(raw, []),
    );

    const response = await adapter.analyze(
      requestFor("cursor"),
      "/worktree",
      "/input",
      undefined,
      progress,
      undefined,
      {
        kind: "map",
        id: "map-001",
        total: 1,
        assignedPaths: ["src/a.ts"],
      },
    );

    expect(response.status).toBe("ready");
    expect(response.mapOutput).toEqual(output);
  });

  it.each(["trailing prose", "trailing decoy"] as const)(
    "rejects a bare Cursor map with %s",
    async (shape) => {
      const output = {
        taskId: "map-001",
        observations: [
          {
            path: "src/a.ts",
            segment: 0,
            summary: "Changed.",
            evidence: [{ path: "src/a.ts", line: 1 }],
            changeGroups: ["group"],
            tests: ["test"],
            flows: ["flow"],
            limitations: ["limit"],
          },
        ],
      };
      const suffix =
        shape === "trailing prose"
          ? "\nI added a final note."
          : `\n${JSON.stringify({ note: "decoy" })}`;
      const adapter = new CursorAdapter(
        { run: vi.fn(async () => ({ stdout: "cursor-agent 1.2.3" })) },
        fakeSpawn(
          JSON.stringify({
            type: "result",
            result: `Validated.\n${JSON.stringify(output)}${suffix}`,
          }),
          [],
        ),
      );

      const response = await adapter.analyze(
        requestFor("cursor"),
        "/worktree",
        "/input",
        undefined,
        progress,
        undefined,
        {
          kind: "map",
          id: "map-001",
          total: 1,
          assignedPaths: ["src/a.ts"],
        },
      );

      expect(response.status).toBe("invalid");
      expect(response.mapOutput).toBeUndefined();
    },
  );

  it.each(["unterminated", "generic unterminated", "multiple"] as const)(
    "rejects %s fenced map output from a Cursor result envelope",
    async (shape) => {
      const output = {
        taskId: "map-001",
        observations: [
          {
            path: "src/a.ts",
            segment: 0,
            summary: "Changed.",
            evidence: [{ path: "src/a.ts", line: 1 }],
            changeGroups: ["group"],
            tests: ["test"],
            flows: ["flow"],
            limitations: ["limit"],
          },
        ],
      };
      const fenced = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;
      const result =
        shape === "unterminated"
          ? fenced.slice(0, -3)
          : shape === "generic unterminated"
            ? `\`\`\`\n${JSON.stringify(output)}`
            : `\`\`\`json\n{"note":"decoy"}\n\`\`\`\n${fenced}`;
      const adapter = new CursorAdapter(
        { run: vi.fn(async () => ({ stdout: "cursor-agent 1.2.3" })) },
        fakeSpawn(JSON.stringify({ type: "result", result }), []),
      );

      const response = await adapter.analyze(
        requestFor("cursor"),
        "/worktree",
        "/input",
        undefined,
        progress,
        undefined,
        {
          kind: "map",
          id: "map-001",
          total: 1,
          assignedPaths: ["src/a.ts"],
        },
      );

      expect(response.status).toBe("invalid");
      expect(response.mapOutput).toBeUndefined();
    },
  );

  it("redacts and revalidates accepted map output before returning it", async () => {
    const secret = "provider-map-secret-123"; const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = secret;
    const output = { taskId: "map-001", observations: [{ path: "src/a.ts", segment: 0, summary: `Changed ${secret}.`, evidence: [{ path: "src/a.ts", line: 1 }], changeGroups: ["group"], tests: [secret], flows: [`flow ${secret}`], limitations: [`limit ${secret}`] }] };
    const adapter = new ClaudeAdapter({ run: vi.fn(async () => ({ stdout: "Claude 1.2.3" })) }, fakeSpawn(JSON.stringify(output), []));
    try {
      const response = await adapter.analyze(requestFor("claude"), "/worktree", "/input", undefined, progress, undefined, { kind: "map", id: "map-001", total: 1, assignedPaths: ["src/a.ts"] });
      expect(response.status).toBe("ready");
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(response.mapOutput?.observations[0].summary).toContain("[REDACTED]");
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  });

  it("starts Codex with JSON events, an ephemeral read-only sandbox, and no dangerous bypass", async () => {
    const calls: SpawnCall[] = [];
    const runner = { run: vi.fn(async () => ({ stdout: "codex-cli 1.2.3" })) };
    const adapter = new CodexAdapter(
      runner,
      fakeSpawn('{"not":"a walkthrough"}', calls),
    );

    const response = await adapter.analyze(
      requestFor("codex"),
      "/worktree",
      "/input",
      undefined,
      progress,
    );
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].options).toMatchObject({
      cwd: "/worktree",
      stdio: "pipe",
      windowsHide: true,
    });
    expect(calls[0].args.slice(0, 7)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
    ]);
    expect(calls[0].args[7]).toBe("--output-schema");
    expect(calls[0].args[8]).toMatch(/\/pr-atlas-schema-[^/]+\/[^/]+\.json$/);
    expect(calls[0].args[9]).toContain("acme/atlas#42");
    expect(calls[0].args[9]).toContain("/input");
    expect(calls[0].args).toHaveLength(10);
    expect(calls[0].stdinEnd).toHaveBeenCalledTimes(1);
    expect(calls[0].args.join(" ")).not.toMatch(
      /(?:dangerously-bypass|workspace-write|danger-full-access|--add-dir)/i,
    );
  });

  it("allows an isolated Codex map task to run outside a Git worktree", async () => {
    const calls: SpawnCall[] = [];
    const adapter = new CodexAdapter({ run: vi.fn(async () => ({ stdout: "codex-cli 0.146.0" })) }, fakeSpawn('{"taskId":"map-001","observations":[]}', calls));
    await adapter.analyze(requestFor("codex"), "/isolated/map", "/isolated/map", undefined, progress, undefined, { kind: "map", id: "map-001", total: 1, assignedPaths: ["src/a.ts"], assignedUnits: [] });
    const flag = calls[0].args.indexOf("--skip-git-repo-check");
    expect(flag).toBeGreaterThan(0);
    expect(flag).toBeLessThan(calls[0].args.indexOf("--output-schema"));
    expect(calls[0].args.at(-1)).toContain("map stage");
  });

  it("starts Cursor Agent in ask mode with sandboxing and the worktree/input roots", async () => {
    const calls: SpawnCall[] = [];
    const runner = {
      run: vi.fn(async () => ({ stdout: "cursor-agent 1.2.3" })),
    };
    const adapter = new CursorAdapter(
      runner,
      fakeSpawn('{"not":"a walkthrough"}', calls),
    );

    const response = await adapter.analyze(
      requestFor("cursor"),
      "/worktree",
      "/input",
      undefined,
      progress,
    );
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("cursor-agent");
    expect(calls[0].options).toMatchObject({
      cwd: "/worktree",
      stdio: "pipe",
      windowsHide: true,
    });
    expect(calls[0].args[0]).toBe("-p");
    expect(calls[0].args[1]).toContain("acme/atlas#42");
    expect(calls[0].args[1]).toContain("The exact JSON Schema follows");
    expect(calls[0].args[1]).toContain('"schemaVersion"');
    expect(calls[0].args.slice(2)).toEqual([
      "--output-format",
      "json",
      "--mode",
      "ask",
      "--sandbox",
      "enabled",
      "--workspace",
      "/worktree",
      "--trust",
      "--add-dir",
      "/input",
    ]);
    expect(calls[0].args.join(" ")).not.toMatch(
      /(?:--force|--yolo|--sandbox disabled)/i,
    );
  });

  it.each([
    ['codex', CodexAdapter, 'codex', 'high', ['exec', '-c', 'model_reasoning_effort="high"']],
    ['claude', ClaudeAdapter, 'claude', 'xhigh', ['-p', expect.any(String), '--effort', 'xhigh']],
    ['cursor', CursorAdapter, 'cursor-agent', 'medium', ['-p', expect.any(String), '--model', 'auto[effort=medium]']],
  ] as const)('applies the selected effort to %s using its documented CLI surface', async (provider, Adapter, executable, effort, expectedPrefix) => {
    const calls: SpawnCall[] = []
    const runner = { run: vi.fn(async () => ({ stdout: `${executable} 1.2.3` })) }
    const adapter = new Adapter(runner, fakeSpawn('{"not":"a walkthrough"}', calls))

    await adapter.analyze({ ...requestFor(provider), effort }, '/worktree', '/input', undefined, progress)

    expect(calls).toHaveLength(1)
    expect(calls[0].args.slice(0, expectedPrefix.length)).toEqual(expectedPrefix)
  });
});
