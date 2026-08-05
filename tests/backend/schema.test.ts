import { describe, expect, it } from "vitest";
import { validateWalkthroughDocument } from "../../shared/schema";

const validWalkthrough = () => ({
  schemaVersion: "1.1.0",
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
  walkthrough: [
    {
      id: "step-session",
      title: "Trace session creation",
      description: "Follow the request into the service.",
      reason: "The ownership boundary is the first dependency.",
      summary: "Trace how session ownership moves to the service.",
      limitations: [],
      dependsOnStepIds: [],
      flowNodeIds: ["data-flow-source"],
      testIds: ["test-session"],
      reviewInsightIds: [],
      changeGroupId: "group-session",
      evidenceIds: ["e-session"],
    },
  ],
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
  it("accepts a complete versioned walkthrough with linked evidence", () => {
    const result = validateWalkthroughDocument(validWalkthrough());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
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
      "walkthrough",
      (value: Record<string, unknown>) => {
        delete value.walkthrough;
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

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unsupported schema version instead of silently rendering it", () => {
    const document = validWalkthrough();
    document.schemaVersion = "2.0.0";

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /schema.?version|unsupported|version/i,
    );
  });

  it("rejects a walkthrough that references evidence which is not declared", () => {
    const document = validWalkthrough();
    document.walkthrough[0].evidenceIds = ["missing-evidence"];

    const result = validateWalkthroughDocument(document);

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
      "walkthrough",
      (document: ReturnType<typeof validWalkthrough>) => {
        document.walkthrough = [];
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

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /empty|required|changeGroups|walkthrough|evidence/i,
    );
  });

  it("rejects a non-system graph with no directed labeled edges", () => {
    const document = validWalkthrough();
    document.graphs.dataFlow.edges = [];

    const result = validateWalkthroughDocument(document);

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

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /label|system.?overview|zero edges/i,
    );
  });

  it("rejects duplicate IDs across semantic collections and inside graph items", () => {
    const document = validWalkthrough();
    document.walkthrough[0].id = document.changeGroups[0].id;
    document.graphs.dataFlow.nodes[1].id = document.graphs.dataFlow.nodes[0].id;

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/duplicate|id/i);
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

    const result = validateWalkthroughDocument(document);

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

    const result = validateWalkthroughDocument(document);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /motivation|changed|change.?group|explanation|description|behavior|path/i,
    );
  });

  it("requires textual summary list items", () => {
    const document = validWalkthrough();
    document.summary.behavioralChanges = [42] as unknown as string[];

    const result = validateWalkthroughDocument(document);

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

    expect(validateWalkthroughDocument(document).valid).toBe(true);

    delete (document.reviewThreads[0] as Record<string, unknown>).replies;
    expect(validateWalkthroughDocument(document).valid).toBe(false);
  });

  it("rejects legacy 1.0 documents without a compatibility mode", () => {
    const document = validWalkthrough();
    document.schemaVersion = "1.0.0";
    document.changeGroups = [];
    document.walkthrough = [];
    document.evidence = [];
    document.tests = [];
    for (const graph of Object.values(document.graphs)) {
      graph.nodes = [];
      graph.edges = [];
      graph.guidedTours = [];
    }

    expect(validateWalkthroughDocument(document).valid).toBe(false);
  });

  it("accepts rich 1.1 steps and rejects 1.0 artifacts", () => {
    const rich = validWalkthrough();
    rich.schemaVersion = "1.1.0";
    Object.assign(rich.walkthrough[0], {
      reason: "The ownership boundary establishes the later request flow.",
      summary: "Review the service boundary before consumers.",
      flowNodeIds: ["data-flow-source"],
      testIds: ["test-session"],
      reviewInsightIds: [],
      limitations: [],
      dependsOnStepIds: [],
    });
    expect(validateWalkthroughDocument(rich).valid).toBe(true);

    const legacy = validWalkthrough();
    legacy.schemaVersion = "1.0.0";
    expect(validateWalkthroughDocument(legacy).valid).toBe(false);
  });

  it("rejects incomplete 1.1 steps before they reach the renderer", () => {
    const rich = validWalkthrough();
    rich.schemaVersion = "1.1.0";
    Object.assign(rich.walkthrough[0], {
      reason: "Order matters.",
      summary: "Inspect the service.",
      flowNodeIds: [],
      testIds: [],
      limitations: [],
      dependsOnStepIds: [],
    });
    delete (rich.walkthrough[0] as Record<string, unknown>).reviewInsightIds;
    const result = validateWalkthroughDocument(rich);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/reviewInsightIds|required/i);
  });

  it("rejects self, future, and unknown rich-step dependencies", () => {
    const document = validWalkthrough();
    (document.walkthrough as Array<Record<string, unknown>>).push({ ...document.walkthrough[0], id: "step-later", dependsOnStepIds: ["step-session"] });
    (document.walkthrough[0] as Record<string, unknown>).dependsOnStepIds = ["step-session"];
    expect(validateWalkthroughDocument(document).errors.join(" ")).toMatch(/itself/i);
    (document.walkthrough[0] as Record<string, unknown>).dependsOnStepIds = ["step-later"];
    expect(validateWalkthroughDocument(document).errors.join(" ")).toMatch(/earlier/i);
    (document.walkthrough[0] as Record<string, unknown>).dependsOnStepIds = ["missing-step"];
    expect(validateWalkthroughDocument(document).errors.join(" ")).toMatch(/unknown step/i);
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
