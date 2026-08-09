import AjvModule, { type ErrorObject } from "ajv";
import type { Graph, ReviewDocument } from "./contracts.js";

const nonEmptyString = {
  type: "string",
  minLength: 1,
  pattern: "\\S",
} as const;
const nonEmptyStringArray = { type: "array", items: nonEmptyString } as const;
const nullableString = { anyOf: [nonEmptyString, { type: "null" }] } as const;
const nullableLine = {
  anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
} as const;
const supportedTestStatuses = ["covered", "partial", "missing"] as const;
const supportedReviewStatuses = [
  "active",
  "open",
  "resolved",
  "outdated",
  "disputed",
  "dismissed",
  "informational",
  "unknown",
] as const;
const supportedAttentionLevels = ["high", "medium", "low"] as const;

const reviewReplySchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "id",
    "author",
    "body",
    "authorAssociation",
    "createdAt",
    "updatedAt",
    "url",
    "path",
    "line",
    "originalLine",
    "side",
    "commitSha",
    "originalCommitSha",
  ],
  properties: {
    id: { ...nonEmptyString },
    author: { ...nonEmptyString },
    body: { ...nonEmptyString },
    authorAssociation: { ...nullableString },
    createdAt: { ...nullableString },
    updatedAt: { ...nullableString },
    url: { ...nullableString },
    path: { ...nullableString },
    line: { ...nullableLine },
    originalLine: { ...nullableLine },
    side: { ...nullableString },
    commitSha: { ...nullableString },
    originalCommitSha: { ...nullableString },
  },
} as const;

const graphSchema = (
  id: "system-overview" | "data-flow" | "code-dependency" | "user-action",
) => {
  const edgeCollection =
    id === "system-overview" ? { maxItems: 0 } : { minItems: 1 };
  return {
    type: "object",
    required: ["id", "description", "nodes", "edges", "guidedTours"],
    additionalProperties: true,
    properties: {
      id: { const: id, type: "string" },
      description: { ...nonEmptyString },
      nodes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          required: [
            "id",
            "label",
            "explanation",
            "changed",
            "changeGroupIds",
            "testIds",
            "reviewThreadIds",
            "reviewInsightIds",
            "evidenceIds",
          ],
          properties: {
            id: { ...nonEmptyString },
            label: { ...nonEmptyString },
            explanation: { ...nonEmptyString },
            changed: { type: "boolean" },
            changeGroupIds: { ...nonEmptyStringArray },
            testIds: { ...nonEmptyStringArray },
            reviewThreadIds: { ...nonEmptyStringArray },
            reviewInsightIds: { ...nonEmptyStringArray },
            evidenceIds: { ...nonEmptyStringArray },
            state: { type: "string", enum: ["changed", "context"] },
            type: { ...nonEmptyString },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      edges: {
        type: "array",
        ...edgeCollection,
        items: {
          type: "object",
          additionalProperties: true,
          required: [
            "id",
            "source",
            "target",
            "label",
            "evidenceIds",
            "changeGroupIds",
            "reviewThreadIds",
          ],
          properties: {
            id: { ...nonEmptyString },
            source: { ...nonEmptyString },
            target: { ...nonEmptyString },
            label: { ...nonEmptyString },
            evidenceIds: { ...nonEmptyStringArray },
            changeGroupIds: { ...nonEmptyStringArray },
            reviewThreadIds: { ...nonEmptyStringArray },
          },
        },
      },
      guidedTours: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          required: ["id", "title", "steps"],
          properties: {
            id: { ...nonEmptyString },
            title: { ...nonEmptyString },
            steps: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: true,
                required: ["nodeId", "title", "explanation"],
                properties: {
                  nodeId: { ...nonEmptyString },
                  title: { ...nonEmptyString },
                  explanation: { ...nonEmptyString },
                  evidenceIds: { ...nonEmptyStringArray },
                },
              },
            },
          },
        },
      },
    },
  };
};

/** The schema accepted for every persisted and newly generated review document. */
export const reviewDocumentSchema: Record<string, unknown> = {
  $id: "https://pr-atlas.local/schema/review/2.0.0",
  type: "object",
  additionalProperties: true,
  not: { required: ["walkthrough"] },
  required: [
    "schemaVersion",
    "run",
    "pullRequest",
    "summary",
    "changeGroups",
    "stories",
    "primaryStoryId",
    "reviewPlan",
    "graphs",
    "tests",
    "reviewThreads",
    "reviewInsights",
    "risks",
    "dependencies",
    "unchangedInteractions",
    "evidence",
  ],
  properties: {
    schemaVersion: { const: "2.0.0", type: "string" },
    run: {
      type: "object",
      additionalProperties: true,
      required: ["id", "createdAt", "provider", "model", "skillVersion"],
      properties: {
        id: { ...nonEmptyString },
        createdAt: { ...nonEmptyString },
        provider: { ...nonEmptyString },
        model: { ...nonEmptyString },
        skillVersion: { ...nonEmptyString },
      },
    },
    pullRequest: {
      type: "object",
      additionalProperties: true,
      required: ["host", "repository", "number", "baseSha", "headSha"],
      properties: {
        host: { const: "github.com", type: "string" },
        repository: { ...nonEmptyString },
        number: { type: "integer", minimum: 1 },
        baseSha: { ...nonEmptyString },
        headSha: { ...nonEmptyString },
      },
    },
    summary: {
      type: "object",
      additionalProperties: true,
      required: [
        "intent",
        "behavioralChanges",
        "architecturalImpact",
        "limitations",
      ],
      properties: {
        intent: { ...nonEmptyString },
        behavioralChanges: { type: "array", items: { ...nonEmptyString } },
        architecturalImpact: { type: "array", items: { ...nonEmptyString } },
        limitations: { type: "array", items: { ...nonEmptyString } },
      },
    },
    changeGroups: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "title",
          "summary",
          "motivation",
          "previousBehavior",
          "newBehavior",
          "attention",
          "evidenceIds",
        ],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          summary: { ...nonEmptyString },
          motivation: { ...nonEmptyString },
          previousBehavior: { ...nonEmptyString },
          newBehavior: { ...nonEmptyString },
          attention: { type: "string", enum: [...supportedAttentionLevels] },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
    stories: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "title",
          "summary",
          "relationshipToPrimary",
          "relationshipRationale",
          "reviewReason",
          "changeGroupIds",
          "dependsOnStoryIds",
        ],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          summary: { ...nonEmptyString },
          relationshipToPrimary: {
            type: "string",
            enum: ["primary", "supporting", "adjacent", "independent"],
          },
          relationshipRationale: { ...nonEmptyString },
          reviewReason: { ...nonEmptyString },
          changeGroupIds: { ...nonEmptyStringArray, minItems: 1 },
          dependsOnStoryIds: { ...nonEmptyStringArray },
        },
      },
    },
    primaryStoryId: { ...nonEmptyString },
    reviewPlan: { type: "array", minItems: 1, items: { ...nonEmptyString } },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "title",
          "behavior",
          "status",
          "evidenceIds",
          "changeGroupIds",
        ],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          behavior: { ...nonEmptyString },
          status: { type: "string", enum: [...supportedTestStatuses] },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
          changeGroupIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
    reviewThreads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "status",
          "provenance",
          "evidenceIds",
          "author",
          "body",
          "replies",
          "replyCount",
          "url",
          "resolvedBy",
          "authorAssociation",
          "path",
          "line",
          "originalLine",
          "side",
          "startLine",
          "originalStartLine",
          "commitSha",
          "originalCommitSha",
          "createdAt",
          "updatedAt",
          "changeGroupIds",
          "graphNodeIds",
          "reviewInsightIds",
        ],
        properties: {
          id: { ...nonEmptyString },
          status: { type: "string", enum: [...supportedReviewStatuses] },
          provenance: { ...nonEmptyString },
          evidenceIds: { ...nonEmptyStringArray },
          author: { ...nonEmptyString },
          body: { ...nonEmptyString },
          replies: { type: "array", items: reviewReplySchema },
          replyCount: { type: "integer", minimum: 0 },
          url: { ...nullableString },
          resolvedBy: { ...nullableString },
          authorAssociation: { ...nullableString },
          path: { ...nullableString },
          line: { ...nullableLine },
          originalLine: { ...nullableLine },
          side: { ...nullableString },
          startLine: { ...nullableLine },
          originalStartLine: { ...nullableLine },
          commitSha: { ...nullableString },
          originalCommitSha: { ...nullableString },
          createdAt: { ...nullableString },
          updatedAt: { ...nullableString },
          changeGroupIds: { ...nonEmptyStringArray },
          graphNodeIds: { ...nonEmptyStringArray },
          reviewInsightIds: { ...nonEmptyStringArray },
        },
      },
    },
    reviewInsights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "title",
          "detail",
          "status",
          "provenance",
          "evidenceIds",
          "changeGroupIds",
          "reviewThreadIds",
          "graphNodeIds",
        ],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          detail: { ...nonEmptyString },
          status: { type: "string", enum: [...supportedReviewStatuses] },
          provenance: { ...nonEmptyString },
          evidenceIds: { ...nonEmptyStringArray },
          changeGroupIds: { ...nonEmptyStringArray },
          reviewThreadIds: { ...nonEmptyStringArray },
          graphNodeIds: { ...nonEmptyStringArray },
          category: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          attention: { type: "string", enum: [...supportedAttentionLevels] },
          recommendedAction: { type: "string", minLength: 1 },
        },
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "detail", "changeGroupIds", "evidenceIds"],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          detail: { ...nonEmptyString },
          changeGroupIds: { ...nonEmptyStringArray, minItems: 1 },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "detail", "dependsOnIds", "changeGroupIds", "evidenceIds"],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          detail: { ...nonEmptyString },
          dependsOnIds: { ...nonEmptyStringArray },
          changeGroupIds: { ...nonEmptyStringArray, minItems: 1 },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
    unchangedInteractions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "detail", "changeGroupIds", "evidenceIds"],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          detail: { ...nonEmptyString },
          changeGroupIds: { ...nonEmptyStringArray, minItems: 1 },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
    graphs: {
      type: "object",
      additionalProperties: true,
      required: ["systemOverview", "dataFlow", "codeDependency", "userAction"],
      properties: {
        systemOverview: graphSchema("system-overview"),
        dataFlow: graphSchema("data-flow"),
        codeDependency: graphSchema("code-dependency"),
        userAction: graphSchema("user-action"),
      },
    },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "kind", "title", "path", "line", "url"],
        properties: {
          id: { ...nonEmptyString },
          kind: { ...nonEmptyString },
          title: { ...nonEmptyString },
          path: { ...nonEmptyString },
          line: { ...nullableLine },
          url: { ...nullableString },
        },
      },
    },
  },
};

const Ajv = AjvModule as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile(
    schema: unknown,
  ): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(reviewDocumentSchema);
export interface ReviewDocumentValidation {
  valid: boolean;
  document?: ReviewDocument;
  errors: string[];
}

function evidenceReferences(
  value: unknown,
  path = "$",
): Array<{ path: string; id: string }> {
  if (Array.isArray(value))
    return value.flatMap((entry, index) =>
      evidenceReferences(entry, `${path}[${index}]`),
    );
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const next = `${path}.${key}`;
      if (
        (key === "evidenceId" || key === "evidenceRef") &&
        typeof entry === "string"
      )
        return [{ path: next, id: entry }];
      if (
        (key === "evidenceIds" || key === "evidenceRefs") &&
        Array.isArray(entry)
      )
        return entry
          .filter((id): id is string => typeof id === "string")
          .map((id) => ({ path: next, id }));
      return evidenceReferences(entry, next);
    },
  );
}

function duplicateIds(
  values: Array<{ collection: string; items: Array<{ id?: unknown }> }>,
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const collection of values) {
    for (const [index, item] of collection.items.entries()) {
      if (typeof item.id !== "string") continue;
      const previous = seen.get(item.id);
      if (previous)
        errors.push(
          `duplicate semantic id '${item.id}' in ${collection.collection}[${index}] and ${previous}.`,
        );
      else seen.set(item.id, `${collection.collection}[${index}]`);
    }
  }
  return errors;
}

function relationValues(
  value: Record<string, unknown>,
  singular: string,
  plural: string,
): Array<{ path: string; id: string }> {
  const references: Array<{ path: string; id: string }> = [];
  const one = value[singular];
  if (typeof one === "string")
    references.push({ path: `.${singular}`, id: one });
  const many = value[plural];
  if (Array.isArray(many))
    many.forEach((id, index) => {
      if (typeof id === "string")
        references.push({ path: `.${plural}[${index}]`, id });
    });
  return references;
}

function unresolvedRelations(
  value: Record<string, unknown>,
  path: string,
  singular: string,
  plural: string,
  known: Set<string>,
  errors: string[],
): void {
  for (const reference of relationValues(value, singular, plural)) {
    if (!known.has(reference.id))
      errors.push(
        `${path}${reference.path} references unknown '${reference.id}'.`,
      );
  }
}

function graphValidation(
  graph: Graph,
  graphPath: string,
  errors: string[],
  changeGroups: Set<string>,
  tests: Set<string>,
  reviewThreads: Set<string>,
  reviewInsights: Set<string>,
): void {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const edges = new Set(
    graph.edges.flatMap((edge) =>
      typeof edge.id === "string" ? [edge.id] : [],
    ),
  );
  const tours = new Set(graph.guidedTours.map((tour) => tour.id));

  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target))
      errors.push(`${graphPath} has an edge with an unknown node.`);
  }
  for (const tour of graph.guidedTours) {
    for (const step of tour.steps)
      if (!nodes.has(step.nodeId))
        errors.push(
          `${graphPath} tour '${tour.id}' references unknown node '${step.nodeId}'.`,
        );
  }

  const graphItems: Array<{ path: string; value: Record<string, unknown> }> =
    [];
  graph.nodes.forEach((node, index) =>
    graphItems.push({
      path: `${graphPath}.nodes[${index}]`,
      value: node as Record<string, unknown>,
    }),
  );
  graph.edges.forEach((edge, index) =>
    graphItems.push({
      path: `${graphPath}.edges[${index}]`,
      value: edge as Record<string, unknown>,
    }),
  );
  graph.guidedTours.forEach((tour, index) =>
    graphItems.push({
      path: `${graphPath}.guidedTours[${index}]`,
      value: tour as Record<string, unknown>,
    }),
  );
  for (const item of graphItems) {
    unresolvedRelations(
      item.value,
      item.path,
      "changeGroupId",
      "changeGroupIds",
      changeGroups,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "testId",
      "testIds",
      tests,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "reviewThreadId",
      "reviewThreadIds",
      reviewThreads,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "reviewInsightId",
      "reviewInsightIds",
      reviewInsights,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "nodeId",
      "nodeIds",
      nodes,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "edgeId",
      "edgeIds",
      edges,
      errors,
    );
    unresolvedRelations(
      item.value,
      item.path,
      "tourId",
      "tourIds",
      tours,
      errors,
    );
  }
  if (graph.id === "system-overview") {
    for (const [index, node] of graph.nodes.entries()) {
      if (node.changed)
        errors.push(
          `${graphPath}.nodes[${index}] must be contextual and unchanged.`,
        );
      const value = node as Record<string, unknown>;
      for (const key of [
        "changeGroupIds",
        "testIds",
        "reviewThreadIds",
        "reviewInsightIds",
        "evidenceIds",
      ]) {
        if (Array.isArray(value[key]) && value[key].length > 0)
          errors.push(
            `${graphPath}.nodes[${index}].${key} must be empty for the PR-agnostic system graph.`,
          );
      }
    }
  }
  for (const [index, node] of graph.nodes.entries()) {
    const value = node as Record<string, unknown>;
    if (
      value.changed === true &&
      Array.isArray(value.changeGroupIds) &&
      value.changeGroupIds.length === 0
    )
      errors.push(
        `${graphPath}.nodes[${index}].changeGroupIds must identify the changed node's groups.`,
      );
    if (
      typeof value.state === "string" &&
      (value.state === "changed") !== (value.changed === true)
    )
      errors.push(`${graphPath}.nodes[${index}].state disagrees with changed.`);
  }
}

export function validateReviewDocument(
  value: unknown,
): ReviewDocumentValidation {
  if (!validate(value)) {
    const errors = (validate.errors ?? []).map(
      (error: ErrorObject) =>
        `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  }
  const document = value as ReviewDocument;
  const evidence = new Set(document.evidence.map((item) => item.id));
  const errors = evidenceReferences(document)
    .filter((reference) => !evidence.has(reference.id))
    .map(
      (reference) =>
        `${reference.path} references unknown evidence '${reference.id}'`,
    );
  const changeGroups = new Set(document.changeGroups.map((group) => group.id));
  const storyIds = new Set(document.stories.map((story) => story.id));
  const primaryStories = document.stories.filter((story) => story.relationshipToPrimary === "primary");
  if (primaryStories.length !== 1 || primaryStories[0]?.id !== document.primaryStoryId)
    errors.push("schema 2.0 requires exactly one primary story matching primaryStoryId.");
  if (document.reviewPlan.length !== document.stories.length || new Set(document.reviewPlan).size !== document.reviewPlan.length || document.reviewPlan.some((id) => !storyIds.has(id)))
    errors.push("reviewPlan must contain every known story exactly once.");
  else if (document.reviewPlan[0] !== document.primaryStoryId)
    errors.push("reviewPlan must begin with primaryStoryId.");
  const owner = new Map<string, string>();
  for (const story of document.stories) {
    for (const groupId of story.changeGroupIds) {
      if (!changeGroups.has(groupId)) errors.push(`story '${story.id}' references unknown change group '${groupId}'.`);
      else if (owner.has(groupId)) errors.push(`change group '${groupId}' belongs to exactly one story (also '${owner.get(groupId)}').`);
      else owner.set(groupId, story.id);
    }
    for (const dependency of story.dependsOnStoryIds) {
      const current = document.reviewPlan.indexOf(story.id);
      const prior = document.reviewPlan.indexOf(dependency);
      if (!storyIds.has(dependency)) errors.push(`story '${story.id}' depends on unknown story '${dependency}'.`);
      else if (dependency === story.id) errors.push(`story '${story.id}' cannot depend on itself.`);
      else if (prior >= current) errors.push(`story '${story.id}' must depend only on an earlier reviewPlan story.`);
    }
  }
  for (const groupId of changeGroups) if (!owner.has(groupId)) errors.push(`change group '${groupId}' must belong to exactly one story.`);
  for (const test of document.tests) {
    if (test.changeGroupIds.length === 0)
      errors.push(`test '${test.id}' must reference at least one change group.`);
    for (const changeGroupId of test.changeGroupIds ?? [])
      if (!changeGroups.has(changeGroupId))
        errors.push(
          `test '${test.id}' references unknown change group '${changeGroupId}'.`,
        );
  }
  const relationshipCollections: Array<{
    name: "risks" | "dependencies" | "unchangedInteractions";
    items: Array<Record<string, unknown>>;
  }> = [
    { name: "risks", items: document.risks },
    { name: "dependencies", items: document.dependencies },
    { name: "unchangedInteractions", items: document.unchangedInteractions },
  ];
  for (const collection of relationshipCollections) {
    collection.items.forEach((item, index) => {
      if (!Array.isArray(item.changeGroupIds) || item.changeGroupIds.length === 0)
        errors.push(`${collection.name}[${index}].changeGroupIds must not be empty.`);
      if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0)
        errors.push(`${collection.name}[${index}].evidenceIds must not be empty.`);
      unresolvedRelations(
        item,
        `${collection.name}[${index}]`,
        "changeGroupId",
        "changeGroupIds",
        changeGroups,
        errors,
      );
    });
  }
  const dependencyIds = new Set(document.dependencies.map((dependency) => dependency.id));
  for (const [index, dependency] of document.dependencies.entries()) {
    for (const target of dependency.dependsOnIds) {
      if (!dependencyIds.has(target))
        errors.push(`dependencies[${index}].dependsOnIds references unknown dependency '${target}'.`);
      else if (target === dependency.id)
        errors.push(`dependency '${dependency.id}' cannot depend on itself.`);
    }
  }
  const dependencyVisit = new Map<string, "visiting" | "visited">();
  const dependencyById = new Map(document.dependencies.map((dependency) => [dependency.id, dependency]));
  const visitDependency = (id: string): void => {
    if (dependencyVisit.get(id) === "visiting") {
      errors.push(`dependencies contain a cycle through '${id}'.`);
      return;
    }
    if (dependencyVisit.get(id) === "visited") return;
    dependencyVisit.set(id, "visiting");
    for (const target of dependencyById.get(id)?.dependsOnIds ?? [])
      if (dependencyById.has(target)) visitDependency(target);
    dependencyVisit.set(id, "visited");
  };
  for (const id of dependencyIds) visitDependency(id);
  const reviewThreads = new Set(
    document.reviewThreads.map((thread) => thread.id),
  );
  const tests = new Set(document.tests.map((test) => test.id));
  const reviewInsights = new Set(
    document.reviewInsights.map((insight) => insight.id),
  );
  const graphs = [
    document.graphs.systemOverview,
    document.graphs.dataFlow,
    document.graphs.codeDependency,
    document.graphs.userAction,
  ] as Graph[];
  const graphNodeIds = new Set(
    graphs.flatMap((graph) => graph.nodes.map((node) => node.id)),
  );
  for (const thread of document.reviewThreads) {
    const value = thread as unknown as Record<string, unknown>;
    const threadPath = `reviewThreads[${document.reviewThreads.indexOf(thread)}]`;
    unresolvedRelations(
      value,
      threadPath,
      "changeGroupId",
      "changeGroupIds",
      changeGroups,
      errors,
    );
    unresolvedRelations(
      value,
      threadPath,
      "graphNodeId",
      "graphNodeIds",
      graphNodeIds,
      errors,
    );
    unresolvedRelations(
      value,
      threadPath,
      "reviewInsightId",
      "reviewInsightIds",
      reviewInsights,
      errors,
    );
    if (Array.isArray(value.replies))
      errors.push(
        ...duplicateIds([
          {
            collection: `${threadPath}.replies`,
            items: value.replies as Array<{ id?: unknown }>,
          },
        ]),
      );
  }
  for (const insight of document.reviewInsights) {
    for (const threadId of insight.reviewThreadIds ?? [])
      if (!reviewThreads.has(threadId))
        errors.push(
          `review insight '${insight.id}' references unknown review thread '${threadId}'.`,
        );
    for (const changeGroupId of insight.changeGroupIds ?? [])
      if (!changeGroups.has(changeGroupId))
        errors.push(
          `review insight '${insight.id}' references unknown change group '${changeGroupId}'.`,
        );
    const value = insight as unknown as Record<string, unknown>;
    unresolvedRelations(
      value,
      `reviewInsights[${document.reviewInsights.indexOf(insight)}]`,
      "graphNodeId",
      "graphNodeIds",
      graphNodeIds,
      errors,
    );
  }
  errors.push(
    ...duplicateIds([
      { collection: "changeGroups", items: document.changeGroups },
      { collection: "stories", items: document.stories },
      { collection: "tests", items: document.tests },
      { collection: "reviewThreads", items: document.reviewThreads },
      { collection: "reviewInsights", items: document.reviewInsights },
      { collection: "risks", items: document.risks },
      { collection: "dependencies", items: document.dependencies },
      { collection: "unchangedInteractions", items: document.unchangedInteractions },
      { collection: "evidence", items: document.evidence },
      ...graphs.flatMap((graph) => [
        { collection: `graphs.${graph.id}.nodes`, items: graph.nodes },
        { collection: `graphs.${graph.id}.edges`, items: graph.edges },
        { collection: `graphs.${graph.id}.guidedTours`, items: graph.guidedTours },
      ]),
    ]),
  );
  for (const graph of graphs) {
    graphValidation(
      graph,
      `graphs.${graph.id}`,
      errors,
      changeGroups,
      tests,
      reviewThreads,
      reviewInsights,
    );
  }
  if (document.graphs.systemOverview.edges.length !== 0)
    errors.push(
      "graphs.systemOverview must be PR-agnostic and contain zero edges.",
    );
  return errors.length
    ? { valid: false, errors }
    : { valid: true, document, errors: [] };
}
