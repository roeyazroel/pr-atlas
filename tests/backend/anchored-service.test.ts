import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AnalysisService, changedLines, isValidPhysicalLine } from "../../electron/backend/service";
import { validateAnchoredTaskOutput } from "../../electron/backend/anchored-analysis";
import { validateWalkthroughDocument } from "../../shared/schema";
import type { AgentAdapter, AnalysisRequest, ProviderAnalysisTask, SemanticAnchor, SpecialistCoverage } from "../../shared/contracts";

const request: AnalysisRequest = { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40), provider: "codex" };
const caps = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false };
const anchor = { taskId: "anchor", changeGroups: [{ id: "group-1", title: "Change", summary: "Change summary.", motivation: "Reason.", previousBehavior: "Before.", newBehavior: "After.", attention: "medium", evidence: [{ path: "src/f0.ts", line: 1, role: "changed" }] }], domains: ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((id, index) => ({ id, status: index === 0 ? "changed" : "not-evidenced", rationale: "Grounded.", evidence: index === 0 ? [{ path: "src/f0.ts", line: 1, role: "changed" }] : [], changeGroupIds: index === 0 ? ["group-1"] : [] })) } as unknown as SemanticAnchor;
const coverage: SpecialistCoverage[] = ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((domainId) => ({ domainId: domainId as SpecialistCoverage["domainId"], status: domainId === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
const graph = (id: string, changed = true) => ({ id, description: "A graph.", nodes: [{ id: `${id}-node`, label: "Node", explanation: "Explains.", changed, changeGroupIds: changed ? ["group-1"] : [], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidence: changed ? [{ path: "src/f0.ts", line: 1, role: "changed" }] : [] }], edges: changed ? [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "loops", evidence: [{ path: "src/f0.ts", line: 1, role: "changed" }], changeGroupIds: ["group-1"], reviewThreadIds: [] }] : [], guidedTours: [{ id: `${id}-tour`, title: "Tour", steps: [{ nodeId: `${id}-node`, title: "Node", explanation: "Inspect." }] }] });
function output(task: ProviderAnalysisTask) {
  if (task.kind === "anchor") return { status: "ready" as const, rawOutput: "anchor", logs: [], taskOutput: anchor };
  if (task.kind === "walkthrough") return { status: "ready" as const, rawOutput: "walk", logs: [], taskOutput: { taskId: task.id, coverage, content: { summary: { intent: "Explain.", behavioralChanges: ["Changed."], architecturalImpact: ["Impact."], limitations: [] }, walkthrough: [{ id: "step-1", title: "Step", reason: "Review.", summary: "Inspect.", limitations: [], dependsOnStepIds: [], changeGroupId: "group-1", flowNodeIds: ["data-flow-node"], testIds: [], reviewInsightIds: [], evidence: [{ path: "src/f0.ts", line: 1, role: "changed" }] }], reviewThreads: [], reviewInsights: [], limitations: [], dependencies: [], unchangedInteractions: [] } } };
  if (task.kind === "tests-risks") return { status: "ready" as const, rawOutput: "tests", logs: [], taskOutput: { taskId: task.id, coverage, content: { tests: [{ id: "test-1", title: "Test", behavior: "Behavior.", status: "covered", changeGroupIds: ["group-1"], evidence: [{ path: "src/f0.ts", line: 1, role: "changed" }] }], risks: [], limitations: [] } } };
  return { status: "ready" as const, rawOutput: "flows", logs: [], taskOutput: { taskId: task.id, coverage, content: { graphs: { systemOverview: graph("system-overview", false), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") } } } };
}

describe("anchored service orchestration", () => {
  it("maps added lines without advancing over no-newline markers and recognizes +++ source content", () => {
    const lines = changedLines([
      { path: "src/replaced.ts", diff: "diff --git a/src/replaced.ts b/src/replaced.ts\n--- a/src/replaced.ts\n+++ b/src/replaced.ts\n@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file\n" },
      { path: "src/plus.ts", diff: "diff --git a/src/plus.ts b/src/plus.ts\n--- a/src/plus.ts\n+++ b/src/plus.ts\n@@ -0,0 +3 @@\n+first\n+second\n++++source-text\n" },
    ]);
    expect(lines.get("src/replaced.ts")).toEqual(new Set([1]));
    expect(lines.get("src/plus.ts")).toEqual(new Set([3, 4, 5]));
  });

  it("rejects synthetic trailing-newline and empty-file evidence lines while accepting a real final line", () => {
    expect(isValidPhysicalLine("only line\n", 2)).toBe(false);
    expect(isValidPhysicalLine("", 1)).toBe(false);
    expect(isValidPhysicalLine("first\nlast", 2)).toBe(true);
  });

  it("runs one anchor before exactly three concurrent specialists and only readies after host assembly", async () => {
    const root = join(tmpdir(), `pr-atlas-anchor-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(resolve(worktree, "src"), { recursive: true }); await writeFile(resolve(worktree, "src/f0.ts"), "export {};\n");
    const calls: string[] = []; const contexts: Array<Record<string, unknown>> = []; let active = 0; let peak = 0; let firstWalkthrough = true;
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); if (task?.kind !== "anchor") { active += 1; peak = Math.max(peak, active); await new Promise((done) => setTimeout(done, 5)); active -= 1; } if (task?.coordinator) { const coordinator = task.coordinator; contexts.push(await (await fetch(`${coordinator.url}/v1/get_pr_context`, { headers: { authorization: `Bearer ${coordinator.token}` } })).json() as Record<string, unknown>); } if (task?.kind === "walkthrough" && firstWalkthrough) { firstWalkthrough = false; try { await task.coordinator?.submitForHarness?.("bad", { taskId: "walkthrough" } as never); } catch { /* expected rejected first atomic submission */ } return { status: "invalid" as const, rawOutput: "walkthrough-first-output", logs: ["walkthrough-first-log"], errors: ["first submission rejected"], model: "first-attempt-model" }; } const result = output(task!); if (task?.coordinator && result.taskOutput) { const checked = validateAnchoredTaskOutput(result.taskOutput, task); if (!checked.valid) return { ...result, status: "invalid" as const, errors: checked.errors }; try { await task.coordinator.submitForHarness?.("fixture", result.taskOutput); } catch (error) { return { ...result, status: "invalid" as const, errors: [error instanceof Error ? error.message : String(error)] }; } } return { ...result, model: "provider-reported" }; } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? worktree : request.headSha, stderr: "" }; if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" }; if (file === "git") return { stdout: "diff --git a/src/f0.ts b/src/f0.ts\n--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1 +1 @@\n+export {};\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/f0.ts", additions: 1_000, deletions: 0 }]), stderr: "" }; if (String(args.at(-1)) === "repos/acme/atlas/pulls/9") return { stdout: JSON.stringify([{ title: "Context", diff: "not exposed", path: "/host/path" }]), stderr: "" }; if (String(args.at(-1)).includes("graphql")) return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" }; return { stdout: JSON.stringify([{ body: "would be review context" }]), stderr: "" }; }) };
    const noReviewRequest = { ...request, config: { depth: "standard" as const, scanMode: "coordinator" as const, includeReviewComments: false, maxGraphNodes: 80, timeoutMinutes: 20 } };
    try { const result = await new AnalysisService(root, runner as never, () => undefined, undefined, [adapter]).startAnalysis(noReviewRequest); expect(result.status, JSON.stringify(result)).toBe("ready"); expect(validateWalkthroughDocument(result.document).valid, JSON.stringify(validateWalkthroughDocument(result.document).errors)).toBe(true); expect(result.document?.run.model).toBe("provider-reported"); expect(result.manifest.model).toBe("provider-reported"); expect(contexts).toHaveLength(5); expect(contexts[0]).toMatchObject({ pullRequest: [{ title: "Context" }], reviewThreads: [], reviews: [], issueComments: [], reviewComments: [] }); expect(JSON.stringify(contexts[0])).not.toMatch(/not exposed|host\/path|would be review context/); expect(calls).toEqual(["anchor", "walkthrough", "tests-risks", "flows", "walkthrough"]); expect(peak).toBe(3); expect(await readFile(resolve(result.artifactDirectory, "raw-output.txt"), "utf8")).toContain("walkthrough-first-output"); expect(await readFile(resolve(result.artifactDirectory, "logs.jsonl"), "utf8")).toContain("walkthrough-first-log"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it("falls back to legacy map batching for a deletion-only large PR and reports why", async () => {
    const root = join(tmpdir(), `pr-atlas-deletions-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(resolve(worktree, "src"), { recursive: true }); await writeFile(resolve(worktree, "src/f0.ts"), "export {};\n");
    const calls: string[] = [];
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); return { status: "failed", rawOutput: "map-rejected", logs: [], errors: ["fixture map rejection"] }; } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? worktree : request.headSha, stderr: "" }; if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" }; if (file === "git") return { stdout: "diff --git a/src/f0.ts b/src/f0.ts\n--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1,1000 +0,0 @@\n-export {};\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/f0.ts", additions: 0, deletions: 1_000 }]), stderr: "" }; if (String(args.at(-1)) === "repos/acme/atlas/pulls/9") return { stdout: JSON.stringify([{}]), stderr: "" }; if (String(args.at(-1)).includes("graphql")) return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" }; return { stdout: JSON.stringify([{}]), stderr: "" }; }) };
    const noReviewRequest = { ...request, config: { depth: "standard" as const, scanMode: "coordinator" as const, includeReviewComments: false, maxGraphNodes: 80, timeoutMinutes: 20 } };
    try {
      const result = await new AnalysisService(root, runner as never, () => undefined, undefined, [adapter]).startAnalysis(noReviewRequest);
      expect(result.status).toBe("failed");
      expect(calls).toEqual(["map"]);
      expect(result.manifest.activity?.some((event) => event.message.includes("no added exact-head lines; using legacy batching"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("routes Cursor coordinator isolation failure to legacy mapping before specialists start", async () => {
    const root = join(tmpdir(), `pr-atlas-cursor-isolation-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(resolve(worktree, "src"), { recursive: true }); await writeFile(resolve(worktree, "src/f0.ts"), "export {};\n");
    const calls: string[] = []; const events: string[] = [];
    const adapter: AgentAdapter = { id: "cursor", displayName: "Cursor", detect: async () => ({ provider: "cursor", displayName: "Cursor", executable: "cursor-agent", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); return task?.kind === "anchor" ? { status: "failed", rawOutput: "", logs: [], errors: ["Cursor coordinator instruction isolation was unavailable."] } : { status: "failed", rawOutput: "", logs: [], errors: ["legacy map"] }; } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? worktree : request.headSha, stderr: "" }; if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" }; if (file === "git") return { stdout: "diff --git a/src/f0.ts b/src/f0.ts\n--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1 +1000 @@\n+export {};\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/f0.ts", additions: 1000, deletions: 0 }]), stderr: "" }; if (String(args.at(-1)).includes("graphql")) return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" }; return { stdout: "[]", stderr: "" }; }) };
    try { const states: string[] = []; const result = await new AnalysisService(root, runner as never, (event) => { events.push(event.message); states.push(`${event.stage}:${event.taskState ?? ""}`); }, undefined, [adapter]).startAnalysis({ ...request, provider: "cursor", config: { depth: "standard", scanMode: "coordinator", includeReviewComments: false, maxGraphNodes: 80, timeoutMinutes: 20 } }); expect(result.status).toBe("failed"); expect(calls).toEqual(["anchor", "map"]); expect(states).toContain("anchoring:running"); expect(states.indexOf("anchoring:failed")).toBeGreaterThan(states.indexOf("anchoring:running")); expect(states.indexOf("generating:")).toBeGreaterThan(states.indexOf("anchoring:failed")); expect(events).toContain("Cursor coordinator instruction isolation was unavailable; using legacy analysis."); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it("falls back to legacy map batching when a mixed large PR contains a fully deleted file", async () => {
    const root = join(tmpdir(), `pr-atlas-mixed-deletions-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(resolve(worktree, "src"), { recursive: true }); await writeFile(resolve(worktree, "src/added.ts"), "export const added = true;\n"); await writeFile(resolve(worktree, "src/deleted.ts"), "export const survivor = true;\n");
    const calls: string[] = [];
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); return { status: "failed", rawOutput: "map-rejected", logs: [], errors: ["fixture map rejection"] }; } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? worktree : request.headSha, stderr: "" }; if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" }; if (file === "git") return { stdout: "diff --git a/src/added.ts b/src/added.ts\n--- a/src/added.ts\n+++ b/src/added.ts\n@@ -0,0 +1 @@\n+export const added = true;\ndiff --git a/src/deleted.ts b/src/deleted.ts\n--- a/src/deleted.ts\n+++ /dev/null\n@@ -1,1000 +0,0 @@\n-export const removed = true;\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/added.ts", additions: 1_000, deletions: 0 }, { filename: "src/deleted.ts", additions: 0, deletions: 1_000 }]), stderr: "" }; if (String(args.at(-1)) === "repos/acme/atlas/pulls/9") return { stdout: JSON.stringify([{}]), stderr: "" }; if (String(args.at(-1)).includes("graphql")) return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" }; return { stdout: JSON.stringify([{}]), stderr: "" }; }) };
    const noReviewRequest = { ...request, config: { depth: "standard" as const, scanMode: "coordinator" as const, includeReviewComments: false, maxGraphNodes: 80, timeoutMinutes: 20 } };
    try {
      const result = await new AnalysisService(root, runner as never, () => undefined, undefined, [adapter]).startAnalysis(noReviewRequest);
      expect(result.status).toBe("failed");
      expect(calls).toEqual(["map"]);
      expect(result.manifest.activity?.some((event) => event.message.includes("at least one changed file with no added exact-head lines"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("falls back to legacy batching before coordinator tasks for a changed symlink target", async () => {
    const root = join(tmpdir(), `pr-atlas-symlink-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha); const external = resolve(root, "external");
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(external, { recursive: true }); await writeFile(resolve(external, "f0.ts"), "external content\n"); await mkdir(worktree, { recursive: true }); await symlink(external, resolve(worktree, "src"));
    const calls: string[] = [];
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); return { status: "failed", rawOutput: "map-rejected", logs: [], errors: ["fixture map rejection"] }; } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git" && args[0] === "rev-parse") return { stdout: args[1] === "--show-toplevel" ? worktree : request.headSha, stderr: "" }; if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" }; if (file === "git") return { stdout: "diff --git a/src/f0.ts b/src/f0.ts\n--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1 +1 @@\n+external content\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/f0.ts", additions: 1_000, deletions: 0 }]), stderr: "" }; if (String(args.at(-1)) === "repos/acme/atlas/pulls/9") return { stdout: JSON.stringify([{}]), stderr: "" }; return { stdout: JSON.stringify([{}]), stderr: "" }; }) };
    const noReviewRequest = { ...request, config: { depth: "standard" as const, scanMode: "coordinator" as const, includeReviewComments: false, maxGraphNodes: 80, timeoutMinutes: 20 } };
    try {
      const result = await new AnalysisService(root, runner as never, () => undefined, undefined, [adapter]).startAnalysis(noReviewRequest);
      expect(result.status).toBe("failed");
      expect(calls).toEqual(["map"]);
      expect(result.manifest.activity?.some((event) => event.message.includes("not a canonical regular exact-head file"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
