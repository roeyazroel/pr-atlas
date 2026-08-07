import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AnalysisService } from "../../electron/backend/service";
import type { AgentAdapter, AnalysisRequest, ProviderAnalysisTask, SemanticAnchor, SpecialistCoverage } from "../../shared/contracts";

const request: AnalysisRequest = { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40), provider: "codex" };
const caps = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false };
const anchor = { taskId: "anchor", changeGroups: [{ id: "group-1", title: "Change", summary: "Change summary.", motivation: "Reason.", previousBehavior: "Before.", newBehavior: "After.", attention: "medium", evidence: [{ path: "src/f0.ts", line: 1 }] }], domains: ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((id, index) => ({ id, status: index === 0 ? "changed" : "not-evidenced", rationale: "Grounded.", evidence: index === 0 ? [{ path: "src/f0.ts", line: 1 }] : [], changeGroupIds: index === 0 ? ["group-1"] : [] })) } as unknown as SemanticAnchor;
const coverage: SpecialistCoverage[] = [{ domainId: "production-path", status: "covered", rationale: "Covered." }];
const graph = (id: string, changed = true) => ({ id, description: "A graph.", nodes: [{ id: `${id}-node`, label: "Node", explanation: "Explains.", changed, changeGroupIds: changed ? ["group-1"] : [], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidence: changed ? [{ path: "src/f0.ts", line: 1 }] : [] }], edges: changed ? [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "loops", evidence: [{ path: "src/f0.ts", line: 1 }], changeGroupIds: ["group-1"], reviewThreadIds: [] }] : [], guidedTours: [{ id: `${id}-tour`, title: "Tour", steps: [{ nodeId: `${id}-node`, title: "Node", explanation: "Inspect." }] }] });
function output(task: ProviderAnalysisTask) {
  if (task.kind === "anchor") return { status: "ready" as const, rawOutput: "anchor", logs: [], taskOutput: anchor };
  if (task.kind === "walkthrough") return { status: "ready" as const, rawOutput: "walk", logs: [], taskOutput: { taskId: task.id, coverage, content: { summary: { intent: "Explain.", behavioralChanges: ["Changed."], architecturalImpact: ["Impact."], limitations: [] }, walkthrough: [{ id: "step-1", title: "Step", reason: "Review.", summary: "Inspect.", limitations: [], dependsOnStepIds: [], changeGroupId: "group-1", flowNodeIds: ["data-flow-node"], testIds: [], reviewInsightIds: [], evidence: [{ path: "src/f0.ts", line: 1 }] }], reviewThreads: [], reviewInsights: [], limitations: [], dependencies: [], unchangedInteractions: [] } } };
  if (task.kind === "tests-risks") return { status: "ready" as const, rawOutput: "tests", logs: [], taskOutput: { taskId: task.id, coverage, content: { tests: [{ id: "test-1", title: "Test", behavior: "Behavior.", status: "covered", changeGroupIds: ["group-1"], evidence: [{ path: "src/f0.ts", line: 1 }] }], risks: [], limitations: [] } } };
  return { status: "ready" as const, rawOutput: "flows", logs: [], taskOutput: { taskId: task.id, coverage, content: { graphs: { systemOverview: graph("system-overview", false), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") } } } };
}

describe("anchored service orchestration", () => {
  it("runs one anchor before exactly three concurrent specialists and only readies after host assembly", async () => {
    const root = join(tmpdir(), `pr-atlas-anchor-${crypto.randomUUID()}`); const worktree = resolve(root, "worktrees/github.com/acme/atlas", request.headSha);
    await mkdir(resolve(root, "repositories/github.com/acme/atlas/.git"), { recursive: true }); await mkdir(resolve(worktree, "src"), { recursive: true }); await writeFile(resolve(worktree, "src/f0.ts"), "export {};\n");
    const calls: string[] = []; let active = 0; let peak = 0;
    const adapter: AgentAdapter = { id: "codex", displayName: "Test", detect: async () => ({ provider: "codex", displayName: "Test", executable: "test", installed: true, capabilities: caps }), getCapabilities: () => caps, analyze: async (_r, _w, _i, _s, _p, _m, task) => { calls.push(task?.kind ?? "single"); if (task?.kind !== "anchor") { active += 1; peak = Math.max(peak, active); await new Promise((done) => setTimeout(done, 5)); active -= 1; } return output(task!); } };
    const runner = { run: vi.fn(async (file: string, args: string[]) => { if (file === "git") return { stdout: "diff --git a/src/f0.ts b/src/f0.ts\n--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1 +1 @@\n+export {};\n", stderr: "" }; if (String(args.at(-1)).includes("/files")) return { stdout: JSON.stringify([{ filename: "src/f0.ts", additions: 1_000, deletions: 0 }]), stderr: "" }; if (String(args.at(-1)).includes("graphql")) return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: "" }; return { stdout: "[]", stderr: "" }; }) };
    try { const result = await new AnalysisService(root, runner as never, () => undefined, undefined, [adapter]).startAnalysis(request); expect(result.status).toBe("ready"); expect(calls).toEqual(["anchor", "walkthrough", "tests-risks", "flows"]); expect(peak).toBe(3); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
