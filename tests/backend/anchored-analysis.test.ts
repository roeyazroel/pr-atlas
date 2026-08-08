import { describe, expect, it } from "vitest";
import { assembleAnchoredDocument, anchoredSchemaForProvider, shouldUseAnchoredAnalysis, validateAnchoredTaskOutput } from "../../electron/backend/anchored-analysis";
import { buildAnalysisPrompt, schemaForProvider } from "../../electron/backend/agent";
import type { AnalysisRequest, ProviderAnalysisTask } from "../../shared/contracts";
import { validateWalkthroughDocument } from "../../shared/schema";

const request: AnalysisRequest = { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40), provider: "codex" };
const anchor = {
  taskId: "anchor", changeGroups: [{ id: "group-1", title: "Change", summary: "A change.", motivation: "Reason.", previousBehavior: "Before.", newBehavior: "After.", attention: "medium", evidence: [{ path: "src/a.ts", line: 1, role: "changed" }] }],
  domains: ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((id, index) => ({ id, status: index === 0 ? "changed" : "not-evidenced", rationale: "Grounded classification.", evidence: index === 0 ? [{ path: "src/a.ts", line: 1, role: "changed" }] : [], changeGroupIds: index === 0 ? ["group-1"] : [] })),
} as const;

describe("anchored large-PR selection", () => {
  it("uses the deterministic threshold without changing small-PR selection", () => {
    expect(shouldUseAnchoredAnalysis({ files: 19, changes: 999 })).toBe(false);
    expect(shouldUseAnchoredAnalysis({ files: 20, changes: 1 })).toBe(true);
    expect(shouldUseAnchoredAnalysis({ files: 1, changes: 1_000 })).toBe(true);
  });
});

describe("anchored provider contracts", () => {
  it("assembles distinct valid evidence ids for distinct lines on a long path", () => {
    const path = `src/${"a".repeat(80)}.ts`;
    const changed = { path, line: 1, role: "changed" } as const;
    const context = { path, line: 2, role: "unchanged-context" } as const;
    const longAnchor = { ...anchor, changeGroups: [{ ...anchor.changeGroups[0], evidence: [changed] }], domains: anchor.domains.map((domain) => domain.id === "production-path" ? { ...domain, evidence: [changed] } : domain) };
    const coverage = longAnchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const graph = (id: string, system = false) => ({ id, description: "Relationship graph.", nodes: [{ id: `${id}-node`, label: "Node", explanation: "Grounded node.", changed: !system, changeGroupIds: system ? [] : ["group-1"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidence: system ? [] : [changed] }], edges: system ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "loops", evidence: [changed], changeGroupIds: ["group-1"], reviewThreadIds: [] }], guidedTours: [{ id: `${id}-tour`, title: "Tour", steps: [{ nodeId: `${id}-node`, title: "Inspect", explanation: "Inspect this node." }] }] });
    const specialists = {
      walkthrough: { taskId: "walkthrough", coverage, content: { summary: { intent: "Explain.", behavioralChanges: ["Changed."], architecturalImpact: ["Impact."], limitations: [] }, walkthrough: [{ id: "step-1", title: "Step", reason: "Review.", summary: "Inspect.", limitations: [], dependsOnStepIds: [], changeGroupId: "group-1", flowNodeIds: ["data-flow-node"], testIds: [], reviewInsightIds: [], evidence: [changed] }], reviewThreads: [], reviewInsights: [], limitations: [], dependencies: [], unchangedInteractions: [], evidenceRefs: [context] } },
      "tests-risks": { taskId: "tests-risks", coverage, content: { tests: [{ id: "test-1", title: "Test", behavior: "Checks.", status: "covered", changeGroupIds: ["group-1"], evidence: [changed] }], risks: [], limitations: [], evidenceRefs: [context] } },
      flows: { taskId: "flows", coverage, content: { graphs: { systemOverview: graph("system-overview", true), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") }, evidenceRefs: [context] } },
    } as never;
    for (const kind of ["walkthrough", "tests-risks", "flows"] as const) {
      expect(validateAnchoredTaskOutput(specialists[kind], { kind, id: kind, total: 3, anchor: longAnchor } as unknown as ProviderAnalysisTask).valid).toBe(true);
    }
    const assembled = assembleAnchoredDocument(request, longAnchor as never, specialists);
    expect(assembled.valid, JSON.stringify(assembled.errors)).toBe(true);
    expect(assembled.document?.evidence).toHaveLength(2);
    expect(new Set(assembled.document?.evidence.map((item) => item.id)).size).toBe(2);
    const validation = validateWalkthroughDocument(assembled.document);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
  });

  it("requires all mandatory anchor domains and rejects unknown specialist ledger ids", () => {
    const task = { kind: "anchor", id: "anchor", total: 1 } as const;
    expect(validateAnchoredTaskOutput(anchor, task).valid).toBe(true);
    expect(validateAnchoredTaskOutput({ ...anchor, domains: anchor.domains.slice(1) }, task).valid).toBe(false);
    const specialist = { kind: "walkthrough", id: "walkthrough", total: 3, anchor } as unknown as ProviderAnalysisTask;
    expect(validateAnchoredTaskOutput({ taskId: "walkthrough", coverage: [{ domainId: "unknown", status: "covered", rationale: "No." }], content: {} }, specialist).valid).toBe(false);
  });

  it("uses a distinct strict schema and prompt for anchor plus all three specialists", () => {
    for (const kind of ["anchor", "walkthrough", "tests-risks", "flows"] as const) {
      const task = { kind, id: kind, total: kind === "anchor" ? 1 : 3, ...(kind === "anchor" ? {} : { anchor }) } as ProviderAnalysisTask;
      const schema = anchoredSchemaForProvider(task);
      expect(schema.additionalProperties).toBe(false);
      const assertStrict = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(assertStrict);
        if (!value || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        if (node.type === "object") {
          expect(node.additionalProperties).toBe(false);
          expect(node.properties).toBeDefined();
        }
        Object.values(node).forEach(assertStrict);
      };
      assertStrict(schema);
      expect(schemaForProvider(task)).toEqual(schema);
      const prompt = buildAnalysisPrompt(request, "/input", task);
      expect(prompt).toContain(`You are the ${kind} task`);
      expect(prompt).toMatch(/untrusted data/i);
      expect(prompt).toMatch(/Never return a complete walkthrough/i);
    }
  });

  it("keeps optional evidenceRefs consistent between the advertised schema and server validator", () => {
    const task = { kind: "tests-risks", id: "tests-risks", total: 3, anchor } as unknown as ProviderAnalysisTask;
    const coverage = anchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const candidate = { taskId: task.id, coverage, content: { tests: [{ id: "test", title: "Test", behavior: "Checks.", status: "covered", changeGroupIds: ["group-1"], evidence: [{ path: "src/a.ts", line: 1, role: "changed" }] }], risks: [], limitations: [], evidenceRefs: [{ path: "src/a.ts", line: 1, role: "changed" }] } };
    expect(validateAnchoredTaskOutput(candidate, task).valid).toBe(true);
  });

  it("rejects walkthrough or test outputs that omit an immutable anchor group", () => {
    const expanded = { ...anchor, changeGroups: [...anchor.changeGroups, { ...anchor.changeGroups[0], id: "group-2" }] };
    const task = { kind: "tests-risks", id: "tests-risks", total: 3, anchor: expanded } as unknown as ProviderAnalysisTask;
    const coverage = expanded.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    expect(validateAnchoredTaskOutput({ taskId: task.id, coverage, content: { tests: [{ changeGroupIds: ["group-1"] }], risks: [], limitations: [] } }, task).valid).toBe(false);
  });

  it("requires evidence roles and derives anchor coverage only from walkthrough steps and tests", () => {
    const task = { kind: "tests-risks", id: "tests-risks", total: 3, anchor } as unknown as ProviderAnalysisTask;
    const coverage = anchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const candidate = {
      taskId: task.id,
      coverage,
      content: {
        tests: [{ id: "test", title: "Test", behavior: "Checks it.", status: "covered", changeGroupIds: ["group-1"], evidence: [{ path: "src/a.ts", line: 1, role: "changed" }] }],
        risks: [{ id: "risk", title: "Risk", detail: "A risk.", changeGroupIds: ["group-2"], evidence: [{ path: "src/a.ts", line: 1, role: "changed" }] }],
        limitations: [],
      },
    };
    const expanded = { ...anchor, changeGroups: [...anchor.changeGroups, { ...anchor.changeGroups[0], id: "group-2" }] };
    const expandedTask = { ...task, anchor: expanded } as unknown as ProviderAnalysisTask;
    expect(validateAnchoredTaskOutput(candidate, expandedTask).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...candidate, content: { ...candidate.content, tests: [{ ...candidate.content.tests[0], evidence: [{ path: "src/a.ts", line: 1 }] }] } }, expandedTask).valid).toBe(false);
  });

  it("accepts rich grounded risks, dependencies, and unchanged interactions but rejects unknown fields", () => {
    const coverage = anchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const ref = { path: "src/a.ts", line: 1, role: "changed" } as const;
    const riskTask = { kind: "tests-risks", id: "tests-risks", total: 3, anchor } as unknown as ProviderAnalysisTask;
    const risks = [{ id: "risk-1", title: "Migration risk", detail: "Old callers can retain stale state.", changeGroupIds: ["group-1"], evidence: [ref] }];
    const riskOutput = { taskId: riskTask.id, coverage, content: { tests: [{ id: "test-1", title: "Migration test", behavior: "Covers the new path.", status: "covered", changeGroupIds: ["group-1"], evidence: [ref] }], risks, limitations: [] } };
    expect(validateAnchoredTaskOutput(riskOutput, riskTask).valid).toBe(true);
    expect(validateAnchoredTaskOutput({ ...riskOutput, content: { ...riskOutput.content, risks: [{ ...risks[0], unexpected: true }] } }, riskTask).valid).toBe(false);

    const walkthroughTask = { kind: "walkthrough", id: "walkthrough", total: 3, anchor } as unknown as ProviderAnalysisTask;
    const dependency = { id: "dependency-1", title: "Caller ordering", detail: "Callers must initialize after the migration.", dependsOnIds: ["step-1"], changeGroupIds: ["group-1"], evidence: [ref] };
    const unchanged = { id: "unchanged-1", title: "Stable read path", detail: "Reads continue using the existing cache boundary.", changeGroupIds: ["group-1"], evidence: [ref] };
    const walkthroughOutput = { taskId: walkthroughTask.id, coverage, content: { summary: { intent: "Explain the migration.", behavioralChanges: ["New path."], architecturalImpact: ["Caller order."], limitations: [] }, walkthrough: [{ id: "step-1", title: "Inspect migration", reason: "It changes behavior.", summary: "Follow the new call path.", limitations: [], dependsOnStepIds: [], changeGroupId: "group-1", flowNodeIds: ["data-flow-node"], testIds: [], reviewInsightIds: [], evidence: [ref] }], reviewThreads: [], reviewInsights: [], limitations: [], dependencies: [dependency], unchangedInteractions: [unchanged] } };
    expect(validateAnchoredTaskOutput(walkthroughOutput, walkthroughTask).valid).toBe(true);
    expect(validateAnchoredTaskOutput({ ...walkthroughOutput, content: { ...walkthroughOutput.content, dependencies: [{ ...dependency, extra: "no" }] } }, walkthroughTask).valid).toBe(false);
  });

  it("grounds domain statuses and change groups in their declared evidence roles", () => {
    const task = { kind: "anchor", id: "anchor", total: 1 } as const;
    expect(validateAnchoredTaskOutput({ ...anchor, changeGroups: [{ ...anchor.changeGroups[0], evidence: [{ path: "src/a.ts", line: 1, role: "unchanged-context" }] }] }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...anchor, domains: anchor.domains.map((domain) => domain.id === "production-path" ? { ...domain, status: "unchanged-relevant", evidence: [{ path: "src/a.ts", line: 1, role: "changed" }], changeGroupIds: [] } : domain) }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...anchor, domains: anchor.domains.map((domain) => domain.id === "experimental-pocs" ? { ...domain, evidence: [{ path: "src/a.ts", line: 1, role: "unchanged-context" }] } : domain) }, task).valid).toBe(false);
  });

  it("rejects non-final system-overview associations before assembly", () => {
    const coverage = anchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const changed = { path: "src/a.ts", line: 1, role: "changed" } as const;
    const context = { path: "src/a.ts", line: 2, role: "unchanged-context" } as const;
    const graph = (id: string, system = false) => ({ id, description: "Relationship graph.", nodes: [{ id: `${id}-node`, label: "Node", explanation: "Grounded node.", changed: !system, changeGroupIds: system ? [] : ["group-1"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidence: system ? [] : [changed] }], edges: system ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "Loops", evidence: [changed], changeGroupIds: ["group-1"], reviewThreadIds: [] }], guidedTours: [{ id: `${id}-tour`, title: "Tour", steps: [{ nodeId: `${id}-node`, title: "Inspect", explanation: "Inspect this node." }] }] });
    const task = { kind: "flows", id: "flows", total: 3, anchor } as unknown as ProviderAnalysisTask;
    const output = { taskId: task.id, coverage, content: { graphs: { systemOverview: graph("system-overview", true), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") } } };
    expect(validateAnchoredTaskOutput(output, task).valid).toBe(true);
    expect(validateAnchoredTaskOutput({ ...output, content: { graphs: { ...output.content.graphs, systemOverview: { ...output.content.graphs.systemOverview, nodes: [{ ...output.content.graphs.systemOverview.nodes[0], evidence: [context] }] } } } }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...output, content: { graphs: { ...output.content.graphs, systemOverview: { ...output.content.graphs.systemOverview, nodes: [{ ...output.content.graphs.systemOverview.nodes[0], testIds: ["test-1"] }] } } } }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...output, content: { graphs: { ...output.content.graphs, systemOverview: { ...output.content.graphs.systemOverview, edges: [{ id: "system-edge", source: "system-overview-node", target: "system-overview-node", label: "Invalid", evidence: [], changeGroupIds: [], reviewThreadIds: [] }] } } } }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...output, content: { graphs: { ...output.content.graphs, systemOverview: { ...output.content.graphs.systemOverview, nodes: [{ ...output.content.graphs.systemOverview.nodes[0], changed: true, changeGroupIds: ["group-1"], evidence: [changed] }] } } } }, task).valid).toBe(false);
    expect(validateAnchoredTaskOutput({ ...output, content: { graphs: { ...output.content.graphs, dataFlow: { ...output.content.graphs.dataFlow, nodes: [{ ...output.content.graphs.dataFlow.nodes[0], changed: false, changeGroupIds: [], evidence: [changed] }] } } } }, task).valid).toBe(false);
  });
});
