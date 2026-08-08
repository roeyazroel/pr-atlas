/** Deterministic host-side orchestration contracts for large PR analysis. */
import { createHash } from "node:crypto";
import type {
  AgentAnalysisResult, AnalysisRequest, AnchoredSpecialistOutput, AnchoredTaskOutput,
  AnchorDomainId, CoordinatorEvidenceReference, ProviderAnalysisTask, SemanticAnchor,
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
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isRecord(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const evidence = (value: unknown): value is CoordinatorEvidenceReference => closed(value, ["path", "line", "role"]) && text(value.path) && Number.isInteger(value.line) && (value.line as number) > 0 && (value.role === "changed" || value.role === "unchanged-context");
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
    if (!closed(domain, ["id", "status", "rationale", "evidence", "changeGroupIds"]) || !(["changed", "unchanged-relevant", "not-evidenced"] as const).includes(domain.status as never) || !text(domain.rationale) || !Array.isArray(domain.evidence) || !domain.evidence.every(evidence) || !strings(domain.changeGroupIds) || !domain.changeGroupIds.every((id) => groupIds.includes(id))) return { valid: false, errors: ["Anchor has an invalid domain classification or reference."] };
    if (domain.status === "changed" && (domain.changeGroupIds.length === 0 || !domain.evidence.some((ref) => ref.role === "changed"))) return { valid: false, errors: ["Every changed anchor domain needs a change group and changed evidence."] };
    if (domain.status === "unchanged-relevant" && (domain.evidence.length === 0 || !domain.evidence.some((ref) => ref.role === "unchanged-context"))) return { valid: false, errors: ["Every unchanged relevant anchor domain needs unchanged-context evidence."] };
    if (domain.status === "not-evidenced" && (domain.evidence.length !== 0 || domain.changeGroupIds.length !== 0)) return { valid: false, errors: ["Not-evidenced anchor domains cannot claim evidence or change groups."] };
  }
  for (const group of groups) {
    if (!closed(group, ["id", "title", "summary", "motivation", "previousBehavior", "newBehavior", "attention", "evidence"]) || !["id", "title", "summary", "motivation", "previousBehavior", "newBehavior"].every((key) => text(group[key])) || !["low", "medium", "high"].includes(group.attention as string) || !Array.isArray(group.evidence) || group.evidence.length === 0 || !group.evidence.every(evidence) || !group.evidence.some((ref) => ref.role === "changed")) return { valid: false, errors: ["Changed anchor groups require behavior before/after and changed grounded evidence."] };
  }
  return { valid: true, output: value as unknown as SemanticAnchor, errors: [] };
}

function validateSpecialist(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: AnchoredSpecialistOutput; errors: string[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["taskId", "coverage", "content"].includes(key)) || value.taskId !== task.id || !Array.isArray(value.coverage) || !isRecord(value.content)) return { valid: false, errors: ["Specialist output must be a closed task-specific object."] };
  const anchor = task.anchor;
  if (!anchor) return { valid: false, errors: ["Specialist task is missing the accepted anchor."] };
  const ids = value.coverage.map((entry) => isRecord(entry) ? entry.domainId : undefined);
  if (ids.length !== ANCHOR_DOMAIN_IDS.length || !ids.every((id) => ANCHOR_DOMAIN_IDS.includes(id as AnchorDomainId)) || !unique(ids as string[]) || ANCHOR_DOMAIN_IDS.some((id) => !ids.includes(id))) return { valid: false, errors: ["Specialist coverage ledger must classify every mandatory domain exactly once."] };
  for (const item of value.coverage) if (!closed(item, ["domainId", "status", "rationale"]) || !["covered", "not-applicable"].includes(item.status as string) || !text(item.rationale)) return { valid: false, errors: ["Specialist coverage ledger is invalid."] };
  const allowed = task.kind === "walkthrough"
    ? ["summary", "walkthrough", "reviewThreads", "reviewInsights", "limitations", "dependencies", "unchangedInteractions", "evidenceRefs"]
    : task.kind === "tests-risks" ? ["tests", "risks", "limitations", "evidenceRefs"] : ["graphs", "evidenceRefs"];
  const content = value.content as Record<string, unknown>;
  const required = allowed.filter((key) => key !== "evidenceRefs");
  if (Object.keys(content).some((key) => !allowed.includes(key)) || !required.every((key) => key in content)) return { valid: false, errors: [`${task.kind} specialist content has missing or unknown fields.`] };
  if (!validSpecialistContent(task.kind as "walkthrough" | "tests-risks" | "flows", content)) return { valid: false, errors: [`${task.kind} specialist content has invalid nested field shapes.`] };
  const references = task.kind === "walkthrough"
    ? (content.walkthrough as Record<string, unknown>[]).map((step) => step.changeGroupId).filter(text)
    : task.kind === "tests-risks"
      ? (content.tests as Record<string, unknown>[]).flatMap((test) => strings(test.changeGroupIds) ? test.changeGroupIds : [])
      : collectStrings(content.graphs, ["changeGroupIds"]);
  const knownGroups = new Set(anchor.changeGroups.map((group) => group.id));
  if (references.some((id) => !knownGroups.has(id))) return { valid: false, errors: ["Specialist output references an unknown anchor change group."] };
  if (task.kind === "flows" && !validFlowSemantics(content.graphs, knownGroups)) return { valid: false, errors: ["Flow nodes violate changed/unchanged anchor evidence semantics."] };
  if (task.kind === "walkthrough" || task.kind === "tests-risks") {
    const covered = new Set(references);
    if (anchor.changeGroups.some((group) => !covered.has(group.id))) return { valid: false, errors: [`${task.kind} must represent every immutable anchor change group.`] };
  }
  if (!collectRefs(content).every(evidence)) return { valid: false, errors: ["Specialist output contains invalid evidence references."] };
  return { valid: true, output: value as unknown as AnchoredSpecialistOutput, errors: [] };
}

function validFlowSemantics(graphs: unknown, knownGroups: ReadonlySet<string>): boolean {
  if (!isRecord(graphs)) return false;
  const check = (value: unknown, systemOverview: boolean) => {
    if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.guidedTours) || value.nodes.length === 0 || value.guidedTours.length === 0) return false;
    const nodeIds = value.nodes.map((node) => isRecord(node) ? node.id : undefined);
    if (!nodeIds.every(text) || !unique(nodeIds as string[])) return false;
    const knownNodes = new Set(nodeIds as string[]);
    const nodeValid = (node: unknown) => {
      if (!isRecord(node) || typeof node.changed !== "boolean" || !strings(node.changeGroupIds) || !Array.isArray(node.evidence) || !node.evidence.every(evidence)) return false;
      if (systemOverview) return node.changed === false
        && ["changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidence"].every((key) => Array.isArray(node[key]) && node[key].length === 0);
      return node.changed
        ? node.changeGroupIds.length > 0 && node.changeGroupIds.every((id) => knownGroups.has(id)) && node.evidence.some((ref) => ref.role === "changed")
        : node.changeGroupIds.length === 0 && node.evidence.every((ref) => ref.role === "unchanged-context");
    };
    return value.nodes.every(nodeValid)
      && (systemOverview ? value.edges.length === 0 : value.edges.length > 0)
      && value.edges.every((edge) => isRecord(edge) && text(edge.id) && text(edge.source) && text(edge.target) && knownNodes.has(edge.source) && knownNodes.has(edge.target) && strings(edge.changeGroupIds) && edge.changeGroupIds.every((id) => knownGroups.has(id)))
      && value.guidedTours.every((tour) => isRecord(tour) && text(tour.id) && text(tour.title) && Array.isArray(tour.steps) && tour.steps.length > 0 && tour.steps.every((step) => isRecord(step) && text(step.nodeId) && knownNodes.has(step.nodeId) && text(step.title) && text(step.explanation)));
  };
  return check(graphs.systemOverview, true) && check(graphs.dataFlow, false) && check(graphs.codeDependency, false) && check(graphs.userAction, false);
}

function collectStrings(value: unknown, keys: string[], found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectStrings(item, keys, found));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key)) {
      if (typeof item === "string") found.push(item);
      else if (Array.isArray(item)) item.filter((entry): entry is string => typeof entry === "string").forEach((entry) => found.push(entry));
    } else collectStrings(item, keys, found);
  }
  return found;
}

/** The coordinator accepts only the intermediary fields that deterministic assembly understands. */
function validSpecialistContent(kind: "walkthrough" | "tests-risks" | "flows", content: Record<string, unknown>): boolean {
  const refs = (value: unknown) => Array.isArray(value) && value.every(evidence);
  const records = (value: unknown, keys: readonly string[], validate: (entry: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every((entry) => closed(entry, keys) && validate(entry));
  const nullable = (value: unknown) => value === null || text(value);
  const reviewReply = (entry: Record<string, unknown>) => text(entry.id) && text(entry.author) && text(entry.body) && ["authorAssociation", "createdAt", "updatedAt", "url", "path", "side", "commitSha", "originalCommitSha"].every((key) => nullable(entry[key])) && ["line", "originalLine"].every((key) => entry[key] === null || (Number.isInteger(entry[key]) && (entry[key] as number) > 0));
  const reviewThread = (entry: Record<string, unknown>) => text(entry.id) && ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"].includes(entry.status as string) && text(entry.provenance) && refs(entry.evidence) && text(entry.author) && text(entry.body) && records(entry.replies, ["id", "author", "body", "authorAssociation", "createdAt", "updatedAt", "url", "path", "line", "originalLine", "side", "commitSha", "originalCommitSha"], reviewReply) && Number.isInteger(entry.replyCount) && (entry.replyCount as number) >= 0 && ["url", "resolvedBy", "authorAssociation", "path", "side", "commitSha", "originalCommitSha", "createdAt", "updatedAt"].every((key) => nullable(entry[key])) && ["line", "originalLine", "startLine", "originalStartLine"].every((key) => entry[key] === null || (Number.isInteger(entry[key]) && (entry[key] as number) > 0)) && strings(entry.changeGroupIds) && strings(entry.graphNodeIds) && strings(entry.reviewInsightIds);
  const reviewInsight = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"].includes(entry.status as string) && text(entry.provenance) && refs(entry.evidence) && strings(entry.changeGroupIds) && strings(entry.reviewThreadIds) && strings(entry.graphNodeIds);
  const risk = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && strings(entry.changeGroupIds) && refs(entry.evidence);
  const dependency = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && strings(entry.dependsOnIds) && strings(entry.changeGroupIds) && refs(entry.evidence);
  const unchangedInteraction = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && strings(entry.changeGroupIds) && refs(entry.evidence);
  if (kind === "walkthrough") {
    const summary = content.summary;
    return closed(summary, ["intent", "behavioralChanges", "architecturalImpact", "limitations"]) && text(summary.intent) && strings(summary.behavioralChanges) && strings(summary.architecturalImpact) && strings(summary.limitations)
      && records(content.walkthrough, ["id", "title", "reason", "summary", "limitations", "dependsOnStepIds", "changeGroupId", "flowNodeIds", "testIds", "reviewInsightIds", "evidence"], (entry) => text(entry.id) && text(entry.title) && text(entry.reason) && text(entry.summary) && strings(entry.limitations) && strings(entry.dependsOnStepIds) && text(entry.changeGroupId) && strings(entry.flowNodeIds) && strings(entry.testIds) && strings(entry.reviewInsightIds) && refs(entry.evidence))
      && records(content.reviewThreads, ["id", "status", "provenance", "evidence", "author", "body", "replies", "replyCount", "url", "resolvedBy", "authorAssociation", "path", "line", "originalLine", "side", "startLine", "originalStartLine", "commitSha", "originalCommitSha", "createdAt", "updatedAt", "changeGroupIds", "graphNodeIds", "reviewInsightIds"], reviewThread)
      && records(content.reviewInsights, ["id", "title", "detail", "status", "provenance", "evidence", "changeGroupIds", "reviewThreadIds", "graphNodeIds"], reviewInsight) && strings(content.limitations)
      && records(content.dependencies, ["id", "title", "detail", "dependsOnIds", "changeGroupIds", "evidence"], dependency)
      && records(content.unchangedInteractions, ["id", "title", "detail", "changeGroupIds", "evidence"], unchangedInteraction) && (content.evidenceRefs === undefined || refs(content.evidenceRefs));
  }
  if (kind === "tests-risks") return records(content.tests, ["id", "title", "behavior", "status", "changeGroupIds", "evidence"], (entry) => text(entry.id) && text(entry.title) && text(entry.behavior) && ["covered", "partial", "missing"].includes(entry.status as string) && strings(entry.changeGroupIds) && refs(entry.evidence)) && records(content.risks, ["id", "title", "detail", "changeGroupIds", "evidence"], risk) && strings(content.limitations) && (content.evidenceRefs === undefined || refs(content.evidenceRefs));
  const graph = (value: unknown, id: string) => closed(value, ["id", "description", "nodes", "edges", "guidedTours"]) && value.id === id && text(value.description)
    && records(value.nodes, ["id", "label", "explanation", "changed", "changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidence"], (entry) => text(entry.id) && text(entry.label) && text(entry.explanation) && typeof entry.changed === "boolean" && strings(entry.changeGroupIds) && strings(entry.testIds) && strings(entry.reviewThreadIds) && strings(entry.reviewInsightIds) && refs(entry.evidence))
    && records(value.edges, ["id", "source", "target", "label", "evidence", "changeGroupIds", "reviewThreadIds"], (entry) => text(entry.id) && text(entry.source) && text(entry.target) && text(entry.label) && refs(entry.evidence) && strings(entry.changeGroupIds) && strings(entry.reviewThreadIds))
    && records(value.guidedTours, ["id", "title", "steps"], (tour) => text(tour.id) && text(tour.title) && records(tour.steps, ["nodeId", "title", "explanation"], (step) => text(step.nodeId) && text(step.title) && text(step.explanation)));
  return closed(content.graphs, ["systemOverview", "dataFlow", "codeDependency", "userAction"]) && graph(content.graphs.systemOverview, "system-overview") && graph(content.graphs.dataFlow, "data-flow") && graph(content.graphs.codeDependency, "code-dependency") && graph(content.graphs.userAction, "user-action") && (content.evidenceRefs === undefined || refs(content.evidenceRefs));
}

export function validateAnchoredTaskOutput(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: AnchoredTaskOutput; errors: string[] } {
  return task.kind === "anchor" ? validateAnchor(value, task) : validateSpecialist(value, task);
}

export function anchoredSchemaForProvider(task: ProviderAnalysisTask): Record<string, unknown> {
  const evidenceRef = { type: "object", additionalProperties: false, required: ["path", "line", "role"], properties: { path: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 }, role: { enum: ["changed", "unchanged-context"] } } };
  const stringArray = { type: "array", items: { type: "string", minLength: 1 } };
  const refArray = { type: "array", items: evidenceRef };
  const walkthroughStep = { type: "object", additionalProperties: false, required: ["id", "title", "reason", "summary", "limitations", "dependsOnStepIds", "changeGroupId", "flowNodeIds", "testIds", "reviewInsightIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, limitations: stringArray, dependsOnStepIds: stringArray, changeGroupId: { type: "string", minLength: 1 }, flowNodeIds: stringArray, testIds: stringArray, reviewInsightIds: stringArray, evidence: refArray } };
  const test = { type: "object", additionalProperties: false, required: ["id", "title", "behavior", "status", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, behavior: { type: "string", minLength: 1 }, status: { enum: ["covered", "partial", "missing"] }, changeGroupIds: stringArray, evidence: refArray } };
  const node = { type: "object", additionalProperties: false, required: ["id", "label", "explanation", "changed", "changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, explanation: { type: "string", minLength: 1 }, changed: { type: "boolean" }, changeGroupIds: stringArray, testIds: stringArray, reviewThreadIds: stringArray, reviewInsightIds: stringArray, evidence: refArray } };
  const edge = { type: "object", additionalProperties: false, required: ["id", "source", "target", "label", "evidence", "changeGroupIds", "reviewThreadIds"], properties: { id: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 }, target: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, evidence: refArray, changeGroupIds: stringArray, reviewThreadIds: stringArray } };
  const tour = { type: "object", additionalProperties: false, required: ["id", "title", "steps"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["nodeId", "title", "explanation"], properties: { nodeId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, explanation: { type: "string", minLength: 1 } } } } } };
  const nullableString = { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] };
  const nullableLine = { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] };
  const reviewStatuses = ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"];
  const reply = { type: "object", additionalProperties: false, required: ["id", "author", "body", "authorAssociation", "createdAt", "updatedAt", "url", "path", "line", "originalLine", "side", "commitSha", "originalCommitSha"], properties: { id: { type: "string", minLength: 1 }, author: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, authorAssociation: nullableString, createdAt: nullableString, updatedAt: nullableString, url: nullableString, path: nullableString, line: nullableLine, originalLine: nullableLine, side: nullableString, commitSha: nullableString, originalCommitSha: nullableString } };
  const reviewThread = { type: "object", additionalProperties: false, required: ["id", "status", "provenance", "evidence", "author", "body", "replies", "replyCount", "url", "resolvedBy", "authorAssociation", "path", "line", "originalLine", "side", "startLine", "originalStartLine", "commitSha", "originalCommitSha", "createdAt", "updatedAt", "changeGroupIds", "graphNodeIds", "reviewInsightIds"], properties: { id: { type: "string", minLength: 1 }, status: { enum: reviewStatuses }, provenance: { type: "string", minLength: 1 }, evidence: refArray, author: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, replies: { type: "array", items: reply }, replyCount: { type: "integer", minimum: 0 }, url: nullableString, resolvedBy: nullableString, authorAssociation: nullableString, path: nullableString, line: nullableLine, originalLine: nullableLine, side: nullableString, startLine: nullableLine, originalStartLine: nullableLine, commitSha: nullableString, originalCommitSha: nullableString, createdAt: nullableString, updatedAt: nullableString, changeGroupIds: stringArray, graphNodeIds: stringArray, reviewInsightIds: stringArray } };
  const reviewInsight = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "status", "provenance", "evidence", "changeGroupIds", "reviewThreadIds", "graphNodeIds"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, status: { enum: reviewStatuses }, provenance: { type: "string", minLength: 1 }, evidence: refArray, changeGroupIds: stringArray, reviewThreadIds: stringArray, graphNodeIds: stringArray } };
  const risk = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, changeGroupIds: stringArray, evidence: refArray } };
  const dependency = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "dependsOnIds", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, dependsOnIds: stringArray, changeGroupIds: stringArray, evidence: refArray } };
  const unchangedInteraction = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, changeGroupIds: stringArray, evidence: refArray } };
  const emptyStringArray = { type: "array", maxItems: 0, items: { type: "string", minLength: 1 } };
  const emptyRefArray = { type: "array", maxItems: 0, items: evidenceRef };
  const systemNode = { ...node, properties: { ...node.properties, changed: { const: false }, changeGroupIds: emptyStringArray, testIds: emptyStringArray, reviewThreadIds: emptyStringArray, reviewInsightIds: emptyStringArray, evidence: emptyRefArray } };
  const graph = (id: string, systemOverview = false) => ({ type: "object", additionalProperties: false, required: ["id", "description", "nodes", "edges", "guidedTours"], properties: { id: { const: id }, description: { type: "string", minLength: 1 }, nodes: { type: "array", minItems: 1, items: systemOverview ? systemNode : node }, edges: systemOverview ? { type: "array", maxItems: 0, items: edge } : { type: "array", minItems: 1, items: edge }, guidedTours: { type: "array", minItems: 1, items: tour } } });
  if (task.kind === "anchor") return { type: "object", additionalProperties: false, required: ["taskId", "domains", "changeGroups"], properties: { taskId: { const: task.id }, domains: { type: "array", minItems: 6, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["id", "status", "rationale", "evidence", "changeGroupIds"], properties: { id: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["changed", "unchanged-relevant", "not-evidenced"] }, rationale: { type: "string", minLength: 1 }, evidence: { type: "array", items: evidenceRef }, changeGroupIds: { type: "array", items: { type: "string" } } } } }, changeGroups: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "summary", "motivation", "previousBehavior", "newBehavior", "attention", "evidence"], properties: { id: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, motivation: { type: "string" }, previousBehavior: { type: "string" }, newBehavior: { type: "string" }, attention: { enum: ["low", "medium", "high"] }, evidence: { type: "array", minItems: 1, items: evidenceRef } } } } } };
  const coverage = { type: "array", minItems: ANCHOR_DOMAIN_IDS.length, maxItems: ANCHOR_DOMAIN_IDS.length, items: { type: "object", additionalProperties: false, required: ["domainId", "status", "rationale"], properties: { domainId: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["covered", "not-applicable"] }, rationale: { type: "string", minLength: 1 } } } };
  const content = task.kind === "walkthrough"
    ? { type: "object", additionalProperties: false, required: ["summary", "walkthrough", "reviewThreads", "reviewInsights", "limitations", "dependencies", "unchangedInteractions"], properties: { summary: { type: "object", additionalProperties: false, required: ["intent", "behavioralChanges", "architecturalImpact", "limitations"], properties: { intent: { type: "string", minLength: 1 }, behavioralChanges: stringArray, architecturalImpact: stringArray, limitations: stringArray } }, walkthrough: { type: "array", items: walkthroughStep }, reviewThreads: { type: "array", items: reviewThread }, reviewInsights: { type: "array", items: reviewInsight }, limitations: stringArray, dependencies: { type: "array", items: dependency }, unchangedInteractions: { type: "array", items: unchangedInteraction }, evidenceRefs: refArray } }
    : task.kind === "tests-risks"
      ? { type: "object", additionalProperties: false, required: ["tests", "risks", "limitations"], properties: { tests: { type: "array", items: test }, risks: { type: "array", items: risk }, limitations: stringArray, evidenceRefs: refArray } }
      : { type: "object", additionalProperties: false, required: ["graphs"], properties: { graphs: { type: "object", additionalProperties: false, required: ["systemOverview", "dataFlow", "codeDependency", "userAction"], properties: { systemOverview: graph("system-overview", true), dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") } }, evidenceRefs: refArray } };
  return { type: "object", additionalProperties: false, required: ["taskId", "coverage", "content"], properties: { taskId: { const: task.id }, coverage, content } };
}

function evidenceKey(reference: CoordinatorEvidenceReference): string {
  return JSON.stringify([reference.path, reference.line, reference.role]);
}
function evidenceId(reference: CoordinatorEvidenceReference): string {
  return `evidence-${createHash("sha256").update(evidenceKey(reference)).digest("base64url")}`;
}
function collectRefs(value: unknown, found: CoordinatorEvidenceReference[] = []): CoordinatorEvidenceReference[] {
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
    if ((key === "evidence" || key === "evidenceRefs") && Array.isArray(item)) next.evidenceIds = item.filter(evidence).map((ref) => ids.get(evidenceKey(ref))!);
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
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodes = rawNodes.filter(isRecord);
  const nodeIds = nodes.map((node) => node.id).filter(text);
  if (graph.id !== expectedId || nodes.length !== rawNodes.length || nodeIds.length !== nodes.length || !unique(nodeIds) || nodes.length === 0 || nodes.length > maxNodes) return false;
  const known = new Set(nodeIds);
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const edges = rawEdges.filter(isRecord);
  const rawTours = Array.isArray(graph.guidedTours) ? graph.guidedTours : [];
  const tours = rawTours.filter(isRecord);
  if (expectedId === "system-overview" ? edges.length !== 0 : edges.length === 0) return false;
  if (edges.length !== rawEdges.length || tours.length !== rawTours.length || tours.length === 0) return false;
  if (expectedId === "system-overview" && !nodes.every((node) => node.changed === false && ["changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidenceIds"].every((key) => Array.isArray(node[key]) && node[key].length === 0))) return false;
  return edges.every((edge) => text(edge.id) && typeof edge.source === "string" && typeof edge.target === "string" && known.has(edge.source) && known.has(edge.target))
    && tours.every((tour) => text(tour.id) && text(tour.title) && Array.isArray(tour.steps) && tour.steps.length > 0 && tour.steps.every((step) => isRecord(step) && text(step.nodeId) && known.has(step.nodeId) && text(step.title) && text(step.explanation)));
}

/** Assemble only declared specialist fields; joins are made solely by shared canonical evidence. */
export function assembleAnchoredDocument(request: AnalysisRequest, anchor: SemanticAnchor, specialists: Record<"walkthrough" | "tests-risks" | "flows", AnchoredSpecialistOutput>, model?: string): { valid: boolean; document?: WalkthroughDocument; errors: string[] } {
  const relevant = anchor.domains.filter((domain) => domain.status !== "not-evidenced").map((domain) => domain.id);
  const coverage = new Map<AnchorDomainId, number>();
  for (const specialist of Object.values(specialists)) for (const entry of specialist.coverage) if (entry.status === "covered") coverage.set(entry.domainId, (coverage.get(entry.domainId) ?? 0) + 1);
  if (relevant.some((id) => !coverage.has(id))) return { valid: false, errors: ["At least one specialist must cover every relevant anchor domain."] };
  const refs = [...collectRefs(anchor), ...Object.values(specialists).flatMap((item) => collectRefs(item.content))];
  const evidenceByKey = new Map<string, CoordinatorEvidenceReference>();
  for (const ref of refs) evidenceByKey.set(evidenceKey(ref), ref);
  const ids = new Map<string, string>(); for (const [key, ref] of evidenceByKey) ids.set(key, evidenceId(ref));
  const evidenceItems = [...evidenceByKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, ref]) => ({ id: ids.get(key)!, kind: "file", title: `${ref.path}:${ref.line}`, path: ref.path, line: ref.line, url: null }));
  const walk = canonicalizeEvidence(specialists.walkthrough.content, ids) as Record<string, unknown>;
  const tests = canonicalizeEvidence(specialists["tests-risks"].content, ids) as Record<string, unknown>;
  const flows = canonicalizeEvidence(specialists.flows.content, ids) as Record<string, unknown>;
  const groups = anchor.changeGroups.map((group) => ({ ...group, evidenceIds: group.evidence.map((ref) => ids.get(evidenceKey(ref))!), evidence: undefined }));
  const graphSource = flows.graphs as Record<string, unknown> | undefined;
  if (!graphSource || !["systemOverview", "dataFlow", "codeDependency", "userAction"].every((key) => isRecord(graphSource[key]))) return { valid: false, errors: ["Flows specialist must provide exactly four graphs."] };
  const maxNodes = request.config?.maxGraphNodes ?? 80;
  for (const [key, id] of [["systemOverview", "system-overview"], ["dataFlow", "data-flow"], ["codeDependency", "code-dependency"], ["userAction", "user-action"]] as const) if (!validGraph(graphSource[key] as Record<string, unknown>, id, maxNodes)) return { valid: false, errors: [`${key} graph has invalid nodes, edges, tours, or node limit.`] };
  for (const key of ["dataFlow", "codeDependency", "userAction"] as const) if (!connected(graphSource[key] as Record<string, unknown>)) return { valid: false, errors: [`${key} graph is disconnected or has an orphan node.`] };
  const limitations = [...new Set([...(Array.isArray(walk.limitations) ? walk.limitations : []), ...(Array.isArray(tests.limitations) ? tests.limitations : [])].filter(text))];
  const document = {
    schemaVersion: "1.1.0", run: { id: "anchored-provider-run", createdAt: new Date().toISOString(), provider: request.provider, model: request.model ?? model ?? "default", skillVersion: "1.0.0" },
    pullRequest: { host: "github.com", repository: request.repository, number: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha },
    summary: { ...(isRecord(walk.summary) ? walk.summary : {}), limitations }, changeGroups: groups,
    walkthrough: Array.isArray(walk.walkthrough) ? walk.walkthrough : [], graphs: graphSource,
    tests: Array.isArray(tests.tests) ? tests.tests : [], reviewThreads: Array.isArray(walk.reviewThreads) ? walk.reviewThreads : [], reviewInsights: Array.isArray(walk.reviewInsights) ? walk.reviewInsights : [], evidence: evidenceItems,
    unchangedInteractions: Array.isArray(walk.unchangedInteractions) ? walk.unchangedInteractions : [], risks: Array.isArray(tests.risks) ? tests.risks : [], dependencies: Array.isArray(walk.dependencies) ? walk.dependencies : [],
  } as unknown as WalkthroughDocument;
  return { valid: true, document, errors: [] };
}

export function taskOutputFrom(result: AgentAnalysisResult): AnchoredTaskOutput | undefined { return result.taskOutput; }
