import AjvModule, { type ErrorObject } from "ajv";
import type { Graph, WalkthroughDocument } from "./contracts.js";

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

export const walkthroughSchema: Record<string, unknown> = {
  $id: "https://pr-atlas.local/schema/walkthrough/1.1.0",
  type: "object",
  additionalProperties: true,
  required: [
    "schemaVersion",
    "run",
    "pullRequest",
    "summary",
    "changeGroups",
    "walkthrough",
    "graphs",
    "tests",
    "reviewThreads",
    "reviewInsights",
    "evidence",
  ],
  properties: {
    schemaVersion: { const: "1.1.0", type: "string" },
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
    walkthrough: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "changeGroupId", "evidenceIds"],
        properties: {
          id: { ...nonEmptyString },
          title: { ...nonEmptyString },
          changeGroupId: { ...nonEmptyString },
          evidenceIds: { ...nonEmptyStringArray, minItems: 1 },
        },
      },
    },
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
          changeGroupIds: { ...nonEmptyStringArray },
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

const walkthroughItems = (
  (walkthroughSchema.properties as Record<string, unknown>)
    .walkthrough as Record<string, unknown>
).items as Record<string, unknown>;
walkthroughItems.required = [
  "id",
  "title",
  "reason",
  "summary",
  "limitations",
  "dependsOnStepIds",
  "changeGroupId",
  "flowNodeIds",
  "evidenceIds",
  "testIds",
  "reviewInsightIds",
];
walkthroughItems.properties = {
  ...(walkthroughItems.properties as Record<string, unknown>),
  reason: { ...nonEmptyString },
  summary: { ...nonEmptyString },
  limitations: { type: "array", items: { ...nonEmptyString } },
  dependsOnStepIds: { ...nonEmptyStringArray },
  flowNodeIds: { ...nonEmptyStringArray },
  testIds: { ...nonEmptyStringArray },
  reviewInsightIds: { ...nonEmptyStringArray },
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
const validate = ajv.compile(walkthroughSchema);
export interface WalkthroughValidation {
  valid: boolean;
  document?: WalkthroughDocument;
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
  const graphIds = new Map<string, string>();
  const register = (id: unknown, kind: string, index: number): void => {
    if (typeof id !== "string") return;
    const previous = graphIds.get(id);
    if (previous)
      errors.push(
        `duplicate graph id '${id}' in ${graphPath}.${kind}[${index}] and ${previous}.`,
      );
    else graphIds.set(id, `${graphPath}.${kind}[${index}]`);
  };
  graph.nodes.forEach((node, index) => register(node.id, "nodes", index));
  graph.edges.forEach((edge, index) => register(edge.id, "edges", index));
  graph.guidedTours.forEach((tour, index) =>
    register(tour.id, "guidedTours", index),
  );

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

export function validateWalkthroughDocument(
  value: unknown,
): WalkthroughValidation {
  if (!validate(value)) {
    const errors = (validate.errors ?? []).map(
      (error: ErrorObject) =>
        `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  }
  const document = value as WalkthroughDocument;
  const evidence = new Set(document.evidence.map((item) => item.id));
  const errors = evidenceReferences(document)
    .filter((reference) => !evidence.has(reference.id))
    .map(
      (reference) =>
        `${reference.path} references unknown evidence '${reference.id}'`,
    );
  const changeGroups = new Set(document.changeGroups.map((group) => group.id));
  for (const step of document.walkthrough)
    if (!changeGroups.has(step.changeGroupId))
      errors.push(
        `walkthrough '${step.id}' references unknown change group '${step.changeGroupId}'.`,
      );
  for (const test of document.tests)
    for (const changeGroupId of test.changeGroupIds ?? [])
      if (!changeGroups.has(changeGroupId))
        errors.push(
          `test '${test.id}' references unknown change group '${changeGroupId}'.`,
        );
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
  const stepIds = new Set(document.walkthrough.map((step) => step.id));
  for (const [index, step] of document.walkthrough.entries()) {
    for (const dependency of step.dependsOnStepIds ?? []) {
      if (!stepIds.has(dependency)) errors.push(`walkthrough '${step.id}' depends on unknown step '${dependency}'.`);
      else if (dependency === step.id) errors.push(`walkthrough '${step.id}' cannot depend on itself.`);
      else if (document.walkthrough.findIndex((candidate) => candidate.id === dependency) >= index) errors.push(`walkthrough '${step.id}' must depend only on an earlier step.`);
    }
  }
  for (const [index, step] of document.walkthrough.entries()) {
    const value = step as Record<string, unknown>;
    unresolvedRelations(
      value,
      `walkthrough[${index}]`,
      "flowNodeId",
      "flowNodeIds",
      graphNodeIds,
      errors,
    );
    unresolvedRelations(
      value,
      `walkthrough[${index}]`,
      "testId",
      "testIds",
      tests,
      errors,
    );
    unresolvedRelations(
      value,
      `walkthrough[${index}]`,
      "reviewInsightId",
      "reviewInsightIds",
      reviewInsights,
      errors,
    );
  }
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
      { collection: "walkthrough", items: document.walkthrough },
      { collection: "tests", items: document.tests },
      { collection: "reviewThreads", items: document.reviewThreads },
      { collection: "reviewInsights", items: document.reviewInsights },
      { collection: "evidence", items: document.evidence },
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
