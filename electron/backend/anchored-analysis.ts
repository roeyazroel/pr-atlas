/** Deterministic host-side orchestration contracts for large PR analysis. */
import { createHash } from "node:crypto";
import type {
  AgentAnalysisResult, AnalysisRequest, AnchoredSpecialistOutput, AnchoredTaskOutput,
  AnchorDomainId, CoordinatorEvidenceReference, ProviderAnalysisTask, SemanticAnchor,
  ReviewDocument,
} from "../../shared/contracts.js";
import { validateReviewDocument } from "../../shared/schema.js";

const LARGE_ANALYSIS_THRESHOLDS = { files: 20, changes: 1_000 } as const;
const ANCHOR_DOMAIN_IDS = [
  "production-path", "experimental-pocs", "migration-rollback", "updater-installer",
  "runtime-packaging", "reviewer-workflow",
] as const satisfies readonly AnchorDomainId[];

export function shouldUseAnchoredAnalysis(input: { files: number; changes: number }): boolean {
  return input.files >= LARGE_ANALYSIS_THRESHOLDS.files || input.changes >= LARGE_ANALYSIS_THRESHOLDS.changes;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isRecord(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const evidence = (value: unknown): value is CoordinatorEvidenceReference => closed(value, ["path", "line", "role"]) && text(value.path) && Number.isInteger(value.line) && (value.line as number) > 0 && (value.role === "changed" || value.role === "unchanged-context");
const unique = (values: string[]) => new Set(values).size === values.length;
function canonicalReviewIds(value: unknown): { ids: string[]; errors: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const register = (id: unknown) => {
    if (!text(id)) { errors.push("Review provenance is missing a canonical id."); return; }
    if (seen.has(id)) { errors.push("Review provenance contains a duplicate canonical id."); return; }
    seen.add(id); ids.push(id);
  };
  if (!Array.isArray(value)) return { ids, errors: ["Review provenance must be an array."] };
  for (const thread of value) {
    if (!isRecord(thread)) { errors.push("Review provenance contains an invalid thread."); continue; }
    register(thread.id);
    if (!Array.isArray(thread.replies)) { errors.push("Review provenance contains an invalid replies array."); continue; }
    for (const reply of thread.replies) register(isRecord(reply) ? reply.id : undefined);
  }
  return { ids, errors };
}

function reviewDependencyErrors(content: Record<string, unknown>): string[] {
  const dependencies = Array.isArray(content.dependencies)
    ? content.dependencies.filter(isRecord)
    : [];
  const known = new Set(
    dependencies.map((dependency) => dependency.id).filter(text),
  );
  const errors: string[] = [];
  for (const dependency of dependencies) {
    const id = dependency.id;
    if (!text(id)) continue;
    const targets = Array.isArray(dependency.dependsOnIds)
      ? dependency.dependsOnIds.filter(text)
      : [];
    for (const target of targets) {
      if (!known.has(target))
        errors.push(`Review specialist dependency '${id}' targets unknown dependency '${target}'.`);
      else if (target === id)
        errors.push(`Review specialist dependency '${id}' cannot depend on itself.`);
    }
  }
  if (errors.length > 0) return errors;
  const byId = new Map(
    dependencies.filter((dependency) => text(dependency.id)).map((dependency) => [dependency.id as string, dependency]),
  );
  const states = new Map<string, "visiting" | "visited">();
  const visit = (id: string): boolean => {
    if (states.get(id) === "visiting") {
      errors.push(`Review specialist dependencies contain a cycle through '${id}'.`);
      return true;
    }
    if (states.get(id) === "visited") return false;
    states.set(id, "visiting");
    const targets = byId.get(id)?.dependsOnIds;
    if (Array.isArray(targets))
      for (const target of targets)
        if (typeof target === "string" && byId.has(target) && visit(target)) return true;
    states.set(id, "visited");
    return false;
  };
  for (const id of byId.keys()) if (visit(id)) break;
  return errors;
}

function reviewRelationshipErrors(content: Record<string, unknown>): string[] {
  const threads = Array.isArray(content.reviewThreads)
    ? content.reviewThreads.filter(isRecord)
    : [];
  const insights = Array.isArray(content.reviewInsights)
    ? content.reviewInsights.filter(isRecord)
    : [];
  const threadIds = new Set(threads.map((thread) => thread.id).filter(text));
  const insightIds = new Set(insights.map((insight) => insight.id).filter(text));
  const errors: string[] = [];
  for (const thread of threads) {
    if (!text(thread.id) || !strings(thread.reviewInsightIds)) continue;
    for (const insightId of thread.reviewInsightIds)
      if (!insightIds.has(insightId))
        errors.push(`Review specialist thread '${thread.id}' references unknown review insight '${insightId}'.`);
  }
  for (const insight of insights) {
    if (!text(insight.id) || !strings(insight.reviewThreadIds)) continue;
    for (const threadId of insight.reviewThreadIds)
      if (!threadIds.has(threadId))
        errors.push(`Review specialist insight '${insight.id}' references unknown review thread '${threadId}'.`);
  }
  return errors;
}

function specialistSemanticIdErrors(kind: "review" | "tests-risks" | "flows", content: Record<string, unknown>): string[] {
  const collections = kind === "review"
    ? ["reviewThreads", "reviewInsights", "dependencies", "unchangedInteractions"]
    : kind === "tests-risks" ? ["tests", "risks"] : [];
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const name of collections) {
    const entries = Array.isArray(content[name]) ? content[name] : [];
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || !text(entry.id)) return;
      const current = `${name}[${index}]`;
      const previous = seen.get(entry.id);
      if (previous) errors.push(`${kind} specialist contains duplicate semantic id '${entry.id}' in ${current} and ${previous}.`);
      else seen.set(entry.id, current);
    });
  }
  return errors;
}

function validateAnchor(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: SemanticAnchor; errors: string[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["taskId", "domains", "changeGroups", "stories", "primaryStoryId", "reviewPlan"].includes(key))) return { valid: false, errors: ["Anchor output must be a closed object."] };
  if (value.taskId !== task.id || !Array.isArray(value.domains) || !Array.isArray(value.changeGroups) || !Array.isArray(value.stories) || !text(value.primaryStoryId) || !strings(value.reviewPlan)) return { valid: false, errors: ["Anchor output has invalid canonical collections."] };
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
  const stories = value.stories;
  const storyIds = stories.map((story) => isRecord(story) ? story.id : undefined);
  if (!storyIds.every(text) || !unique(storyIds as string[]) || value.reviewPlan.length !== stories.length || !unique(value.reviewPlan) || value.reviewPlan.some((id) => !storyIds.includes(id))) return { valid: false, errors: ["Anchor review plan must contain every story exactly once."] };
  if (value.reviewPlan[0] !== value.primaryStoryId) return { valid: false, errors: ["Anchor review plan must begin with primaryStoryId."] };
  const owners = new Set<string>();
  let primary = 0;
  for (const story of stories) {
    if (!closed(story, ["id", "title", "summary", "relationshipToPrimary", "relationshipRationale", "reviewReason", "changeGroupIds", "dependsOnStoryIds"]) || !["id", "title", "summary", "relationshipRationale", "reviewReason"].every((key) => text(story[key])) || !["primary", "supporting", "adjacent", "independent"].includes(story.relationshipToPrimary as string) || !strings(story.changeGroupIds) || story.changeGroupIds.length === 0 || !strings(story.dependsOnStoryIds) || story.changeGroupIds.some((id) => !groupIds.includes(id) || owners.has(id))) return { valid: false, errors: ["Anchor stories must own known change groups exactly once."] };
    story.changeGroupIds.forEach((id) => owners.add(id));
    if (story.relationshipToPrimary === "primary") primary++;
    for (const dependency of story.dependsOnStoryIds) {
      const current = value.reviewPlan.indexOf(story.id as string);
      const previous = value.reviewPlan.indexOf(dependency);
      if (!storyIds.includes(dependency) || dependency === story.id || previous >= current) return { valid: false, errors: ["Anchor story dependencies must target earlier review-plan stories."] };
    }
  }
  if (primary !== 1 || !stories.some((story) => isRecord(story) && story.id === value.primaryStoryId && story.relationshipToPrimary === "primary") || owners.size !== groups.length) return { valid: false, errors: ["Anchor requires one primary story and exact change-group story coverage."] };
  return { valid: true, output: value as unknown as SemanticAnchor, errors: [] };
}

function validateSpecialist(value: unknown, task: ProviderAnalysisTask): { valid: boolean; output?: AnchoredSpecialistOutput; errors: string[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["taskId", "coverage", "content"].includes(key)) || value.taskId !== task.id || !Array.isArray(value.coverage) || !isRecord(value.content)) return { valid: false, errors: ["Specialist output must be a closed task-specific object."] };
  const anchor = task.anchor;
  if (!anchor) return { valid: false, errors: ["Specialist task is missing the accepted anchor."] };
  const ids = value.coverage.map((entry) => isRecord(entry) ? entry.domainId : undefined);
  if (ids.length !== ANCHOR_DOMAIN_IDS.length || !ids.every((id) => ANCHOR_DOMAIN_IDS.includes(id as AnchorDomainId)) || !unique(ids as string[]) || ANCHOR_DOMAIN_IDS.some((id) => !ids.includes(id))) return { valid: false, errors: ["Specialist coverage ledger must classify every mandatory domain exactly once."] };
  for (const item of value.coverage) if (!closed(item, ["domainId", "status", "rationale"]) || !["covered", "not-applicable"].includes(item.status as string) || !text(item.rationale)) return { valid: false, errors: ["Specialist coverage ledger is invalid."] };
  const allowed = task.kind === "review"
    ? ["summary", "reviewThreads", "reviewInsights", "limitations", "dependencies", "unchangedInteractions", "evidenceRefs"]
    : task.kind === "tests-risks" ? ["tests", "risks", "limitations", "evidenceRefs"] : ["graphs", "evidenceRefs"];
  const content = value.content as Record<string, unknown>;
  const required = allowed.filter((key) => key !== "evidenceRefs");
  if (Object.keys(content).some((key) => !allowed.includes(key)) || !required.every((key) => key in content)) return { valid: false, errors: [`${task.kind} specialist content has missing or unknown fields.`] };
  if (!validSpecialistContent(task.kind as "review" | "tests-risks" | "flows", content)) return { valid: false, errors: [`${task.kind} specialist content has invalid nested field shapes.`] };
  if (task.kind === "review") {
    const dependencyErrors = reviewDependencyErrors(content);
    if (dependencyErrors.length) return { valid: false, errors: dependencyErrors };
    if (canonicalReviewIds(content.reviewThreads).errors.length) return { valid: false, errors: ["Review specialist review provenance ids must be unique and canonical."] };
    const semanticIdErrors = specialistSemanticIdErrors(task.kind, content);
    if (semanticIdErrors.length) return { valid: false, errors: semanticIdErrors };
    const relationshipErrors = reviewRelationshipErrors(content);
    if (relationshipErrors.length) return { valid: false, errors: relationshipErrors };
  }
  if (task.kind === "tests-risks") {
    const semanticIdErrors = specialistSemanticIdErrors(task.kind, content);
    if (semanticIdErrors.length) return { valid: false, errors: semanticIdErrors };
  }
  const coverageReferences = task.kind === "review"
    ? []
    : task.kind === "tests-risks"
      ? (content.tests as Record<string, unknown>[]).flatMap((test) => strings(test.changeGroupIds) ? test.changeGroupIds : [])
      : collectStrings(content.graphs, ["changeGroupIds"]);
  const knownGroups = new Set(anchor.changeGroups.map((group) => group.id));
  const relationshipReferences = [...coverageReferences, ...collectStrings(content, ["changeGroupIds"])];
  if (relationshipReferences.some((id) => !knownGroups.has(id))) return { valid: false, errors: ["Specialist output references an unknown anchor change group."] };
  if (task.kind === "flows") {
    if (!validFlowSemantics(content.graphs, knownGroups)) return { valid: false, errors: ["Flow nodes violate changed/unchanged anchor evidence semantics."] };
    const connectivityErrors = disconnectedGraphErrors(content.graphs as Record<string, unknown>);
    if (connectivityErrors.length > 0) return { valid: false, errors: connectivityErrors };
  }
  if (task.kind === "tests-risks") {
    const covered = new Set(coverageReferences);
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
  const graphValues = [graphs.systemOverview, graphs.dataFlow, graphs.codeDependency, graphs.userAction];
  const semanticIds = graphValues.flatMap((graph) => isRecord(graph)
    ? ["nodes", "edges", "guidedTours"].flatMap((collection) => Array.isArray(graph[collection])
      ? graph[collection].map((item) => isRecord(item) ? item.id : undefined)
      : [])
    : []);
  return check(graphs.systemOverview, true) && check(graphs.dataFlow, false) && check(graphs.codeDependency, false) && check(graphs.userAction, false)
    && semanticIds.every(text) && unique(semanticIds as string[]);
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
function validSpecialistContent(kind: "review" | "tests-risks" | "flows", content: Record<string, unknown>): boolean {
  const refs = (value: unknown) => Array.isArray(value) && value.every(evidence);
  const groundedRefs = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(evidence);
  const groundedStrings = (value: unknown) => strings(value) && value.length > 0;
  const records = (value: unknown, keys: readonly string[], validate: (entry: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every((entry) => closed(entry, keys) && validate(entry));
  const nullable = (value: unknown) => value === null || text(value);
  const reviewReply = (entry: Record<string, unknown>) => text(entry.id) && text(entry.author) && text(entry.body) && ["authorAssociation", "createdAt", "updatedAt", "url", "path", "side", "commitSha", "originalCommitSha"].every((key) => nullable(entry[key])) && ["line", "originalLine"].every((key) => entry[key] === null || (Number.isInteger(entry[key]) && (entry[key] as number) > 0));
  const reviewThread = (entry: Record<string, unknown>) => text(entry.id) && ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"].includes(entry.status as string) && text(entry.provenance) && refs(entry.evidence) && text(entry.author) && text(entry.body) && records(entry.replies, ["id", "author", "body", "authorAssociation", "createdAt", "updatedAt", "url", "path", "line", "originalLine", "side", "commitSha", "originalCommitSha"], reviewReply) && Number.isInteger(entry.replyCount) && (entry.replyCount as number) >= 0 && ["url", "resolvedBy", "authorAssociation", "path", "side", "commitSha", "originalCommitSha", "createdAt", "updatedAt"].every((key) => nullable(entry[key])) && ["line", "originalLine", "startLine", "originalStartLine"].every((key) => entry[key] === null || (Number.isInteger(entry[key]) && (entry[key] as number) > 0)) && strings(entry.changeGroupIds) && strings(entry.graphNodeIds) && strings(entry.reviewInsightIds);
  const reviewInsight = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"].includes(entry.status as string) && text(entry.provenance) && refs(entry.evidence) && strings(entry.changeGroupIds) && strings(entry.reviewThreadIds) && strings(entry.graphNodeIds);
  const risk = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && groundedStrings(entry.changeGroupIds) && groundedRefs(entry.evidence);
  const dependency = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && strings(entry.dependsOnIds) && groundedStrings(entry.changeGroupIds) && groundedRefs(entry.evidence);
  const unchangedInteraction = (entry: Record<string, unknown>) => text(entry.id) && text(entry.title) && text(entry.detail) && groundedStrings(entry.changeGroupIds) && groundedRefs(entry.evidence);
  if (kind === "review") {
    const summary = content.summary;
    return closed(summary, ["intent", "behavioralChanges", "architecturalImpact", "limitations"]) && text(summary.intent) && strings(summary.behavioralChanges) && strings(summary.architecturalImpact) && strings(summary.limitations)
      && records(content.reviewThreads, ["id", "status", "provenance", "evidence", "author", "body", "replies", "replyCount", "url", "resolvedBy", "authorAssociation", "path", "line", "originalLine", "side", "startLine", "originalStartLine", "commitSha", "originalCommitSha", "createdAt", "updatedAt", "changeGroupIds", "graphNodeIds", "reviewInsightIds"], reviewThread)
      && records(content.reviewInsights, ["id", "title", "detail", "status", "provenance", "evidence", "changeGroupIds", "reviewThreadIds", "graphNodeIds"], reviewInsight) && strings(content.limitations)
      && records(content.dependencies, ["id", "title", "detail", "dependsOnIds", "changeGroupIds", "evidence"], dependency)
      && records(content.unchangedInteractions, ["id", "title", "detail", "changeGroupIds", "evidence"], unchangedInteraction) && (content.evidenceRefs === undefined || refs(content.evidenceRefs));
  }
  if (kind === "tests-risks") return records(content.tests, ["id", "title", "behavior", "status", "changeGroupIds", "evidence"], (entry) => text(entry.id) && text(entry.title) && text(entry.behavior) && ["covered", "partial", "missing"].includes(entry.status as string) && groundedStrings(entry.changeGroupIds) && groundedRefs(entry.evidence)) && records(content.risks, ["id", "title", "detail", "changeGroupIds", "evidence"], risk) && strings(content.limitations) && (content.evidenceRefs === undefined || refs(content.evidenceRefs));
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
  const groundedStringArray = { ...stringArray, minItems: 1 };
  const groundedRefArray = { ...refArray, minItems: 1 };
  const test = { type: "object", additionalProperties: false, required: ["id", "title", "behavior", "status", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, behavior: { type: "string", minLength: 1 }, status: { enum: ["covered", "partial", "missing"] }, changeGroupIds: groundedStringArray, evidence: groundedRefArray } };
  const node = { type: "object", additionalProperties: false, required: ["id", "label", "explanation", "changed", "changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, explanation: { type: "string", minLength: 1 }, changed: { type: "boolean" }, changeGroupIds: stringArray, testIds: stringArray, reviewThreadIds: stringArray, reviewInsightIds: stringArray, evidence: refArray } };
  const edge = { type: "object", additionalProperties: false, required: ["id", "source", "target", "label", "evidence", "changeGroupIds", "reviewThreadIds"], properties: { id: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 }, target: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, evidence: refArray, changeGroupIds: stringArray, reviewThreadIds: stringArray } };
  const tour = { type: "object", additionalProperties: false, required: ["id", "title", "steps"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["nodeId", "title", "explanation"], properties: { nodeId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, explanation: { type: "string", minLength: 1 } } } } } };
  const nullableString = { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] };
  const nullableLine = { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] };
  const reviewStatuses = ["active", "open", "resolved", "outdated", "disputed", "dismissed", "informational", "unknown"];
  const reply = { type: "object", additionalProperties: false, required: ["id", "author", "body", "authorAssociation", "createdAt", "updatedAt", "url", "path", "line", "originalLine", "side", "commitSha", "originalCommitSha"], properties: { id: { type: "string", minLength: 1 }, author: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, authorAssociation: nullableString, createdAt: nullableString, updatedAt: nullableString, url: nullableString, path: nullableString, line: nullableLine, originalLine: nullableLine, side: nullableString, commitSha: nullableString, originalCommitSha: nullableString } };
  const reviewThread = { type: "object", additionalProperties: false, required: ["id", "status", "provenance", "evidence", "author", "body", "replies", "replyCount", "url", "resolvedBy", "authorAssociation", "path", "line", "originalLine", "side", "startLine", "originalStartLine", "commitSha", "originalCommitSha", "createdAt", "updatedAt", "changeGroupIds", "graphNodeIds", "reviewInsightIds"], properties: { id: { type: "string", minLength: 1 }, status: { enum: reviewStatuses }, provenance: { type: "string", minLength: 1 }, evidence: refArray, author: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, replies: { type: "array", items: reply }, replyCount: { type: "integer", minimum: 0 }, url: nullableString, resolvedBy: nullableString, authorAssociation: nullableString, path: nullableString, line: nullableLine, originalLine: nullableLine, side: nullableString, startLine: nullableLine, originalStartLine: nullableLine, commitSha: nullableString, originalCommitSha: nullableString, createdAt: nullableString, updatedAt: nullableString, changeGroupIds: stringArray, graphNodeIds: stringArray, reviewInsightIds: stringArray } };
  const reviewInsight = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "status", "provenance", "evidence", "changeGroupIds", "reviewThreadIds", "graphNodeIds"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, status: { enum: reviewStatuses }, provenance: { type: "string", minLength: 1 }, evidence: refArray, changeGroupIds: stringArray, reviewThreadIds: stringArray, graphNodeIds: stringArray } };
  const risk = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, changeGroupIds: groundedStringArray, evidence: groundedRefArray } };
  const dependency = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "dependsOnIds", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, dependsOnIds: stringArray, changeGroupIds: groundedStringArray, evidence: groundedRefArray } };
  const unchangedInteraction = { type: "object", additionalProperties: false, required: ["id", "title", "detail", "changeGroupIds", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, detail: { type: "string", minLength: 1 }, changeGroupIds: groundedStringArray, evidence: groundedRefArray } };
  const emptyStringArray = { type: "array", maxItems: 0, items: { type: "string", minLength: 1 } };
  const emptyRefArray = { type: "array", maxItems: 0, items: evidenceRef };
  const systemNode = { ...node, properties: { ...node.properties, changed: { const: false }, changeGroupIds: emptyStringArray, testIds: emptyStringArray, reviewThreadIds: emptyStringArray, reviewInsightIds: emptyStringArray, evidence: emptyRefArray } };
  const graph = (id: string, systemOverview = false) => ({ type: "object", additionalProperties: false, required: ["id", "description", "nodes", "edges", "guidedTours"], properties: { id: { const: id }, description: { type: "string", minLength: 1 }, nodes: { type: "array", minItems: 1, items: systemOverview ? systemNode : node }, edges: systemOverview ? { type: "array", maxItems: 0, items: edge } : { type: "array", minItems: 1, items: edge }, guidedTours: { type: "array", minItems: 1, items: tour } } });
  if (task.kind === "anchor") return { type: "object", additionalProperties: false, required: ["taskId", "domains", "changeGroups", "stories", "primaryStoryId", "reviewPlan"], properties: { taskId: { const: task.id }, domains: { type: "array", minItems: 6, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["id", "status", "rationale", "evidence", "changeGroupIds"], properties: { id: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["changed", "unchanged-relevant", "not-evidenced"] }, rationale: { type: "string", minLength: 1 }, evidence: { type: "array", items: evidenceRef }, changeGroupIds: stringArray } } }, changeGroups: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "title", "summary", "motivation", "previousBehavior", "newBehavior", "attention", "evidence"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, motivation: { type: "string", minLength: 1 }, previousBehavior: { type: "string", minLength: 1 }, newBehavior: { type: "string", minLength: 1 }, attention: { enum: ["low", "medium", "high"] }, evidence: { type: "array", minItems: 1, items: evidenceRef } } } }, stories: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "title", "summary", "relationshipToPrimary", "relationshipRationale", "reviewReason", "changeGroupIds", "dependsOnStoryIds"], properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, relationshipToPrimary: { enum: ["primary", "supporting", "adjacent", "independent"] }, relationshipRationale: { type: "string", minLength: 1 }, reviewReason: { type: "string", minLength: 1 }, changeGroupIds: { ...stringArray, minItems: 1 }, dependsOnStoryIds: stringArray } } }, primaryStoryId: { type: "string", minLength: 1 }, reviewPlan: { ...stringArray, minItems: 1 } } };
  const coverage = { type: "array", minItems: ANCHOR_DOMAIN_IDS.length, maxItems: ANCHOR_DOMAIN_IDS.length, items: { type: "object", additionalProperties: false, required: ["domainId", "status", "rationale"], properties: { domainId: { enum: ANCHOR_DOMAIN_IDS }, status: { enum: ["covered", "not-applicable"] }, rationale: { type: "string", minLength: 1 } } } };
  const content = task.kind === "review"
    ? { type: "object", additionalProperties: false, required: ["summary", "reviewThreads", "reviewInsights", "limitations", "dependencies", "unchangedInteractions"], properties: { summary: { type: "object", additionalProperties: false, required: ["intent", "behavioralChanges", "architecturalImpact", "limitations"], properties: { intent: { type: "string", minLength: 1 }, behavioralChanges: stringArray, architecturalImpact: stringArray, limitations: stringArray } }, reviewThreads: { type: "array", items: reviewThread }, reviewInsights: { type: "array", items: reviewInsight }, limitations: stringArray, dependencies: { type: "array", items: dependency }, unchangedInteractions: { type: "array", items: unchangedInteraction }, evidenceRefs: refArray } }
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
function nextUniqueId(base: string, occupied: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) candidate = `${base}-${suffix++}`;
  occupied.add(candidate);
  return candidate;
}
function namespaceSemanticCollection(value: unknown, prefix: string, occupied: Set<string>): { items: Record<string, unknown>[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const items = (Array.isArray(value) ? value : []).filter(isRecord).map((item) => {
    if (!text(item.id)) return item;
    const id = nextUniqueId(`${prefix}-${item.id}`, occupied);
    if (!ids.has(item.id)) ids.set(item.id, id);
    return { ...item, id };
  });
  return { items, ids };
}
function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  return Array.isArray(value) ? value.map((id) => typeof id === "string" ? ids.get(id) ?? id : id) : value;
}
function remapId(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  return typeof value === "string" ? ids.get(value) ?? value : value;
}
function namespaceGraphs(graphs: Record<string, unknown>, occupied: Set<string>, changeGroupIds: ReadonlyMap<string, string>, testIds: ReadonlyMap<string, string>, reviewThreadIds: ReadonlyMap<string, string>, reviewInsightIds: ReadonlyMap<string, string>): { graphs: Record<string, unknown>; nodeIds: Map<string, string> } {
  const nodeIds = new Map<string, string>();
  const entries = (["systemOverview", "dataFlow", "codeDependency", "userAction"] as const).map((key) => {
    const value = graphs[key];
    if (!isRecord(value)) return [key, value] as const;
    const nodes = namespaceSemanticCollection(value.nodes, "graph-node", occupied);
    const edges = namespaceSemanticCollection(value.edges, "graph-edge", occupied);
    const tours = namespaceSemanticCollection(value.guidedTours, "graph-tour", occupied);
    for (const [source, id] of nodes.ids) if (!nodeIds.has(source)) nodeIds.set(source, id);
    return [key, {
      ...value,
      nodes: nodes.items.map((node) => ({ ...node, changeGroupIds: remapIds(node.changeGroupIds, changeGroupIds), testIds: remapIds(node.testIds, testIds), reviewThreadIds: remapIds(node.reviewThreadIds, reviewThreadIds), reviewInsightIds: remapIds(node.reviewInsightIds, reviewInsightIds) })),
      edges: edges.items.map((edge) => ({ ...edge, source: remapId(edge.source, nodes.ids), target: remapId(edge.target, nodes.ids), changeGroupIds: remapIds(edge.changeGroupIds, changeGroupIds), reviewThreadIds: remapIds(edge.reviewThreadIds, reviewThreadIds) })),
      guidedTours: tours.items.map((tour) => ({ ...tour, steps: Array.isArray(tour.steps) ? tour.steps.map((step) => !isRecord(step) ? step : { ...step, nodeId: remapId(step.nodeId, nodes.ids) }) : tour.steps })),
    }] as const;
  });
  return { graphs: Object.fromEntries(entries), nodeIds };
}
const NON_SYSTEM_GRAPH_KEYS = ["dataFlow", "codeDependency", "userAction"] as const;

function graphComponents(graph: Record<string, unknown>): string[][] {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const nodeIds = [...new Set(nodes.map((node) => node.id).filter(text))].sort((left, right) => left.localeCompare(right));
  if (nodeIds.length === 0) return [];
  const knownNodes = new Set(nodeIds);
  const adjacency = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  for (const edge of edges) {
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || !knownNodes.has(edge.source) || !knownNodes.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const remaining = new Set(nodeIds);
  const components: string[][] = [];
  while (remaining.size > 0) {
    const root = [...remaining][0];
    const component: string[] = [];
    const pending = [root];
    remaining.delete(root);
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) if (remaining.delete(neighbor)) pending.push(neighbor);
    }
    components.push(component.sort((left, right) => left.localeCompare(right)));
  }
  return components;
}

function disconnectedGraphErrors(graphs: Record<string, unknown>): string[] {
  return NON_SYSTEM_GRAPH_KEYS.flatMap((key) => {
    const graph = graphs[key];
    if (!isRecord(graph)) return [];
    const components = graphComponents(graph);
    return components.length > 1
      ? [`${key} graph is disconnected; components: ${components.map((component) => `[${component.join(", ")}]`).join(" ")}.`]
      : [];
  });
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
export function assembleAnchoredDocument(request: AnalysisRequest, anchor: SemanticAnchor, specialists: Record<"review" | "tests-risks" | "flows", AnchoredSpecialistOutput>, model?: string): { valid: boolean; document?: ReviewDocument; errors: string[] } {
  const relevant = anchor.domains.filter((domain) => domain.status !== "not-evidenced").map((domain) => domain.id);
  const coverage = new Map<AnchorDomainId, number>();
  for (const specialist of Object.values(specialists)) for (const entry of specialist.coverage) if (entry.status === "covered") coverage.set(entry.domainId, (coverage.get(entry.domainId) ?? 0) + 1);
  if (relevant.some((id) => !coverage.has(id))) return { valid: false, errors: ["At least one specialist must cover every relevant anchor domain."] };
  const refs = [...collectRefs(anchor), ...Object.values(specialists).flatMap((item) => collectRefs(item.content))];
  const evidenceByKey = new Map<string, CoordinatorEvidenceReference>();
  for (const ref of refs) evidenceByKey.set(evidenceKey(ref), ref);
  const canonicalReviews = canonicalReviewIds(specialists.review.content.reviewThreads);
  if (canonicalReviews.errors.length) return { valid: false, errors: canonicalReviews.errors };
  const occupiedSemanticIds = new Set(canonicalReviews.ids);
  const namespacedGroups = namespaceSemanticCollection(anchor.changeGroups, "group", occupiedSemanticIds);
  const evidenceEntries = [...evidenceByKey.entries()].sort(([left], [right]) => left.localeCompare(right));
  const ids = new Map<string, string>(); for (const [key, ref] of evidenceEntries) ids.set(key, nextUniqueId(evidenceId(ref), occupiedSemanticIds));
  const evidenceItems = evidenceEntries.map(([key, ref]) => ({ id: ids.get(key)!, kind: "file", title: `${ref.path}:${ref.line}`, path: ref.path, line: ref.line, url: null }));
  const review = canonicalizeEvidence(specialists.review.content, ids) as Record<string, unknown>;
  const tests = canonicalizeEvidence(specialists["tests-risks"].content, ids) as Record<string, unknown>;
  const flows = canonicalizeEvidence(specialists.flows.content, ids) as Record<string, unknown>;
  const groups = anchor.changeGroups.map((group, index) => ({ ...group, id: namespacedGroups.items[index]?.id, evidenceIds: group.evidence.map((ref) => ids.get(evidenceKey(ref))!), evidence: undefined }));
  const namespacedTests = namespaceSemanticCollection(tests.tests, "test", occupiedSemanticIds);
  const canonicalReviewThreads = (Array.isArray(review.reviewThreads) ? review.reviewThreads : []).filter(isRecord);
  const canonicalReviewThreadIds = new Map(canonicalReviewThreads.filter((thread) => text(thread.id)).map((thread) => [thread.id as string, thread.id as string]));
  const namespacedReviewInsights = namespaceSemanticCollection(review.reviewInsights, "review-insight", occupiedSemanticIds);
  const namespacedRisks = namespaceSemanticCollection(tests.risks, "risk", occupiedSemanticIds);
  const namespacedDependencies = namespaceSemanticCollection(review.dependencies, "dependency", occupiedSemanticIds);
  const namespacedUnchangedInteractions = namespaceSemanticCollection(review.unchangedInteractions, "unchanged-interaction", occupiedSemanticIds);
  const graphNamespace = isRecord(flows.graphs) ? namespaceGraphs(flows.graphs, occupiedSemanticIds, namespacedGroups.ids, namespacedTests.ids, canonicalReviewThreadIds, namespacedReviewInsights.ids) : undefined;
  const namespacedStories = namespaceSemanticCollection(anchor.stories, "story", occupiedSemanticIds);
  const stories = namespacedStories.items.map((story) => ({ ...story, changeGroupIds: remapIds(story.changeGroupIds, namespacedGroups.ids), dependsOnStoryIds: remapIds(story.dependsOnStoryIds, namespacedStories.ids) }));
  const primaryStoryId = remapId(anchor.primaryStoryId, namespacedStories.ids);
  const reviewPlan = remapIds(anchor.reviewPlan, namespacedStories.ids);
  const testsOutput = namespacedTests.items.map((test) => ({ ...test, changeGroupIds: remapIds(test.changeGroupIds, namespacedGroups.ids) }));
  const reviewThreads = canonicalReviewThreads.map((thread) => ({ ...thread, changeGroupIds: remapIds(thread.changeGroupIds, namespacedGroups.ids), graphNodeIds: remapIds(thread.graphNodeIds, graphNamespace?.nodeIds ?? new Map()), reviewInsightIds: remapIds(thread.reviewInsightIds, namespacedReviewInsights.ids) }));
  const reviewInsights = namespacedReviewInsights.items.map((insight) => ({ ...insight, changeGroupIds: remapIds(insight.changeGroupIds, namespacedGroups.ids), graphNodeIds: remapIds(insight.graphNodeIds, graphNamespace?.nodeIds ?? new Map()), reviewThreadIds: remapIds(insight.reviewThreadIds, canonicalReviewThreadIds) }));
  const risks = namespacedRisks.items.map((risk) => ({ ...risk, changeGroupIds: remapIds(risk.changeGroupIds, namespacedGroups.ids) }));
  const dependencies = namespacedDependencies.items.map((dependency) => ({ ...dependency, dependsOnIds: remapIds(dependency.dependsOnIds, namespacedDependencies.ids), changeGroupIds: remapIds(dependency.changeGroupIds, namespacedGroups.ids) }));
  const unchangedInteractions = namespacedUnchangedInteractions.items.map((interaction) => ({ ...interaction, changeGroupIds: remapIds(interaction.changeGroupIds, namespacedGroups.ids) }));
  const graphSource = graphNamespace?.graphs && Object.fromEntries(Object.entries(graphNamespace.graphs).map(([key, value]) => {
    if (!isRecord(value) || key === "systemOverview") return [key, value];
    const nodes = Array.isArray(value.nodes) ? value.nodes.map((rawNode) => {
      if (!isRecord(rawNode) || rawNode.changed !== true || !strings(rawNode.changeGroupIds)) return rawNode;
      const groupIds = new Set(rawNode.changeGroupIds as string[]);
      const relatedTestIds = (testsOutput as Record<string, unknown>[])
        .filter((test) => strings(test.changeGroupIds) && (test.changeGroupIds as string[]).some((id) => groupIds.has(id)))
        .map((test) => test.id)
        .filter(text) as string[];
      const declaredTestIds = strings(rawNode.testIds) ? rawNode.testIds as string[] : [];
      return { ...rawNode, testIds: [...new Set([...declaredTestIds, ...relatedTestIds])] };
    }) : value.nodes;
    return [key, { ...value, nodes }];
  }));
  if (!graphSource || !["systemOverview", "dataFlow", "codeDependency", "userAction"].every((key) => isRecord(graphSource[key]))) return { valid: false, errors: ["Flows specialist must provide exactly four graphs."] };
  const maxNodes = request.config?.maxGraphNodes ?? 80;
  for (const [key, id] of [["systemOverview", "system-overview"], ["dataFlow", "data-flow"], ["codeDependency", "code-dependency"], ["userAction", "user-action"]] as const) if (!validGraph(graphSource[key] as Record<string, unknown>, id, maxNodes)) return { valid: false, errors: [`${key} graph has invalid nodes, edges, tours, or node limit.`] };
  const connectivityErrors = disconnectedGraphErrors(graphSource);
  if (connectivityErrors.length > 0) return { valid: false, errors: connectivityErrors };
  const limitations = [...new Set([...(Array.isArray(review.limitations) ? review.limitations : []), ...(Array.isArray(tests.limitations) ? tests.limitations : [])].filter(text))];
  const document = {
    schemaVersion: "2.0.0", run: { id: "anchored-provider-run", createdAt: new Date().toISOString(), provider: request.provider, model: request.model ?? model ?? "default", skillVersion: "2.0.0" },
    pullRequest: { host: "github.com", repository: request.repository, number: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha },
    summary: { ...(isRecord(review.summary) ? review.summary : {}), limitations }, changeGroups: groups,
    stories, primaryStoryId, reviewPlan, graphs: graphSource,
    tests: testsOutput, reviewThreads, reviewInsights, evidence: evidenceItems,
    unchangedInteractions, risks, dependencies,
  } as unknown as ReviewDocument;
  const validation = validateReviewDocument(document);
  return validation.valid ? { valid: true, document: validation.document, errors: [] } : { valid: false, errors: validation.errors };
}

export function taskOutputFrom(result: AgentAnalysisResult): AnchoredTaskOutput | undefined { return result.taskOutput; }
