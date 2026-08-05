import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentAnalysisResult, AnalysisRequest, ProviderAnalysisTask } from "../../shared/contracts";
import { AnalysisService } from "../../electron/backend/service";

const request: AnalysisRequest = { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40), provider: "codex" };
const caps = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false };

function diff(files: number, bytes: number) { return Array.from({ length: files }, (_, index) => `diff --git a/src/f${index}.ts b/src/f${index}.ts\n--- a/src/f${index}.ts\n+++ b/src/f${index}.ts\n@@ -1 +1 @@\n+${"x".repeat(bytes)}`).join("\n"); }
function runner(files: number, bytes: number) {
  return { run: vi.fn(async (file: string, args: string[]) => {
    if (file === "git" && args[0] === "diff") return { stdout: diff(files, bytes), stderr: "" };
    if (file === "gh" && args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" };
    if (file === "gh" && args[0] === "api" && String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify(Array.from({ length: files }, (_, index) => ({ filename: `src/f${index}.ts`, additions: 1, deletions: 0 }))), stderr: "" };
    if (file === "gh" && args[0] === "api") return { stdout: "[]", stderr: "" };
    return { stdout: "", stderr: "" };
  }) };
}
async function setup(files: number, bytes: number, analyze: AgentAdapter["analyze"], emit: (event: { runId: string }) => void = () => {}) {
  const root = await mkdirTemp(); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
  await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(worktree, { recursive: true });
  const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze };
  return { root, service: new AnalysisService(root, runner(files, bytes), emit as never, undefined, [adapter]) };
}
async function mkdirTemp() { const root = join(tmpdir(), `pr-atlas-batch-${crypto.randomUUID()}`); await mkdir(root, { recursive: true }); return root; }
function completeMap(task: ProviderAnalysisTask): NonNullable<AgentAnalysisResult["mapOutput"]> { return { taskId: task.id, observations: (task.assignedUnits ?? task.assignedPaths?.map((path) => ({ path, segment: 0 })) ?? []).map(({ path, segment }) => ({ path, segment, summary: `Summarizes ${path}.`, evidence: [{ path, line: 1 }], changeGroups: ["batched-change"], tests: [], flows: ["changed input to behavior"], limitations: [] })) }; }
function reducerDocument() {
  const graph = (id: string) => ({ id, description: `Review ${id}.`, nodes: [{ id: `${id}-node`, label: "Relevant node", explanation: "A relevant node.", changed: id !== "system-overview", changeGroupIds: id === "system-overview" ? [] : ["group-1"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: id === "system-overview" ? [] : ["evidence-1"] }], edges: id === "system-overview" ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "continues", evidenceIds: ["evidence-1"], changeGroupIds: ["group-1"], reviewThreadIds: [] }], guidedTours: [{ id: `${id}-tour`, title: "Review this graph", steps: [{ nodeId: `${id}-node`, title: "Inspect node", explanation: "Verify exact evidence." }] }] });
  return {
    schemaVersion: "1.1.0", run: { id: "provider-run", createdAt: "2026-08-05T00:00:00.000Z", provider: "codex", model: "test-model", skillVersion: "1.0.0" },
    pullRequest: { host: "github.com", repository: request.repository, number: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha },
    summary: { intent: "Explain the batched change.", behavioralChanges: [], architecturalImpact: [], limitations: [] },
    changeGroups: [{ id: "group-1", title: "Batched change", summary: "Connects behavior to code.", motivation: "Reviewers need exact evidence.", previousBehavior: "Evidence was implicit.", newBehavior: "Evidence is linked.", attention: "medium", evidenceIds: ["evidence-1"] }],
    walkthrough: [{ id: "step-1", title: "Inspect evidence", reason: "It anchors the review in source evidence.", summary: "Inspect the changed input.", limitations: [], dependsOnStepIds: [], changeGroupId: "group-1", flowNodeIds: ["data-flow-node"], evidenceIds: ["evidence-1"], testIds: [], reviewInsightIds: [] }],
    graphs: { systemOverview: graph("system-overview"), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") },
    tests: [], reviewThreads: [], reviewInsights: [], evidence: [{ id: "evidence-1", kind: "file", title: "Changed input", path: "src/f0.ts", line: null, url: null }],
  };
}

describe("batched service orchestration", () => {
  it("caps maps at four, skips no batch, and refuses an invalid reducer document", async () => {
    let active = 0; let maximum = 0; const tasks: string[] = [];
    const env = await setup(20, 50_000, async (_r, _w, _i, _s, _p, _m, task) => {
      tasks.push(task?.kind ?? "single");
      if (task?.kind === "map") { active += 1; maximum = Math.max(maximum, active); await new Promise((done) => setTimeout(done, 5)); active -= 1; return { status: "ready", rawOutput: "{}", logs: [], mapOutput: completeMap(task) }; }
      return { status: "ready", rawOutput: "{}", logs: [], document: {} as never };
    });
    try { const result = await env.service.startAnalysis(request); expect(maximum).toBeLessThanOrEqual(4); expect(tasks.filter((task) => task === "map").length).toBeGreaterThan(4); expect(tasks.at(-1)).toBe("reduce"); expect(result.status).toBe("invalid"); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("keeps small PRs on the unchanged single-call path", async () => {
    const analyze = vi.fn(async () => ({ status: "failed" as const, rawOutput: "", logs: [], errors: ["expected"] })); const env = await setup(1, 10, analyze);
    try { await env.service.startAnalysis(request); expect(analyze).toHaveBeenCalledTimes(1); expect((analyze.mock.calls[0] as unknown[])[6]).toBeUndefined(); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("does not invoke the reducer after a partial map failure", async () => {
    const tasks: string[] = []; const env = await setup(20, 50_000, async (_r, _w, _i, _s, _p, _m, task) => { tasks.push(task?.kind ?? "single"); return task?.kind === "map" ? { status: "failed", rawOutput: "", logs: [], errors: ["map failed"] } : { status: "ready", rawOutput: "", logs: [], document: {} as never }; });
    try { const result = await env.service.startAnalysis(request); expect(result.status).toBe("failed"); expect(tasks).not.toContain("reduce"); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("rejects a provider-ready map that omits an assigned path", async () => {
    const tasks: string[] = []; const env = await setup(20, 50_000, async (_r, _w, _i, _s, _p, _m, task) => { tasks.push(task?.kind ?? "single"); return task?.kind === "map" ? { status: "ready", rawOutput: "", logs: [], mapOutput: { taskId: task.id, observations: [] } } : { status: "ready", rawOutput: "", logs: [], document: reducerDocument() as never }; });
    try { const result = await env.service.startAnalysis(request); expect(result.status).toBe("invalid"); expect(tasks).not.toContain("reduce"); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("cancels every in-flight map and never starts the reducer", async () => {
    let begin!: () => void; const started = new Promise<void>((resolve) => { begin = resolve; }); let runId = ""; const tasks: string[] = [];
    const env = await setup(20, 50_000, async (_r, _w, _i, signal, _p, _m, task) => {
      tasks.push(task?.kind ?? "single"); if (task?.kind !== "map") return { status: "ready", rawOutput: "", logs: [], document: {} as never };
      begin(); if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })); return { status: "cancelled", rawOutput: "", logs: [] };
    }, (event) => { runId = event.runId; });
    try { const pending = env.service.startAnalysis(request); await started; expect(env.service.cancelAnalysis(runId)).toBe(true); const result = await pending; expect(result.status).toBe("cancelled"); expect(tasks).not.toContain("reduce"); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("installs Ready only after a successful final reducer document", async () => {
    let reduceScope = ""; const mapScopes: string[] = []; const isolated: boolean[] = []; const env = await setup(20, 50_000, async (_r, providerRoot, input, _s, _p, _m, task) => { isolated.push(providerRoot === input); if (task?.kind === "map") { mapScopes.push(input); return { status: "ready", rawOutput: "", logs: [], mapOutput: completeMap(task) }; } reduceScope = input; return { status: "ready", rawOutput: "", logs: [], document: reducerDocument() as never }; });
    try { await mkdir(resolve(env.root, "worktrees/github.com/acme/atlas", request.headSha, "src"), { recursive: true }); await writeFile(resolve(env.root, "worktrees/github.com/acme/atlas", request.headSha, "src/f0.ts"), "export {};\n"); expect((await env.service.startAnalysis(request)).status).toBe("ready"); expect(isolated.every(Boolean)).toBe(true); expect(mapScopes.length).toBeGreaterThan(0); for (const scope of mapScopes) expect(await readFile(resolve(scope, "validate-map-output.mjs"), "utf8")).toContain("Map output validation"); expect(JSON.parse(await readFile(resolve(reduceScope, "request.json"), "utf8"))).toMatchObject({ repository: request.repository, baseSha: request.baseSha, headSha: request.headSha }); const reducerPlanText = await readFile(resolve(reduceScope, "plan.json"), "utf8"); const reducerPlan = JSON.parse(reducerPlanText); expect(reducerPlan.coverage.complete).toBe(true); expect(reducerPlan.chunks[0].units[0]).toMatchObject({ path: expect.any(String), segment: 0 }); expect(reducerPlanText).not.toContain('"diff"'); expect(await readFile(resolve(reduceScope, "review-threads.json"), "utf8")).toBeTruthy(); }
    finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("persists and reduces only redacted canonical map outputs", async () => {
    const secret = "service-map-secret-456"; const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = secret; let reduceScope = "";
    const env = await setup(20, 50_000, async (_r, _w, input, _s, _p, _m, task) => { if (task?.kind === "map") { const map = completeMap(task); for (const observation of map.observations) { observation.summary = `${observation.summary} ${secret}`; observation.tests = [secret]; observation.flows = [secret]; observation.limitations = [secret]; } return { status: "ready", rawOutput: secret, logs: [secret], mapOutput: map }; } reduceScope = input; return { status: "ready", rawOutput: "", logs: [], document: reducerDocument() as never }; });
    try { await mkdir(resolve(env.root, "worktrees/github.com/acme/atlas", request.headSha, "src"), { recursive: true }); await writeFile(resolve(env.root, "worktrees/github.com/acme/atlas", request.headSha, "src/f0.ts"), "export {};\n"); const result = await env.service.startAnalysis(request); const mapResults = await readFile(resolve(reduceScope, "map-results.json"), "utf8"); const outputs = (await readdir(resolve(result.artifactDirectory, "batches"))).filter((name) => name.endsWith(".output.json")); const persisted = await Promise.all(outputs.map((name) => readFile(resolve(result.artifactDirectory, "batches", name), "utf8"))); expect(result.status).toBe("ready"); expect(`${mapResults}\n${persisted.join("\n")}`).not.toContain(secret); expect(mapResults).toContain("[REDACTED]"); }
    finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; await rm(env.root, { recursive: true, force: true }); }
  });

  it("treats the shared analysis deadline as failure, distinct from user cancellation", async () => {
    vi.useFakeTimers(); let begin!: () => void; const started = new Promise<void>((resolve) => { begin = resolve; });
    const env = await setup(20, 50_000, async (_r, _w, _i, signal, _p, _m, task) => {
      if (task?.kind === "map") return { status: "ready", rawOutput: "", logs: [], mapOutput: completeMap(task) };
      begin();
      if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", rawOutput: "", logs: [] };
    });
    try { const pending = env.service.startAnalysis({ ...request, config: { depth: "standard", maxGraphNodes: 20, includeReviewComments: true, timeoutMinutes: 1 } }); await started; await vi.advanceTimersByTimeAsync(60_000); expect((await pending).status).toBe("failed"); }
    finally { vi.useRealTimers(); await rm(env.root, { recursive: true, force: true }); }
  });
});
