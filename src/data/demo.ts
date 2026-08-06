import {
  ChangeGroup,
  PullRequest,
  Repository,
  ReviewThread,
  TestMapping,
} from "../types";
import type { WalkthroughDocument } from "../../shared/contracts";

const graph = (
  id: "system-overview" | "data-flow" | "code-dependency" | "user-action",
  title: string,
  description: string,
  labels: string[],
  edgeLabels: string[],
): {
  id: typeof id;
  type: typeof id;
  title: string;
  description: string;
  nodes: {
    id: string;
    label: string;
    explanation: string;
    changed: boolean;
    evidenceIds: string[];
    changeGroupIds: string[];
    testIds: string[];
    reviewThreadIds: string[];
    reviewInsightIds: string[];
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label: string;
    evidenceIds: string[];
    changeGroupIds: string[];
    reviewThreadIds: string[];
  }[];
  guidedTours: {
    id: string;
    title: string;
    steps: {
      nodeId: string;
      title: string;
      explanation: string;
      evidenceIds: string[];
    }[];
  }[];
} => ({
  id,
  type: id,
  title,
  description,
  nodes: labels.map((label, index) => ({
    id: `${id}-${index + 1}`,
    label,
    explanation: `${label} in the ${title.toLowerCase()} fixture.`,
    changed: id !== "system-overview" && index < 3,
    evidenceIds:
      id !== "system-overview" && index < 3
        ? [
            [
              "demo-session-file",
              "demo-rotate-symbol",
              "demo-migration-commit",
            ][index] ?? "demo-session-file",
          ]
        : [],
    changeGroupIds: id !== "system-overview" && index < 3 ? ["session"] : [],
    testIds: id !== "system-overview" && index === 0 ? ["test3"] : [],
    reviewThreadIds: id !== "system-overview" && index === 0 ? ["t1"] : [],
    reviewInsightIds: id !== "system-overview" && index === 0 ? ["i1"] : [],
  })),
  edges:
    id === "system-overview"
      ? []
      : edgeLabels.map((label, index) => ({
          id: `${id}-edge-${index + 1}`,
          source: `${id}-${index + 1}`,
          target: `${id}-${index + 2}`,
          label,
          evidenceIds:
            index < 3
              ? [
                  [
                    "demo-session-file",
                    "demo-rotate-symbol",
                    "demo-migration-commit",
                  ][index] ?? "demo-session-file",
                ]
              : [],
          changeGroupIds: index < 3 ? ["session"] : [],
          reviewThreadIds: index === 0 ? ["t1"] : [],
        })),
  guidedTours: [
    {
      id: `${id}-tour`,
      title: `Review ${title}`,
      steps: labels.map((label, index) => ({
        nodeId: `${id}-${index + 1}`,
        title: `Inspect ${label}`,
        explanation: `Trace ${label} in this ${title.toLowerCase()} path.`,
        evidenceIds:
          id !== "system-overview" && index < 3
            ? [
                [
                  "demo-session-file",
                  "demo-rotate-symbol",
                  "demo-migration-commit",
                ][index] ?? "demo-session-file",
              ]
            : [],
      })),
    },
  ],
});
const flows = [
  graph(
    "system-overview",
    "Request lifecycle",
    "Session creation now owns refresh-token rotation before the API boundary.",
    ["Browser", "SessionStore", "Auth API", "Token DB", "Audit"],
    ["owns", "calls", "persists", "audits"],
  ),
  graph(
    "data-flow",
    "Refresh token data",
    "A hashed token enters through the callback and is persisted with a bounded lifetime.",
    [
      "OAuth callback",
      "normalize()",
      "hashToken()",
      "sessions.refresh_token_hash",
      "pruneExpired()",
    ],
    ["normalizes", "hashes", "persists", "prunes"],
  ),
  graph(
    "code-dependency",
    "Module dependencies",
    "The web session hook depends on the shared API client rather than direct fetch calls.",
    ["useSession", "apiClient", "sessionRouter", "sessionRepository"],
    ["imports", "calls", "delegates"],
  ),
  graph(
    "user-action",
    "User sign-in",
    "Returning users see a silent refresh, then land in the workspace without a second prompt.",
    ["Click sign in", "Provider", "Callback", "Silent refresh", "Workspace"],
    ["opens", "redirects", "hydrates", "lands"],
  ),
];

const groups: ChangeGroup[] = [
  {
    id: "session",
    title: "Session ownership",
    description: "Moves refresh-token lifecycle into the session boundary.",
    attention: "high",
    files: [
      "apps/api/src/session/session.service.ts",
      "apps/api/src/session/session.repository.ts",
    ],
    before:
      "Tokens were returned to the web client and persisted as opaque values.",
    after:
      "The service hashes tokens before persistence and rotates them on refresh.",
    rationale:
      "Keeps credentials out of logs and makes rotation explicit at one boundary.",
    reviewed: false,
    evidenceIds: ["demo-session-file", "demo-rotate-symbol"],
  },
  {
    id: "callback",
    title: "Callback handoff",
    description: "Makes OAuth callback state durable across the redirect.",
    attention: "medium",
    files: [
      "apps/web/src/auth/callback.tsx",
      "apps/web/src/auth/use-session.ts",
    ],
    before: "Callback exchanged a code and immediately navigated.",
    after:
      "Callback stores a short-lived handoff, then hydrates the session store.",
    rationale:
      "Prevents a race where the first workspace request ran before cookies settled.",
    reviewed: false,
    evidenceIds: ["demo-auth-spec"],
  },
  {
    id: "schema",
    title: "Token storage migration",
    description: "Adds a nullable hash column and a cleanup index.",
    attention: "high",
    files: ["packages/db/migrations/2026_07_18_refresh_tokens.sql"],
    before: "sessions had one opaque refresh_token column.",
    after: "sessions stores refresh_token_hash with an expiry index.",
    rationale: "Supports gradual rollout while old sessions expire naturally.",
    reviewed: false,
    evidenceIds: ["demo-migration-commit"],
  },
  {
    id: "coverage",
    title: "Regression coverage",
    description: "Adds behavior-level tests for rotation and callback races.",
    attention: "low",
    files: [
      "apps/api/src/session/session.service.test.ts",
      "apps/web/src/auth/callback.test.tsx",
    ],
    before: "Only happy-path login was covered.",
    after: "Rotation, expiry, and callback ordering are asserted.",
    rationale: "Makes the changed contract executable for future refactors.",
    reviewed: false,
    evidenceIds: ["demo-auth-spec"],
  },
];

const insights = [
  {
    id: "i1",
    title: "Rotation can invalidate parallel requests",
    detail:
      "Two refresh calls can race on the same token. The second request should retry once with the newly issued token.",
    provenance: "human" as const,
    state: "active" as const,
    location: "session.service.ts:118",
    count: 2,
  },
  {
    id: "i2",
    title: "Migration is safe to roll forward",
    detail:
      "The nullable column and backfill guard match the rollout notes. No blocking concern remains.",
    provenance: "automated" as const,
    state: "resolved" as const,
    location: "2026_07_18_refresh_tokens.sql:4",
    count: 3,
  },
  {
    id: "i3",
    title: "Callback race comment is stale",
    detail:
      "The handoff store now precedes navigation; this thread points at code removed in the latest commit.",
    provenance: "human" as const,
    state: "outdated" as const,
    location: "callback.tsx:42",
    count: 1,
  },
  {
    id: "i4",
    title: "Keep provider errors visible",
    detail:
      "Do not collapse provider_denied into a generic session error; the UI depends on this distinction.",
    provenance: "automated" as const,
    state: "disputed" as const,
    location: "session.errors.ts:27",
    count: 2,
  },
];

const threads: ReviewThread[] = [
  {
    id: "t1",
    author: "Maya Chen",
    initials: "MC",
    body: "Can we guard the parallel refresh case? I hit this while switching tabs quickly.",
    state: "active",
    provenance: "human",
    authorAssociation: "CONTRIBUTOR",
    createdAt: "2026-08-04T08:12:00Z",
    updatedAt: "2026-08-04T08:26:00Z",
    url: "https://github.com/runway/atlas/pull/482#discussion_r1",
    resolvedBy: null,
    path: "apps/api/src/session/session.service.ts",
    file: "apps/api/src/session/session.service.ts",
    line: 118,
    originalLine: 116,
    side: "RIGHT",
    startLine: null,
    originalStartLine: null,
    commitSha: "c2f9a71",
    originalCommitSha: "a8d1f04",
    replies: [
      {
        id: "t1-r1",
        author: "Maya Chen",
        initials: "MC",
        body: "The retry should remain bounded to one refresh.",
        authorAssociation: "CONTRIBUTOR",
        createdAt: "2026-08-04T08:20:00Z",
        updatedAt: "2026-08-04T08:20:00Z",
        url: "https://github.com/runway/atlas/pull/482#discussion_r2",
        path: "apps/api/src/session/session.service.ts",
        line: 121,
        originalLine: 119,
        side: "RIGHT",
        commitSha: "c2f9a71",
        originalCommitSha: "a8d1f04",
      },
    ],
    replyCount: 1,
    changeGroupIds: ["session"],
    graphNodeIds: ["data-flow-1"],
    reviewInsightIds: ["i1"],
    source: "human",
  },
  {
    id: "t2",
    author: "ReviewBot",
    initials: "RB",
    body: "The migration adds an index for expiry lookups.",
    state: "resolved",
    provenance: "automated",
    authorAssociation: "NONE",
    createdAt: "2026-08-04T07:52:00Z",
    updatedAt: "2026-08-04T08:02:00Z",
    url: "https://github.com/runway/atlas/pull/482#discussion_r3",
    resolvedBy: "Maya Chen",
    path: "packages/db/migrations/2026_07_18_refresh_tokens.sql",
    file: "packages/db/migrations/2026_07_18_refresh_tokens.sql",
    line: 4,
    originalLine: 4,
    side: "RIGHT",
    startLine: null,
    originalStartLine: null,
    commitSha: "c2f9a71",
    originalCommitSha: "a8d1f04",
    replies: [],
    replyCount: 0,
    changeGroupIds: ["schema"],
    graphNodeIds: ["data-flow-4"],
    reviewInsightIds: ["i2"],
    source: "bot",
  },
  {
    id: "t3",
    author: "Leon Park",
    initials: "LP",
    body: "This navigation ordering concern is covered by the new callback test.",
    state: "outdated",
    provenance: "human",
    authorAssociation: "MEMBER",
    createdAt: "2026-08-03T18:20:00Z",
    updatedAt: "2026-08-03T18:45:00Z",
    url: "https://github.com/runway/atlas/pull/482#discussion_r4",
    resolvedBy: null,
    path: "apps/web/src/auth/callback.tsx",
    file: "apps/web/src/auth/callback.tsx",
    line: 42,
    originalLine: 42,
    side: "RIGHT",
    startLine: null,
    originalStartLine: null,
    commitSha: "c2f9a71",
    originalCommitSha: "a8d1f04",
    replies: [],
    replyCount: 0,
    changeGroupIds: ["callback"],
    graphNodeIds: ["user-action-3"],
    reviewInsightIds: ["i3"],
    source: "human",
  },
  {
    id: "t4",
    author: "LintPilot",
    initials: "LP",
    body: "Provider-specific errors should remain actionable to users.",
    state: "disputed",
    provenance: "automated",
    authorAssociation: "NONE",
    createdAt: "2026-08-04T06:40:00Z",
    updatedAt: "2026-08-04T07:05:00Z",
    url: "https://github.com/runway/atlas/pull/482#discussion_r5",
    resolvedBy: null,
    path: "apps/api/src/session/session.errors.ts",
    file: "apps/api/src/session/session.errors.ts",
    line: 27,
    originalLine: 27,
    side: "RIGHT",
    startLine: null,
    originalStartLine: null,
    commitSha: "c2f9a71",
    originalCommitSha: "a8d1f04",
    replies: [],
    replyCount: 0,
    changeGroupIds: ["session"],
    graphNodeIds: ["code-dependency-2"],
    reviewInsightIds: ["i4"],
    source: "bot",
  },
];

threads.forEach((thread, index) => {
  thread.evidenceIds =
    [
      ["demo-session-file"],
      ["demo-migration-commit"],
      ["demo-auth-spec"],
      ["demo-session-file"],
    ][index] ?? [];
});

const tests: TestMapping[] = [
  {
    id: "test1",
    test: "rotates token after refresh",
    behavior: "Refresh token is replaced and the old hash is rejected.",
    status: "covered",
    evidence: "session.service.test.ts:74",
    evidenceIds: ["demo-rotate-symbol"],
    changeGroupIds: ["session"],
  },
  {
    id: "test2",
    test: "preserves provider denial",
    behavior: "Provider-specific errors remain visible to the callback UI.",
    status: "covered",
    evidence: "callback.test.tsx:52",
    evidenceIds: ["demo-auth-spec"],
    changeGroupIds: ["callback"],
  },
  {
    id: "test3",
    test: "handles parallel refresh",
    behavior: "Concurrent refreshes converge on one active session.",
    status: "partial",
    evidence: "session.service.test.ts:121",
    evidenceIds: ["demo-session-file"],
    changeGroupIds: ["session"],
  },
  {
    id: "test4",
    test: "cleans expired sessions",
    behavior: "Expiry index supports bounded cleanup.",
    status: "missing",
    evidence: "No direct assertion",
    evidenceIds: [],
    changeGroupIds: ["schema"],
  },
];

const atlasWalkthrough: WalkthroughDocument = {
  schemaVersion: "1.1.0",
  run: {
    id: "demo-atlas-482-v1-1",
    createdAt: "2026-08-04T10:14:00.000Z",
    provider: "demo",
    model: "Codex local fixture",
    skillVersion: "1.1.0",
    config: {
      depth: "deep",
      includeReviewComments: true,
      maxGraphNodes: 80,
      timeoutMinutes: 20,
    },
  },
  pullRequest: {
    host: "github.com",
    repository: "runway/atlas",
    number: 482,
    baseSha: "a8d1f04",
    headSha: "c2f9a71",
  },
  summary: {
    intent:
      "Move refresh-token ownership into the session boundary while preserving a safe OAuth callback handoff.",
    behavioralChanges: [
      "Refresh tokens rotate at the server boundary before a workspace request can reuse the old credential.",
      "OAuth callbacks persist a short-lived handoff before navigation so the first workspace request sees an initialized session.",
    ],
    architecturalImpact: [
      "The session service becomes the only owner of refresh-token hashing and rotation.",
      "The database migration introduces a nullable hash column and expiry index for gradual rollout.",
    ],
    limitations: [
      "Parallel refresh handling is covered as a bounded retry, not a distributed lock proof.",
      "Provider-side token revocation remains outside this pull request.",
    ],
  },
  changeGroups: groups.map((group) => ({
    id: group.id,
    title: group.title,
    summary: group.description,
    motivation: group.rationale,
    previousBehavior: group.before,
    newBehavior: group.after,
    attention: group.attention,
    evidenceIds: group.evidenceIds ?? [],
  })),
  walkthrough: [
    {
      id: "step-session-boundary",
      title: "Review server-side token rotation",
      reason:
        "Review the credential boundary first because every callback and refresh path depends on it.",
      summary:
        "Trace how the session service hashes, rotates, and rejects stale refresh credentials.",
      limitations: [
        "The fixture does not model a provider-side token revocation event.",
      ],
      dependsOnStepIds: [],
      changeGroupId: "session",
      flowNodeIds: ["data-flow-2", "data-flow-3"],
      evidenceIds: ["demo-session-file", "demo-rotate-symbol"],
      testIds: ["test1", "test3"],
      reviewInsightIds: ["i1"],
    },
    {
      id: "step-callback-handoff",
      title: "Review callback handoff ordering",
      reason:
        "Verify the handoff after the credential boundary so callback state is interpreted against the new session contract.",
      summary:
        "Confirm that navigation follows durable handoff storage and a hydrated session.",
      limitations: [
        "The fixture models the callback ordering but not browser cookie policy differences.",
      ],
      dependsOnStepIds: ["step-session-boundary"],
      changeGroupId: "callback",
      flowNodeIds: ["user-action-3", "user-action-4"],
      evidenceIds: ["demo-auth-spec"],
      testIds: ["test2"],
      reviewInsightIds: ["i3", "i4"],
    },
    {
      id: "step-storage-migration",
      title: "Review the staged token migration",
      reason:
        "Check persistence after its producing session behavior and consuming callback are understood.",
      summary:
        "Inspect nullable hash storage and the expiry index used by cleanup.",
      limitations: [
        "The fixture does not include production backfill volume measurements.",
      ],
      dependsOnStepIds: ["step-session-boundary"],
      changeGroupId: "schema",
      flowNodeIds: ["data-flow-4", "data-flow-5"],
      evidenceIds: ["demo-migration-commit"],
      testIds: ["test4"],
      reviewInsightIds: ["i2"],
    },
    {
      id: "step-regression-tests",
      title: "Review executable regression coverage",
      reason:
        "Finish by checking that the intended contract is encoded in focused tests.",
      summary:
        "Map rotation, callback ordering, and expiry behavior to the changed test coverage.",
      limitations: [
        "Expiry cleanup is intentionally marked missing until a direct assertion is added.",
      ],
      dependsOnStepIds: [
        "step-session-boundary",
        "step-callback-handoff",
        "step-storage-migration",
      ],
      changeGroupId: "coverage",
      flowNodeIds: ["code-dependency-1"],
      evidenceIds: ["demo-auth-spec", "demo-rotate-symbol"],
      testIds: ["test1", "test2", "test3", "test4"],
      reviewInsightIds: ["i1", "i2"],
    },
  ],
  graphs: {
    systemOverview: flows[0]!,
    dataFlow: flows[1]!,
    codeDependency: flows[2]!,
    userAction: flows[3]!,
  },
  tests: tests.map((test) => ({
    id: test.id,
    title: test.test,
    behavior: test.behavior,
    status: test.status,
    evidenceIds: test.evidenceIds ?? [],
    changeGroupIds: test.changeGroupIds ?? [],
  })),
  reviewThreads: threads.map((thread) => ({
    ...thread,
    status: thread.state,
    evidenceIds: thread.evidenceIds ?? [],
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      author: reply.author,
      body: reply.body,
      authorAssociation: reply.authorAssociation,
      createdAt: reply.createdAt,
      updatedAt: reply.updatedAt,
      url: reply.url,
      path: reply.path,
      line: reply.line,
      originalLine: reply.originalLine,
      side: reply.side,
      commitSha: reply.commitSha,
      originalCommitSha: reply.originalCommitSha,
    })),
  })),
  reviewInsights: insights.map((insight) => ({
    id: insight.id,
    title: insight.title,
    detail: insight.detail,
    status: insight.state,
    provenance: insight.provenance,
    evidenceIds: [],
    changeGroupIds:
      insight.id === "i2"
        ? ["schema"]
        : insight.id === "i3"
          ? ["callback"]
          : ["session"],
    reviewThreadIds:
      insight.id === "i1"
        ? ["t1"]
        : insight.id === "i2"
          ? ["t2"]
          : insight.id === "i3"
            ? ["t3"]
            : ["t4"],
    graphNodeIds:
      insight.id === "i1"
        ? ["data-flow-1"]
        : insight.id === "i2"
          ? ["data-flow-4"]
          : insight.id === "i3"
            ? ["user-action-3"]
            : ["code-dependency-2"],
  })),
  evidence: [
    {
      id: "demo-session-file",
      kind: "file",
      title: "Session service",
      path: "apps/api/src/session/session.service.ts",
      line: 118,
      url: "https://github.com/runway/atlas/blob/c2f9a71/apps/api/src/session/session.service.ts#L118",
    },
    {
      id: "demo-rotate-symbol",
      kind: "symbol",
      title: "rotateRefreshToken",
      path: "apps/api/src/session/session.service.ts",
      line: 96,
      url: "https://github.com/runway/atlas/blob/c2f9a71/apps/api/src/session/session.service.ts#L96",
    },
    {
      id: "demo-migration-commit",
      kind: "commit",
      title: "Migration commit",
      path: "a8d1f04",
      line: null,
      url: "https://github.com/runway/atlas/commit/a8d1f04",
    },
    {
      id: "demo-auth-spec",
      kind: "spec",
      title: "Auth rollout notes",
      path: "docs/auth-rollout.md",
      line: null,
      url: "https://github.com/runway/atlas/blob/c2f9a71/docs/auth-rollout.md",
    },
  ],
};

export const repositories: Repository[] = [
  {
    source: "fixture",
    id: "atlas",
    name: "atlas",
    owner: "runway",
    fullName: "runway/atlas",
    host: "github.com",
    openPRs: 18,
    private: true,
    defaultBranch: "main",
    url: "https://github.com/runway/atlas",
  },
  {
    source: "fixture",
    id: "harbor",
    name: "harbor",
    owner: "runway",
    fullName: "runway/harbor",
    host: "github.com",
    openPRs: 7,
    private: false,
    defaultBranch: "main",
    url: "https://github.com/runway/harbor",
  },
  {
    source: "fixture",
    id: "orbit",
    name: "orbit-cli",
    owner: "runway",
    fullName: "runway/orbit-cli",
    host: "github.com",
    openPRs: 11,
    private: true,
    defaultBranch: "main",
    url: "https://github.com/runway/orbit-cli",
  },
];

export const pullRequests: PullRequest[] = [
  {
    source: "fixture",
    id: "atlas-482",
    number: 482,
    repositoryId: "atlas",
    repositoryFullName: "runway/atlas",
    title: "Rotate refresh tokens at the session boundary",
    author: "Maya Chen",
    initials: "MC",
    branch: "maya/refresh-token-rotation",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "c2f9a71",
    url: "https://github.com/runway/atlas/pull/482",
    updated: "12 min ago",
    additions: 286,
    deletions: 91,
    files: 14,
    status: "ready",
    labels: ["security", "auth"],
    summary:
      "Moves refresh-token ownership into the session service, adds a safe migration, and makes the OAuth callback resilient to redirect races.",
    changedAreas: ["API", "Web", "Database", "Tests"],
    analysisProvenance: "demo",
    groups,
    insights,
    flows,
    tests,
    threads,
    walkthrough: atlasWalkthrough,
    evidence: [
      {
        id: "demo-session-file",
        label: "Session service",
        path: "apps/api/src/session/session.service.ts",
        kind: "file" as const,
        line: 118,
        url: "https://github.com/runway/atlas/blob/c2f9a71/apps/api/src/session/session.service.ts#L118",
      },
      {
        id: "demo-rotate-symbol",
        label: "rotateRefreshToken",
        path: "apps/api/src/session/session.service.ts",
        line: 96,
        kind: "symbol" as const,
        url: "https://github.com/runway/atlas/blob/c2f9a71/apps/api/src/session/session.service.ts#L96",
      },
      {
        id: "demo-migration-commit",
        label: "Migration commit",
        path: "a8d1f04",
        kind: "commit" as const,
        line: undefined,
        url: "https://github.com/runway/atlas/commit/a8d1f04",
      },
      {
        id: "demo-auth-spec",
        label: "Auth rollout notes",
        path: "docs/auth-rollout.md",
        kind: "spec" as const,
        line: undefined,
        url: "https://github.com/runway/atlas/blob/c2f9a71/docs/auth-rollout.md",
      },
    ],
    history: [
      {
        id: "demo-atlas-482-v1-1",
        date: "Aug 4, 10:14",
        duration: "2m 18s",
        status: "completed" as const,
        provider: "demo",
        model: "Codex local fixture",
        schemaVersion: "1.1.0",
        skillVersion: "1.1.0",
      },
      {
        id: "run2",
        date: "Aug 3, 18:42",
        duration: "2m 04s",
        status: "completed" as const,
        model: "Claude Code",
      },
    ],
  },
  {
    source: "fixture",
    id: "atlas-476",
    number: 476,
    repositoryId: "atlas",
    repositoryFullName: "runway/atlas",
    title: "Add repository-level audit export",
    author: "Leon Park",
    initials: "LP",
    branch: "leon/audit-export",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "b7e2c19",
    analyzedSha: "a8d1f04",
    url: "https://github.com/runway/atlas/pull/476",
    updated: "2 hr ago",
    additions: 94,
    deletions: 12,
    files: 7,
    status: "outdated",
    labels: ["data", "ops"],
    summary:
      "Adds a CSV export for audit events and a bounded retention query.",
    changedAreas: ["API", "CLI"],
    analysisProvenance: "demo",
    groups: groups.slice(0, 2),
    insights: insights.slice(1, 3),
    flows: flows.slice(0, 2),
    tests: [],
    threads: threads.slice(1, 3),
    evidence: [],
    history: [],
  },
  {
    source: "fixture",
    id: "atlas-469",
    number: 469,
    repositoryId: "atlas",
    repositoryFullName: "runway/atlas",
    title: "Improve workspace invite acceptance",
    author: "Nadia Kim",
    initials: "NK",
    branch: "nadia/invite-acceptance",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "d4ea291",
    url: "https://github.com/runway/atlas/pull/469",
    updated: "yesterday",
    additions: 143,
    deletions: 38,
    files: 9,
    status: "processing",
    labels: ["web"],
    summary:
      "Analysis is mapping invite acceptance from the email link through workspace membership.",
    changedAreas: ["Web", "API"],
    groups: [],
    insights: [],
    flows: [],
    tests: [],
    threads: [],
    evidence: [],
    history: [],
  },
  {
    source: "fixture",
    id: "atlas-455",
    number: 455,
    repositoryId: "atlas",
    repositoryFullName: "runway/atlas",
    title: "Update billing portal links",
    author: "Owen Shaw",
    initials: "OS",
    branch: "owen/billing-portal",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "e5fb302",
    url: "https://github.com/runway/atlas/pull/455",
    updated: "3 days ago",
    additions: 28,
    deletions: 8,
    files: 3,
    status: "unprocessed",
    labels: ["billing"],
    summary:
      "Refreshes customer portal links and adds a fallback when billing is paused.",
    changedAreas: ["Web"],
    groups: [],
    insights: [],
    flows: [],
    tests: [],
    threads: [],
    evidence: [],
    history: [],
  },
  {
    source: "fixture",
    id: "atlas-441",
    number: 441,
    repositoryId: "atlas",
    repositoryFullName: "runway/atlas",
    title: "Tighten webhook signature errors",
    author: "Iris Alvarez",
    initials: "IA",
    branch: "iris/webhook-errors",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "f7ad113",
    url: "https://github.com/runway/atlas/pull/441",
    updated: "last week",
    additions: 51,
    deletions: 17,
    files: 4,
    status: "failed",
    labels: ["security"],
    summary:
      "The previous analysis run could not parse a generated schema file.",
    changedAreas: ["API", "Tests"],
    groups: [],
    insights: [],
    flows: [],
    tests: [],
    threads: [],
    evidence: [],
    history: [
      {
        id: "run3",
        date: "Aug 1, 09:21",
        duration: "48s",
        status: "failed" as const,
        model: "Codex local",
      },
    ],
  },
  {
    source: "fixture",
    id: "harbor-127",
    number: 127,
    repositoryId: "harbor",
    repositoryFullName: "runway/harbor",
    title: "Stream large archive downloads",
    author: "Maya Chen",
    initials: "MC",
    branch: "maya/stream-archives",
    base: "main",
    baseSha: "a8d1f04",
    headSha: "a4c9811",
    url: "https://github.com/runway/harbor/pull/127",
    updated: "4 hr ago",
    additions: 203,
    deletions: 44,
    files: 11,
    status: "ready",
    labels: ["performance"],
    summary:
      "Streams archive downloads with backpressure and adds an integration test.",
    changedAreas: ["API", "Tests"],
    analysisProvenance: "demo",
    groups,
    insights,
    flows,
    tests: [],
    threads,
    evidence: [],
    history: [],
  },
];

export const analysisStages = [
  {
    label: "Preparing repository",
    detail: "Creating an isolated local worktree",
  },
  {
    label: "Collecting pull request artifacts",
    detail: "Fetching deterministic GitHub metadata and diff evidence",
  },
  {
    label: "Inspecting source context",
    detail: "Tracing changed owners, callers, and tests",
  },
  {
    label: "Generating walkthrough",
    detail: "Running the selected local agent",
  },
  {
    label: "Validating output",
    detail: "Checking the current walkthrough contract and relationships",
  },
  {
    label: "Saving analysis",
    detail: "Persisting the validated local artifact",
  },
];
