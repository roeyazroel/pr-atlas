import type { ChangeGroup, Flow, PullRequest, ReviewStory } from "./types";

export type ReviewRelationship =
  | "primary"
  | "supporting"
  | "adjacent"
  | "independent";

export interface ReviewStoryModel {
  id: string;
  title: string;
  summary: string;
  relationshipToPrimary: ReviewRelationship;
  relationshipRationale: string;
  reviewReason: string;
  changeGroupIds: string[];
  dependsOnStoryIds: string[];
  groups: ChangeGroup[];
  flowTraces: ReviewFlowTrace[];
}

export interface ReviewFlowTrace {
  type: Flow["type"];
  label: string;
  nodeId?: string;
  changeGroupIds?: string[];
}

export interface ReviewArchitecture {
  kind: "schema-2" | "empty";
  schemaVersion: string;
  primaryStoryId?: string;
  stories: ReviewStoryModel[];
}

export interface RecommendedReviewEntry {
  id: string;
  title: string;
  reason: string;
  groupIds: string[];
  groupCount: number;
  attention: ChangeGroup["attention"];
}

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value : fallback;
const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function mapGroup(raw: unknown, index: number): ChangeGroup {
  const item = objectValue(raw);
  const attention = safeString(item.attention, "medium");
  return {
    id: safeString(item.id, `change-${index + 1}`),
    title: safeString(item.title, `Change group ${index + 1}`),
    description: safeString(
      item.summary ?? item.description,
      "No group summary provided.",
    ),
    attention: (attention === "high" || attention === "low"
      ? attention
      : "medium") as ChangeGroup["attention"],
    files: stringArray(item.files),
    before: safeString(
      item.previousBehavior ?? item.before,
      "Previous behavior is not specified.",
    ),
    after: safeString(
      item.newBehavior ?? item.after,
      "New behavior is not specified.",
    ),
    rationale: safeString(
      item.motivation ?? item.rationale,
      "The review did not provide a motivation.",
    ),
    reviewed: false,
    evidenceIds: stringArray(item.evidenceIds),
  };
}

const graphTypeFor = (key: string, id: string): Flow["type"] => {
  if (id === "system-overview" || key === "systemOverview") return "system-overview";
  if (id === "code-dependency" || key === "codeDependency") return "code-dependency";
  if (id === "user-action" || key === "userAction") return "user-action";
  return "data-flow";
};

const graphLabel = (type: Flow["type"]) =>
  type === "system-overview"
    ? "System overview"
    : type === "data-flow"
      ? "Data flow"
      : type === "code-dependency"
        ? "Code dependency"
        : "User action";

/** Derive at most one friendly trace for each graph type for the requested group ids. */
export function deriveReviewFlowTraces(document: unknown, changeGroupIds: string[]): ReviewFlowTrace[] {
  const graphs = objectValue(objectValue(document).graphs);
  const wanted = new Set(changeGroupIds);
  const traces: ReviewFlowTrace[] = [];
  for (const [key, rawGraph] of Object.entries(graphs)) {
    const graph = objectValue(rawGraph);
    const graphId = safeString(graph.id, key);
    const type = graphTypeFor(key, graphId);
    if (traces.some((trace) => trace.type === type)) continue;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(objectValue) : [];
    const labels = new Map(
      nodes.map((node) => [
        safeString(node.id),
        safeString(node.label ?? node.title, "Related behavior"),
      ]),
    );
    const edges = Array.isArray(graph.edges) ? graph.edges.map(objectValue) : [];
    const nodeFor = (id: unknown) =>
      nodes.find((candidate) => safeString(candidate.id) === safeString(id));
    const ownsRequestedGroup = (candidate: Record<string, unknown> | undefined) =>
      candidate !== undefined && stringArray(candidate.changeGroupIds).some((id) => wanted.has(id));
    const edge = edges.find((candidate) => {
      if (!stringArray(candidate.changeGroupIds).some((id) => wanted.has(id)))
        return false;
      const sourceNode = nodeFor(candidate.source);
      const targetNode = nodeFor(candidate.target);
      // Context-only endpoints may legitimately be unowned, but an edge whose
      // endpoints are explicitly owned by another group is not a trace for the
      // requested group even when a stale edge relation says otherwise.
      const endpointClaimsAnotherGroup = [sourceNode, targetNode].some((node) => {
        const groups = stringArray(node?.changeGroupIds);
        return groups.length > 0 && !groups.some((id) => wanted.has(id));
      });
      return !endpointClaimsAnotherGroup || ownsRequestedGroup(sourceNode) || ownsRequestedGroup(targetNode);
    });
    const node = nodes.find((candidate) =>
      stringArray(candidate.changeGroupIds).some((id) => wanted.has(id)),
    );
    if (!edge && !node) continue;
    const source = edge ? labels.get(safeString(edge.source)) : undefined;
    const target = edge ? labels.get(safeString(edge.target)) : undefined;
    const sourceNode = edge ? nodeFor(edge.source) : undefined;
    const targetNode = edge ? nodeFor(edge.target) : undefined;
    const actionNodeId = edge
      ? ownsRequestedGroup(sourceNode)
        ? safeString(edge.source)
        : ownsRequestedGroup(targetNode)
          ? safeString(edge.target)
          : undefined
      : node
        ? safeString(node.id)
        : undefined;
    const transition = edge ? safeString(edge.label, "continues") : undefined;
    let label = source && transition
      ? `${source} → ${transition}${target && target !== source ? ` → ${target}` : ""}`
      : target ?? source ?? (node ? labels.get(safeString(node.id)) : undefined) ?? "Related behavior";
    if (!label.trim() || /^(?:[\w-]+-)+(?:node|edge)\b/i.test(label))
      label = graphLabel(type);
    traces.push({
      type,
      label,
      ...(actionNodeId ? { nodeId: actionNodeId } : {}),
      changeGroupIds: edge
        ? stringArray(edge.changeGroupIds)
        : node
          ? stringArray(node.changeGroupIds)
          : [],
    });
  }
  return traces.slice(0, 4);
}

/**
 * Turns the validated provider payload into the small, relationship-first model
 * used by the Review surface. It accepts unknown input deliberately so malformed
 * artifacts fail closed and forward-compatible contract additions remain renderable.
 */
export function buildReviewArchitecture(document: unknown): ReviewArchitecture {
  const payload = objectValue(document);
  const schemaVersion = safeString(payload.schemaVersion, "");
  const rawGroups = Array.isArray(payload.changeGroups)
    ? payload.changeGroups.map(mapGroup)
    : [];
  if (schemaVersion !== "2.0.0") {
    return {
      kind: "empty",
      schemaVersion: schemaVersion || "unknown",
      stories: [],
    };
  }

  const groupsById = new Map(rawGroups.map((group) => [group.id, group]));
  const rawStories = Array.isArray(payload.stories) ? payload.stories : [];
  const reviewPlan = stringArray(payload.reviewPlan);
  const order = new Map(reviewPlan.map((id, index) => [id, index]));
  const stories = rawStories
    .map((raw, index) => {
      const item = objectValue(raw);
      const relationship = safeString(
        item.relationshipToPrimary,
        "independent",
      );
      const groupIds = stringArray(item.changeGroupIds);
      return {
        id: safeString(item.id, `story-${index + 1}`),
        title: safeString(item.title, `Review story ${index + 1}`),
        summary: safeString(item.summary, "No story summary provided."),
        relationshipToPrimary: (relationship === "primary" || relationship === "supporting" || relationship === "adjacent"
          ? relationship
          : "independent") as ReviewRelationship,
        relationshipRationale: safeString(
          item.relationshipRationale,
          "No relationship rationale provided.",
        ),
        reviewReason: safeString(
          item.reviewReason,
          "Review the evidence linked to this story.",
        ),
        changeGroupIds: groupIds,
        dependsOnStoryIds: stringArray(item.dependsOnStoryIds),
        groups: groupIds.flatMap((id) => {
          const group = groupsById.get(id);
          return group ? [group] : [];
        }),
        flowTraces: deriveReviewFlowTraces(document, groupIds),
      } satisfies ReviewStoryModel;
    })
    .sort((left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  return {
    kind: "schema-2",
    schemaVersion,
    primaryStoryId: safeString(payload.primaryStoryId) || undefined,
    stories,
  };
}

const attentionRank: Record<ChangeGroup["attention"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Collapse the atomic groups belonging to each story into one review-order row. */
export function buildRecommendedReviewOrder(
  architecture: ReviewArchitecture,
): RecommendedReviewEntry[] {
  return architecture.stories.map((story) => {
    const attention = story.groups.reduce<ChangeGroup["attention"]>(
      (highest, group) =>
        attentionRank[group.attention] > attentionRank[highest]
          ? group.attention
          : highest,
      "low",
    );
    return {
      id: story.id,
      title: story.title,
      reason: story.reviewReason,
      groupIds: [...story.changeGroupIds],
      groupCount: story.changeGroupIds.length,
      attention: story.groups.length ? attention : "medium",
    };
  });
}

export function buildReviewArchitectureFromPullRequest(pr: Pick<PullRequest, "walkthrough">): ReviewArchitecture {
  return buildReviewArchitecture(pr.walkthrough);
}

/**
 * Return the canonical story collection for a pull request's flow surface.
 * Persisted mapped stories win; fixture/live records that only carry the
 * validated walkthrough derive the same projection without creating a second
 * source of truth.
 */
export function buildReviewStoriesForPullRequest(
  pr: Pick<PullRequest, "stories" | "walkthrough">,
): ReviewStory[] {
  if (pr.stories?.length) return pr.stories;
  return buildReviewArchitectureFromPullRequest(pr).stories.map((story) => ({
    id: story.id,
    title: story.title,
    summary: story.summary,
    relationshipToPrimary: story.relationshipToPrimary,
    relationshipRationale: story.relationshipRationale,
    reviewReason: story.reviewReason,
    changeGroupIds: [...story.changeGroupIds],
    dependsOnStoryIds: [...story.dependsOnStoryIds],
  }));
}
