/** Deterministic host-side orchestration contracts for large PR analysis. */
import type {
  AgentAnalysisResult, AnalysisRequest, AnchoredSpecialistOutput, AnchoredTaskOutput,
  AnchorDomainId, ProviderAnalysisTask, ProviderEvidenceReference, SemanticAnchor,
  WalkthroughDocument,
} from "../../shared/contracts.js";

export const LARGE_ANALYSIS_THRESHOLDS = { files: 20, changes: 1_000 } as const;
export const ANCHOR_DOMAIN_IDS = [
  "production-path", "experimental-pocs", "migration-rollback", "updater-installer",
  "runtime-packaging", "reviewer-workflow",
] as const satisfies readonly AnchorDomainId[];

export function shouldUseAnchoredAnalysis(input: { files: number; changes: number }): boolean {
  return input.files >= LARGE_ANALYSIS_THRESHOLDS.files || input.changes >= LARGE_ANALYSIS_THRESHOLDS.changes;
}

export function parseGitDiffSections(diff: string): Map<string, string> {
  const starts = [...diff.matchAll(/^diff --git (.+)$/gm)].map((match) => match.index ?? 0);
  const result = new Map<string, string>();
  for (let index = 0; index < starts.length; index += 1) {
    const section = diff.slice(starts[index], starts[index + 1]);
    const value = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^--- a\/(.+)$/m)?.[1];
    if (!value || value.split(/[\\/]/).includes("..")) throw new Error("Diff section has no safe file path or evidence.");
    result.set(value, section);
  }
  return result;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const evidence = (value: unknown): value is ProviderEvidenceReference => isRecord(value) && text(value.path) && (value.line === null || (Number.isInteger(value.line) && (value.line as number) > 0));
const unique = (values: string[]) => new Set(values).size === values.length;

function validateAnchor(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: SemanticAnchor; errors: string[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["taskId", "domains", "changeGroups"].includes(key))) return { valid: false, errors: ["Anchor output must be a closed object."] };
  if (value.taskId !== task.id || !Array.isArray(value.domains) || !Array.isArray(value.changeGroups)) return { valid: false, errors: ["Anchor output has an invalid task id or collections."] };
  const domains = value.domains;
  if (domains.length !== ANCHOR_DOMAIN_IDS.length || !domains.every(isRecord)) return { valid: false, errors: ["Anchor must classify every mandatory domain exactly once."] };
  const ids = domains.map((domain) => domain.id);
  if (!unique(ids.filter((id): id is string => typeof id === "string")) || ANCHOR_DOMAIN_IDS.some((id) => !ids.includes(id))) return { valid: false, errors: ["Anchor domain ids are incomplete or duplicated."] };
  const groups = value.changeGroups;
  const groupIds = groups.map((group) => isRecord(group) ? group.id : undefined);
  if (!groupIds.every(text) || !unique(groupIds as string[])) return { valid: false, errors: ["Anchor change-group ids must be unique."] };
  for (const domain of domains) {
    if (!(["changed", "unchanged-relevant", "not-evidenced"] as const).includes(domain.status as never) || !text(domain.rationale) || !Array.isArray(domain.evidence) || !domain.evidence.every(evidence) || !Array.isArray(domain.changeGroupIds) || !domain.changeGroupIds.every((id) => typeof id === "string" && groupIds.includes(id))) return { valid: false, errors: ["Anchor has an invalid domain classification or reference."] };
    if (domain.status === "changed" && domain.changeGroupIds.length === 0) return { valid: false, errors: ["Every changed anchor domain needs a change group."] };
  }
  for (const group of groups) {
    if (!isRecord(group) || !["id", "title", "summary", "motivation", "previousBehavior", "newBehavior", "attention", "evidence"].every((key) => key in group) || !["id", "title", "summary", "motivation", "previousBehavior", "newBehavior"].every((key) => text(group[key])) || !["low", "medium", "high"].includes(group.attention as string) || !Array.isArray(group.evidence) || group.evidence.length === 0 || !group.evidence.every(evidence)) return { valid: false, errors: ["Changed anchor groups require behavior before/after and grounded evidence."] };
  }
  return { valid: true, output: value as unknown as SemanticAnchor, errors: [] };
}

function validateSpecialist(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: AnchoredSpecialistOutput; errors: string[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["taskId", "coverage", "content"].includes(key)) || value.taskId !== task.id || !Array.isArray(value.coverage) || !isRecord(value.content)) return { valid: false, errors: ["Specialist output must be a closed task-specific object."] };
  const anchor = task.anchor;
  if (!anchor) return { valid: false, errors: ["Specialist task is missing the accepted anchor."] };
  const ids = value.coverage.map((entry) => isRecord(entry) ? entry.domainId : undefined);
  if (!ids.every((id) => ANCHOR_DOMAIN_IDS.includes(id as AnchorDomainId)) || !unique(ids as string[])) return { valid: false, errors: ["Specialist coverage ledger has unknown or duplicate domains."] };
  for (const item of value.coverage) if (!isRecord(item) || !["covered", "not-applicable"].includes(item.status as string) || !text(item.rationale)) return { valid: false, errors: ["Specialist coverage ledger is invalid."] };
  return { valid: true, output: value as unknown as AnchoredSpecialistOutput, errors: [] };
}

export function validateAnchoredTaskOutput(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: AnchoredTaskOutput; errors: string[] } {
  return task.kind === "anchor" ? validateAnchor(value, task) : validateSpecialist(value, task);
}

export function anchoredSchemaForProvider(task: ProviderAnalysisTask): Record<string, unknown> {
  const evidenceRef = { type: "object", additionalProperties: false, required: ["path", "line"], properties: { path: { type: "string", minLength: 1 }, line: { type: ["integer", "null"], minimum: 1 } } };
  if (task.kind === "anchor") return { type: "object", additionalProperties: false, required: ["taskId", "domains", "changeGroups"], properties: { taskId: { const: task.id }, domains: { type: "array", minItems: 6, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["id", "status", "rationale", "evidence", "changeGroupIds"], properties: { id: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["changed", "unchanged-relevant", "not-evidenced"] }, rationale: { type: "string", minLength: 1 }, evidence: { type: "array", items: evidenceRef }, changeGroupIds: { type: "array", items: { type: "string" } } } } }, changeGroups: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "summary", "motivation", "previousBehavior", "newBehavior", "attention", "evidence"], properties: { id: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, motivation: { type: "string" }, previousBehavior: { type: "string" }, newBehavior: { type: "string" }, attention: { enum: ["low", "medium", "high"] }, evidence: { type: "array", minItems: 1, items: evidenceRef } } } } } };
  return { type: "object", additionalProperties: false, required: ["taskId", "coverage", "content"], properties: { taskId: { const: task.id }, coverage: { type: "array", items: { type: "object", additionalProperties: false, required: ["domainId", "status", "rationale"], properties: { domainId: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["covered", "not-applicable"] }, rationale: { type: "string", minLength: 1 } } } }, content: { type: "object" } } };
}

function evidenceId(reference: ProviderEvidenceReference): string { return `evidence-${Buffer.from(`${reference.path}:${reference.line ?? ""}`).toString("base64url").slice(0, 48)}`; }
function collectRefs(value: unknown, found: ProviderEvidenceReference[] = []): ProviderEvidenceReference[] {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, found));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
    if ((key === "evidence" || key === "evidenceRefs") && Array.isArray(item)) item.filter(evidence).forEach((entry) => found.push(entry));
    else collectRefs(item, found);
  }
  return found;
}
function canonicalizeEvidence(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeEvidence(item, ids));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "evidence" || key === "evidenceRefs") && Array.isArray(item)) next.evidenceIds = item.filter(evidence).map((ref) => ids.get(`${ref.path}:${ref.line ?? ""}`)!);
    else next[key] = canonicalizeEvidence(item, ids);
  }
  return next;
}
function connected(graph: Record<string, unknown>): boolean {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  if (nodes.length <= 1) return nodes.length === 1;
  const nodeIds = nodes.map((node) => node.id).filter(text); const seen = new Set([nodeIds[0]]); const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  for (let changed = true; changed;) { changed = false; for (const edge of edges) if (typeof edge.source === "string" && typeof edge.target === "string" && (seen.has(edge.source) || seen.has(edge.target))) { const before = seen.size; seen.add(edge.source); seen.add(edge.target); changed ||= seen.size !== before; } }
  return seen.size === nodeIds.length;
}
function validGraph(graph: Record<string, unknown>, expectedId: string, maxNodes: number): boolean {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const nodeIds = nodes.map((node) => node.id).filter(text);
  if (graph.id !== expectedId || nodeIds.length !== nodes.length || !unique(nodeIds) || nodes.length === 0 || nodes.length > maxNodes) return false;
  const known = new Set(nodeIds);
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  const tours = Array.isArray(graph.guidedTours) ? graph.guidedTours.filter(isRecord) : [];
  if (expectedId === "system-overview" ? edges.length !== 0 : edges.length === 0) return false;
  return edges.every((edge) => text(edge.id) && typeof edge.source === "string" && typeof edge.target === "string" && known.has(edge.source) && known.has(edge.target))
    && tours.every((tour) => Array.isArray(tour.steps) && tour.steps.length > 0 && tour.steps.every((step) => isRecord(step) && typeof step.nodeId === "string" && known.has(step.nodeId)));
}

/** Assemble only declared specialist fields; joins are made solely by shared canonical evidence. */
export function assembleAnchoredDocument(request: AnalysisRequest, anchor: SemanticAnchor, specialists: Record<Exclude<ProviderAnalysisTask["kind"], "anchor">, AnchoredSpecialistOutput>): { valid: boolean; document?: WalkthroughDocument; errors: string[] } {
  const relevant = anchor.domains.filter((domain) => domain.status !== "not-evidenced").map((domain) => domain.id);
  const coverage = new Map<AnchorDomainId, number>();
  for (const specialist of Object.values(specialists)) for (const entry of specialist.coverage) if (entry.status === "covered") coverage.set(entry.domainId, (coverage.get(entry.domainId) ?? 0) + 1);
  if (relevant.some((id) => !coverage.has(id))) return { valid: false, errors: ["At least one specialist must cover every relevant anchor domain."] };
  const refs = [...collectRefs(anchor), ...Object.values(specialists).flatMap((item) => collectRefs(item.content))];
  const ids = new Map<string, string>(); for (const ref of refs) ids.set(`${ref.path}:${ref.line ?? ""}`, evidenceId(ref));
  const evidenceItems = [...ids.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, id]) => { const [path, line] = key.split(":"); return { id, kind: "file", title: `${path}${line ? `:${line}` : ""}`, path, line: line ? Number(line) : null, url: null }; });
  const walk = canonicalizeEvidence(specialists.walkthrough.content, ids) as Record<string, unknown>;
  const tests = canonicalizeEvidence(specialists["tests-risks"].content, ids) as Record<string, unknown>;
  const flows = canonicalizeEvidence(specialists.flows.content, ids) as Record<string, unknown>;
  const groups = anchor.changeGroups.map((group) => ({ ...group, evidenceIds: group.evidence.map((ref) => ids.get(`${ref.path}:${ref.line ?? ""}`)!), evidence: undefined }));
  const graphSource = flows.graphs as Record<string, unknown> | undefined;
  if (!graphSource || !["systemOverview", "dataFlow", "codeDependency", "userAction"].every((key) => isRecord(graphSource[key]))) return { valid: false, errors: ["Flows specialist must provide exactly four graphs."] };
  const maxNodes = request.config?.maxGraphNodes ?? 80;
  for (const [key, id] of [["systemOverview", "system-overview"], ["dataFlow", "data-flow"], ["codeDependency", "code-dependency"], ["userAction", "user-action"]] as const) if (!validGraph(graphSource[key] as Record<string, unknown>, id, maxNodes)) return { valid: false, errors: [`${key} graph has invalid nodes, edges, tours, or node limit.`] };
  for (const key of ["dataFlow", "codeDependency", "userAction"] as const) if (!connected(graphSource[key] as Record<string, unknown>)) return { valid: false, errors: [`${key} graph is disconnected or has an orphan node.`] };
  const limitations = [...new Set([...(Array.isArray(walk.limitations) ? walk.limitations : []), ...(Array.isArray(tests.limitations) ? tests.limitations : [])].filter(text))];
  const document = {
    schemaVersion: "1.1.0", run: { id: "anchored-provider-run", createdAt: new Date().toISOString(), provider: request.provider, model: request.model ?? "default", skillVersion: "1.0.0" },
    pullRequest: { host: "github.com", repository: request.repository, number: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha },
    summary: { ...(isRecord(walk.summary) ? walk.summary : {}), limitations }, changeGroups: groups,
    walkthrough: Array.isArray(walk.walkthrough) ? walk.walkthrough : [], graphs: graphSource,
    tests: Array.isArray(tests.tests) ? tests.tests : [], reviewThreads: Array.isArray(walk.reviewThreads) ? walk.reviewThreads : [], reviewInsights: Array.isArray(walk.reviewInsights) ? walk.reviewInsights : [], evidence: evidenceItems,
    unchangedInteractions: Array.isArray(walk.unchangedInteractions) ? walk.unchangedInteractions : [], risks: Array.isArray(tests.risks) ? tests.risks : [], dependencies: Array.isArray(walk.dependencies) ? walk.dependencies : [],
  } as unknown as WalkthroughDocument;
  return { valid: true, document, errors: [] };
}

export function taskOutputFrom(result: AgentAnalysisResult): AnchoredTaskOutput | undefined { return result.taskOutput; }
