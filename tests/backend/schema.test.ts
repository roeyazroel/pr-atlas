import { describe, expect, it } from "vitest";
import { validateReviewDocument } from "../../shared/schema";

const validWalkthrough = () => ({
  schemaVersion: "2.0.0",
  run: {
    id: "run_123",
    createdAt: "2026-08-04T19:00:00.000Z",
    provider: "fake",
    model: "test-model",
    skillVersion: "1.0.0",
  },
  pullRequest: {
    host: "github.com",
    repositoryId: "R_123",
    repository: "example/backend",
    number: 481,
    title: "Move authentication to session service",
    baseRef: "main",
    headRef: "feature/session-service",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    author: "developer",
  },
  summary: {
    intent: "Move session ownership into the authentication service.",
    behavioralChanges: [] as string[],
    architecturalImpact: [] as string[],
    limitations: [] as string[],
  },
  changeGroups: [
    {
      id: "group-session",
      title: "Session ownership",
      summary: "Moves session state into the service.",
      motivation: "Keep session ownership at one boundary.",
      previousBehavior: "The web client owned session state.",
      newBehavior: "The session service owns session state.",
      attention: "high",
      evidenceIds: ["e-session"],
    },
  ],
  stories: [
    {
      id: "story-session",
      title: "Move session ownership",
      summary: "The service becomes the behavioral owner.",
      relationshipToPrimary: "primary",
      relationshipRationale: "This is the user-visible change under review.",
      reviewReason: "Review the ownership boundary before related details.",
      changeGroupIds: ["group-session"],
      dependsOnStoryIds: [],
    },
  ],
  primaryStoryId: "story-session",
  reviewPlan: ["story-session"],
  graphs: {
    systemOverview: graph("systemOverview"),
    dataFlow: graph("dataFlow"),
    codeDependency: graph("codeDependency"),
    userAction: graph("userAction"),
  },
  tests: [
    {
      id: "test-session",
      status: "covered",
      evidenceIds: ["e-session"],
      changeGroupIds: ["group-session"],
      title: "Session behavior",
      behavior: "Session creation is covered.",
    },
  ],
  reviewThreads: [] as Array<ReturnType<typeof reviewThread>>,
  reviewInsights: [] as Array<ReturnType<typeof reviewInsight>>,
  risks: [] as Array<{ id: string; title: string; detail: string; changeGroupIds: string[]; evidenceIds: string[] }>,
  dependencies: [] as Array<{ id: string; title: string; detail: string; dependsOnIds: string[]; changeGroupIds: string[]; evidenceIds: string[] }>,
  unchangedInteractions: [] as Array<{ id: string; title: string; detail: string; changeGroupIds: string[]; evidenceIds: string[] }>,
  evidence: [
    {
      id: "e-session",
      kind: "file",
      title: "Session service",
      path: "src/session/service.ts",
      line: null,
      url: null,
      locator: "src/session/service.ts:42",
    },
  ],
});

function graph(id: string) {
  const graphId = id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const system = graphId === "system-overview";
  return {
    id: graphId,
    description: `Explains the ${graphId} graph.`,
    nodes: [
      {
        id: `${graphId}-source`,
        label: "Source node",
        explanation: "A relevant source node.",
        changed: !system,
        changeGroupIds: system ? [] : ["group-session"],
        testIds: [],
        reviewThreadIds: [],
        reviewInsightIds: [],
        evidenceIds: system ? [] : ["e-session"],
      },
      {
        id: `${graphId}-target`,
        label: "Target node",
        explanation: "A relevant target node.",
        changed: !system,
        changeGroupIds: system ? [] : ["group-session"],
        testIds: [],
        reviewThreadIds: [],
        reviewInsightIds: [],
        evidenceIds: system ? [] : ["e-session"],
      },
    ],
    edges: system
      ? []
      : [
          {
            id: `${graphId}-edge`,
            source: `${graphId}-source`,
            target: `${graphId}-target`,
            label: "leads to",
            evidenceIds: ["e-session"],
            changeGroupIds: ["group-session"],
            reviewThreadIds: [],
          },
        ],
    guidedTours: [
      {
        id: `${graphId}-tour`,
        title: "Review this graph",
        steps: [
          {
            nodeId: `${graphId}-source`,
            title: "Inspect source",
            explanation: "Trace the source node.",
          },
          {
            nodeId: `${graphId}-target`,
            title: "Inspect target",
            explanation: "Trace the target node.",
          },
        ],
      },
    ],
  };
}

describe("walkthrough schema validation", () => {
  it("rejects the retired 1.1 walkthrough document shape", () => {
    const retired = validWalkthrough() as Record<string, unknown>;
    retired.schemaVersion = "1.1.0";
    delete retired.stories;
    delete retired.primaryStoryId;
    delete retired.reviewPlan;
    retired.walkthrough = [{ id: "step-session", changeGroupId: "group-session" }];
    expect(validateReviewDocument(retired).valid).toBe(false);
  });

  it("rejects persisted walkthrough steps even when the declared version is 2.0", () => {
    const document = validWalkthrough() as Record<string, unknown>;
    document.walkthrough = [{ id: "retired-step", changeGroupId: "group-session" }];

    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("accepts a complete versioned walkthrough with linked evidence", () => {
    const result = validateReviewDocument(validWalkthrough());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires every test mapping to own at least one change group", () => {
    const document = validWalkthrough();
    document.tests[0].changeGroupIds = [];

    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("requires canonical relationship collections even when they are empty", () => {
    const document = validWalkthrough() as Record<string, unknown>;
    delete document.risks;
    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("requires the primary story to begin the review plan", () => {
    const document = validWalkthrough();
    document.changeGroups.push({ ...document.changeGroups[0], id: "group-follow-up" });
    document.stories = [
      { ...document.stories[0], relationshipToPrimary: "supporting", changeGroupIds: ["group-session"] },
      { ...document.stories[0], id: "story-primary", title: "Primary behavior", relationshipToPrimary: "primary", changeGroupIds: ["group-follow-up"] },
    ];
    document.primaryStoryId = "story-primary";
    document.reviewPlan = ["story-session", "story-primary"];
    document.risks = [];
    document.dependencies = [];
    document.unchangedInteractions = [];

    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("validates relationship evidence, change groups, and dependency topology", () => {
    const document = validWalkthrough();
    document.risks = [{ id: "risk-session", title: "Risk", detail: "Review the boundary.", changeGroupIds: ["missing-group"], evidenceIds: ["missing-evidence"] }];
    document.dependencies = [
      { id: "dependency-session", title: "Session dependency", detail: "It cannot precede itself.", dependsOnIds: ["dependency-session"], changeGroupIds: ["group-session"], evidenceIds: ["e-session"] },
      { id: "dependency-other", title: "Other dependency", detail: "It has a known cycle.", dependsOnIds: ["dependency-third"], changeGroupIds: ["group-session"], evidenceIds: ["e-session"] },
      { id: "dependency-third", title: "Third dependency", detail: "It closes a cycle.", dependsOnIds: ["dependency-other"], changeGroupIds: ["group-session"], evidenceIds: ["e-session"] },
    ];
    document.unchangedInteractions = [{ id: "stable-session", title: "Stable integration", detail: "The caller remains stable.", changeGroupIds: ["missing-group"], evidenceIds: ["e-session"] }];

    const errors = validateReviewDocument(document).errors.join(" ");
    expect(errors).toMatch(/missing-group|missing-evidence|itself|cycle/i);
  });

  it.each([
    ["risks", { id: "risk-empty", title: "Risk", detail: "Needs grounding.", changeGroupIds: [], evidenceIds: [] }],
    ["dependencies", { id: "dependency-empty", title: "Dependency", detail: "Needs grounding.", dependsOnIds: [], changeGroupIds: [], evidenceIds: [] }],
    ["unchangedInteractions", { id: "unchanged-empty", title: "Stable interaction", detail: "Needs grounding.", changeGroupIds: [], evidenceIds: [] }],
  ])("rejects an ungrounded %s relationship entry", (collection, entry) => {
    const document = validWalkthrough() as Record<string, unknown>;
    document[collection] = [entry];

    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("accepts canonical schema 2 stories and rejects duplicated group ownership", () => {
    const document = validWalkthrough() as Record<string, unknown>;
    expect(validateReviewDocument(document).valid).toBe(true);

    document.stories = [...(document.stories as unknown[]), {
      ...(document.stories as Array<Record<string, unknown>>)[0],
      id: "story-duplicate",
      relationshipToPrimary: "supporting",
      changeGroupIds: ["group-session"],
    }];
    document.reviewPlan = ["story-session", "story-duplicate"];
    expect(validateReviewDocument(document).errors.join(" ")).toMatch(/exactly one story/i);
  });

  it.each([
    [
      "schemaVersion",
      (value: Record<string, unknown>) => {
        delete value.schemaVersion;
      },
    ],
    [
      "run",
      (value: Record<string, unknown>) => {
        delete value.run;
      },
    ],
    [
      "pullRequest",
      (value: Record<string, unknown>) => {
        delete value.pullRequest;
      },
    ],
    [
      "summary",
      (value: Record<string, unknown>) => {
        delete value.summary;
      },
    ],
    [
      "changeGroups",
      (value: Record<string, unknown>) => {
        delete value.changeGroups;
      },
    ],
    [
      "stories",
      (value: Record<string, unknown>) => {
        delete value.stories;
      },
    ],
    [
      "graphs",
      (value: Record<string, unknown>) => {
        delete value.graphs;
      },
    ],
    [
      "evidence",
      (value: Record<string, unknown>) => {
        delete value.evidence;
      },
    ],
  ])("rejects a document missing required %s", (_field, mutate) => {
    const document = validWalkthrough();
    mutate(document);

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unsupported schema version instead of silently rendering it", () => {
    const document = validWalkthrough();
    document.schemaVersion = "1.1.0";

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /schema.?version|unsupported|version/i,
    );
  });

  it("rejects a group that references evidence which is not declared", () => {
    const document = validWalkthrough();
    document.changeGroups[0].evidenceIds = ["missing-evidence"];

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/evidence|missing-evidence/i);
  });

  it.each([
    [
      "changeGroups",
      (document: ReturnType<typeof validWalkthrough>) => {
        document.changeGroups = [];
      },
    ],
    [
      "stories",
      (document: ReturnType<typeof validWalkthrough>) => {
        document.stories = [];
      },
    ],
    [
      "evidence",
      (document: ReturnType<typeof validWalkthrough>) => {
        document.evidence = [];
      },
    ],
  ])("rejects semantically empty %s", (_section, mutate) => {
    const document = validWalkthrough();
    mutate(document);

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /empty|required|changeGroups|stories|evidence/i,
    );
  });

  it("rejects a non-system graph with no directed labeled edges", () => {
    const document = validWalkthrough();
    document.graphs.dataFlow.edges = [];

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/data.?flow|edge/i);
  });

  it("rejects an unlabeled graph edge while preserving the zero-edge system graph contract", () => {
    const document = validWalkthrough();
    document.graphs.dataFlow.edges[0].label = "";
    document.graphs.systemOverview.edges = [
      {
        id: "system-overview-edge",
        source: "system-overview-source",
        target: "system-overview-target",
        label: "forbidden",
        evidenceIds: [],
        changeGroupIds: [],
        reviewThreadIds: [],
      },
    ];

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /label|system.?overview|zero edges/i,
    );
  });

  it("rejects duplicate IDs across semantic collections and inside graph items", () => {
    const document = validWalkthrough();
    document.stories[0].id = document.changeGroups[0].id;
    document.graphs.dataFlow.nodes[1].id = document.graphs.dataFlow.nodes[0].id;

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/duplicate|id/i);
  });

  it.each([
    ["node", "nodes", 0],
    ["edge", "edges", 0],
    ["tour", "guidedTours", 0],
  ] as const)(
    "rejects a duplicate %s semantic ID in separate graphs",
    (_kind, collection, index) => {
      const document = validWalkthrough();
      const duplicate = document.graphs.dataFlow[collection][index].id;
      document.graphs.codeDependency[collection][index].id = duplicate;

      const result = validateReviewDocument(document);

      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(
        new RegExp(`duplicate semantic id '${duplicate}'`, "i"),
      );
    },
  );

  it("rejects a graph semantic ID that collides with a top-level collection", () => {
    const document = validWalkthrough();
    document.tests[0].id = document.graphs.dataFlow.nodes[0].id;

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /duplicate semantic id 'data-flow-source'/i,
    );
  });

  it("rejects unresolved change-group relationships and unsupported statuses", () => {
    const document = validWalkthrough();
    document.tests = [
      {
        id: "test-1",
        title: "Unsupported test",
        behavior: "Invalid status is rejected",
        status: "not-a-supported-status",
        evidenceIds: ["e-session"],
        changeGroupIds: ["missing-group"],
      },
    ];

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /status|change.?group|missing-group/i,
    );
  });

  it("rejects omitted rich fields that would otherwise produce renderer placeholders", () => {
    const document = validWalkthrough();
    delete (document.changeGroups[0] as Record<string, unknown>).motivation;
    delete (document.graphs.dataFlow.nodes[0] as Record<string, unknown>)
      .changed;
    delete (document.graphs.dataFlow.nodes[0] as Record<string, unknown>)
      .changeGroupIds;
    delete (
      document.graphs.dataFlow.guidedTours[0].steps[0] as Record<
        string,
        unknown
      >
    ).explanation;
    delete (document.graphs.dataFlow as Record<string, unknown>).description;
    document.tests[0].behavior = "";
    document.evidence[0].path = "";

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /motivation|changed|change.?group|explanation|description|behavior|path/i,
    );
  });

  it("requires textual summary list items", () => {
    const document = validWalkthrough();
    document.summary.behavioralChanges = [42] as unknown as string[];

    const result = validateReviewDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/behavioralChanges|string/i);
  });

  it("requires explicit graph associations and review metadata", () => {
    const document = validWalkthrough();
    document.reviewThreads = [reviewThread()];
    document.reviewInsights = [reviewInsight()];
    const associationNode = document.graphs.dataFlow.nodes[0] as unknown as {
      reviewThreadIds: string[];
      reviewInsightIds: string[];
    };
    associationNode.reviewThreadIds = ["thread-session"];
    associationNode.reviewInsightIds = ["insight-session"];

    expect(validateReviewDocument(document).valid).toBe(true);

    delete (document.reviewThreads[0] as Record<string, unknown>).replies;
    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("rejects legacy 1.0 documents", () => {
    const document = validWalkthrough();
    document.schemaVersion = "1.0.0";
    document.changeGroups = [];
    document.stories = [];
    document.evidence = [];
    document.tests = [];
    for (const graph of Object.values(document.graphs)) {
      graph.nodes = [];
      graph.edges = [];
      graph.guidedTours = [];
    }

    expect(validateReviewDocument(document).valid).toBe(false);
  });

  it("rejects self, future, and unknown story dependencies", () => {
    const document = validWalkthrough();
    (document.stories as Array<Record<string, unknown>>).push({ ...document.stories[0], id: "story-later", relationshipToPrimary: "supporting", changeGroupIds: ["group-session"] });
    document.reviewPlan = ["story-session", "story-later"];
    (document.stories[0] as Record<string, unknown>).dependsOnStoryIds = ["story-session"];
    expect(validateReviewDocument(document).errors.join(" ")).toMatch(/itself/i);
    (document.stories[0] as Record<string, unknown>).dependsOnStoryIds = ["story-later"];
    expect(validateReviewDocument(document).errors.join(" ")).toMatch(/earlier/i);
    (document.stories[0] as Record<string, unknown>).dependsOnStoryIds = ["missing-story"];
    expect(validateReviewDocument(document).errors.join(" ")).toMatch(/unknown story/i);
  });
});

function reviewThread() {
  return {
    id: "thread-session",
    status: "open",
    provenance: "human",
    evidenceIds: ["e-session"],
    author: "Reviewer",
    body: "Please preserve the session boundary.",
    replies: [],
    replyCount: 0,
    url: null,
    resolvedBy: null,
    authorAssociation: "CONTRIBUTOR",
    path: "src/session/service.ts",
    line: 42,
    originalLine: 42,
    side: "RIGHT",
    startLine: null,
    originalStartLine: null,
    commitSha: "b".repeat(40),
    originalCommitSha: "a".repeat(40),
    createdAt: "2026-08-04T19:00:00.000Z",
    updatedAt: "2026-08-04T19:00:00.000Z",
    changeGroupIds: ["group-session"],
    graphNodeIds: ["data-flow-source"],
    reviewInsightIds: [],
  };
}

function reviewInsight() {
  return {
    id: "insight-session",
    title: "Session boundary",
    detail: "The session service owns the changed behavior.",
    status: "active",
    provenance: "human",
    evidenceIds: ["e-session"],
    changeGroupIds: ["group-session"],
    reviewThreadIds: ["thread-session"],
    graphNodeIds: ["data-flow-source"],
  };
}
