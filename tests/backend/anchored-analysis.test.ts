import { describe, expect, it } from "vitest";
import { anchoredSchemaForProvider, shouldUseAnchoredAnalysis, validateAnchoredTaskOutput } from "../../electron/backend/anchored-analysis";
import { buildAnalysisPrompt, schemaForProvider } from "../../electron/backend/agent";
import type { AnalysisRequest, ProviderAnalysisTask } from "../../shared/contracts";

const request: AnalysisRequest = { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40), provider: "codex" };
const anchor = {
  taskId: "anchor", changeGroups: [{ id: "group-1", title: "Change", summary: "A change.", motivation: "Reason.", previousBehavior: "Before.", newBehavior: "After.", attention: "medium", evidence: [{ path: "src/a.ts", line: 1 }] }],
  domains: ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((id, index) => ({ id, status: index === 0 ? "changed" : "not-evidenced", rationale: "Grounded classification.", evidence: index === 0 ? [{ path: "src/a.ts", line: 1 }] : [], changeGroupIds: index === 0 ? ["group-1"] : [] })),
} as const;

describe("anchored large-PR selection", () => {
  it("uses the deterministic threshold without changing small-PR selection", () => {
    expect(shouldUseAnchoredAnalysis({ files: 19, changes: 999 })).toBe(false);
    expect(shouldUseAnchoredAnalysis({ files: 20, changes: 1 })).toBe(true);
    expect(shouldUseAnchoredAnalysis({ files: 1, changes: 1_000 })).toBe(true);
  });
});

describe("anchored provider contracts", () => {
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
      expect(schemaForProvider(task)).toEqual(schema);
      const prompt = buildAnalysisPrompt(request, "/input", task);
      expect(prompt).toContain(`You are the ${kind} task`);
      expect(prompt).toMatch(/untrusted data/i);
      expect(prompt).toMatch(/Never return a complete walkthrough/i);
    }
  });
});
