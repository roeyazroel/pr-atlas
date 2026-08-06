import {
  access,
  mkdtemp,
  mkdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../electron/backend/store";
import type { Graph, WalkthroughDocument } from "../../shared/contracts";

const run = (id: string, headSha = "b".repeat(40)) => ({
  runId: id,
  repository: "example/backend",
  pullNumber: 481,
  baseSha: "a".repeat(40),
  headSha,
  createdAt: "2026-08-04T19:00:00.000Z",
  status: "ready" as const,
  provider: "claude" as const,
});

const walkthrough = (
  repository = "example/backend",
  pullNumber = 481,
  baseSha = "a".repeat(40),
  headSha = "b".repeat(40),
): WalkthroughDocument => ({
  schemaVersion: "1.1.0" as const,
  run: {
    id: "run-ready",
    createdAt: "2026-08-04T19:00:00.000Z",
    provider: "fake",
    model: "test-model",
    skillVersion: "1.0.0",
  },
  pullRequest: {
    host: "github.com" as const,
    repository,
    number: pullNumber,
    baseSha,
    headSha,
  },
  summary: {
    intent: "Trace the changed system.",
    behavioralChanges: ["Session ownership changed."],
    architecturalImpact: ["The service owns session state."],
    limitations: [],
  },
  changeGroups: [
    {
      id: "group-session",
      title: "Session ownership",
      summary: "Moves session state.",
      motivation: "Keep one owner.",
      previousBehavior: "The client owned state.",
      newBehavior: "The service owns state.",
      attention: "medium" as const,
      evidenceIds: ["e-session"],
    },
  ],
  walkthrough: [
    {
      id: "step-session",
      title: "Trace session ownership",
      reason: "The ownership boundary must be traced first.",
      summary: "Follow session ownership into the service.",
      limitations: [],
      dependsOnStepIds: [],
      changeGroupId: "group-session",
      flowNodeIds: ["data-flow-node"],
      evidenceIds: ["e-session"],
      testIds: ["test-session"],
      reviewInsightIds: [],
    },
  ],
  graphs: {
    systemOverview: graph("system-overview"),
    dataFlow: graph("data-flow"),
    codeDependency: graph("code-dependency"),
    userAction: graph("user-action"),
  },
  tests: [
    {
      id: "test-session",
      title: "Session behavior",
      behavior: "Covers service ownership.",
      status: "covered" as const,
      evidenceIds: ["e-session"],
      changeGroupIds: ["group-session"],
    },
  ],
  reviewThreads: [],
  reviewInsights: [],
  evidence: [
    {
      id: "e-session",
      kind: "file",
      title: "Session service",
      path: "src/session.ts",
      line: null,
      url: null,
    },
  ],
});

function graph(id: Graph["id"]): Graph {
  return {
    id,
    description: `Explains the ${id} graph.`,
    nodes: [
      {
        id: `${id}-node`,
        label: "Session service",
        explanation: "A relevant node.",
        changed: id !== "system-overview",
        changeGroupIds: id === "system-overview" ? [] : ["group-session"],
        testIds: id === "system-overview" ? [] : ["test-session"],
        reviewThreadIds: [],
        reviewInsightIds: [],
        evidenceIds: id === "system-overview" ? [] : ["e-session"],
      },
    ],
    edges:
      id === "system-overview"
        ? []
        : [
            {
              id: `${id}-edge`,
              source: `${id}-node`,
              target: `${id}-node`,
              label: "owns state",
              evidenceIds: ["e-session"],
              changeGroupIds: ["group-session"],
              reviewThreadIds: [],
            },
          ],
    guidedTours: [
      {
        id: `${id}-tour`,
        title: "Review this graph",
        steps: [
          {
            nodeId: `${id}-node`,
            title: "Inspect ownership",
            explanation: "Trace session ownership.",
          },
        ],
      },
    ],
  };
}

describe("analysis store", () => {
  it("persists and lists runs scoped to one repository, PR, and head SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);

    const firstDirectory = store.runDirectory(
      "example/backend",
      481,
      "b".repeat(40),
      "run-1",
    );
    const secondDirectory = store.runDirectory(
      "example/backend",
      481,
      "c".repeat(40),
      "run-2",
    );
    await store.writeManifest(firstDirectory, {
      ...run("run-1"),
      model: "selected-model",
    });
    await store.writeManifest(secondDirectory, run("run-2", "c".repeat(40)));

    await expect(store.listRuns("example/backend", 481)).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        headSha: "b".repeat(40),
        model: "selected-model",
      }),
      expect.objectContaining({ runId: "run-2", headSha: "c".repeat(40) }),
    ]);
  });

  it("rejects run identifiers and paths that attempt traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);

    expect(() =>
      store.runDirectory("example/backend", 481, "b".repeat(40), "../outside"),
    ).toThrow(/path|run|safe|travers/i);
    expect(() =>
      store.runDirectory("../secrets", 481, "b".repeat(40), "run-1"),
    ).toThrow(/invalid|path|run|safe|travers/i);
  });

  it("ignores symlinked entries that point outside the store root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const outside = await mkdtemp(join(tmpdir(), "pr-atlas-outside-"));
    const base = storePath(root, "example/backend", 481, "head", "");
    await mkdir(base, { recursive: true });
    await writeFile(
      join(outside, "manifest.json"),
      JSON.stringify(run("secret")),
    );
    await symlink(outside, join(base, "secret-run"));
    const store = new AnalysisStore(root);

    await expect(store.listRuns("example/backend", 481)).resolves.toEqual([]);
  });

  it("does not trust arbitrary JSON files as completed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const directory = storePath(
      root,
      "example/backend",
      481,
      "head",
      "malicious",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ walkthrough: "<script>alert(1)</script>" }),
    );
    const store = new AnalysisStore(root);

    await expect(store.listRuns("example/backend", 481)).resolves.toEqual([]);
  });

  it("loads a ready run only when its manifest and validated walkthrough match the requested identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);
    const directory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-ready",
    );
    await store.writeManifest(directory, {
      ...run("run-ready", headSha),
      model: "selected-model",
    });
    await store.writeWalkthrough(
      directory,
      walkthrough("example/backend", 481, "a".repeat(40), headSha),
    );

    await expect(
      store.loadRun("example/backend", 481, "run-ready"),
    ).resolves.toMatchObject({
      runId: "run-ready",
      status: "ready",
      manifest: { model: "selected-model" },
      document: {
        schemaVersion: "1.1.0",
        pullRequest: { repository: "example/backend", number: 481, headSha },
      },
    });
  });

  it("refuses persisted 1.0 walkthroughs when loading historical runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);
    const directory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-legacy-doc",
    );
    await store.writeManifest(directory, {
      ...run("run-legacy-doc", headSha),
      schemaVersion: "1.0.0",
    });
    await writeFile(
      join(directory, "walkthrough.json"),
      JSON.stringify({ ...walkthrough("example/backend", 481, "a".repeat(40), headSha), schemaVersion: "1.0.0" }),
    );

    await expect(
      store.loadRun("example/backend", 481, "run-legacy-doc"),
    ).resolves.toBeNull();
  });

  it("returns null for mismatched, missing, invalid, or unsafe saved runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);

    const mismatchDirectory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-mismatch",
    );
    await store.writeManifest(mismatchDirectory, {
      ...run("run-mismatch", headSha),
      repository: "other/backend",
    });
    const invalidDirectory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-invalid",
    );
    await store.writeManifest(invalidDirectory, {
      ...run("run-invalid", headSha),
      status: "invalid",
    });

    await expect(
      store.loadRun("example/backend", 481, "run-mismatch"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("example/backend", 481, "run-invalid"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("example/backend", 481, "run-missing"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("example/backend", 481, "../run-invalid"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("../secrets", 481, "run-invalid"),
    ).resolves.toBeNull();
  });

  it("does not load a ready manifest when its walkthrough is missing or fails schema and identity checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);
    const missingDirectory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-missing-doc",
    );
    await store.writeManifest(
      missingDirectory,
      run("run-missing-doc", headSha),
    );
    const invalidDirectory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-invalid-doc",
    );
    await store.writeManifest(
      invalidDirectory,
      run("run-invalid-doc", headSha),
    );
    await store.writeText(
      invalidDirectory,
      "raw-output.txt",
      "diagnostic only",
    );
    await writeFile(
      join(invalidDirectory, "walkthrough.json"),
      JSON.stringify({ schemaVersion: "1.0.0" }),
    );
    const wrongIdentityDirectory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-wrong-doc",
    );
    await store.writeManifest(
      wrongIdentityDirectory,
      run("run-wrong-doc", headSha),
    );
    await store.writeWalkthrough(
      wrongIdentityDirectory,
      walkthrough("example/backend", 482, "a".repeat(40), headSha),
    );

    await expect(
      store.loadRun("example/backend", 481, "run-missing-doc"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("example/backend", 481, "run-invalid-doc"),
    ).resolves.toBeNull();
    await expect(
      store.loadRun("example/backend", 481, "run-wrong-doc"),
    ).resolves.toBeNull();
  });

  it("persists only bounded progress for steps in the validated run and marks a preferred run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);
    const directory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-progress",
    );
    await store.writeManifest(directory, run("run-progress", headSha));
    await store.writeWalkthrough(
      directory,
      walkthrough("example/backend", 481, "a".repeat(40), headSha),
    );

    await expect(
      store.setReviewProgress("example/backend", 481, {
        runId: "run-progress",
        stepId: "step-session",
        status: "follow-up",
        note: "Check token rotation.",
        updatedAt: "untrusted",
      }),
    ).resolves.toMatchObject({
      status: "follow-up",
      note: "Check token rotation.",
    });
    await expect(
      store.setReviewProgress("example/backend", 481, {
        runId: "run-progress",
        stepId: "not-a-step",
        status: "reviewed",
        note: "",
        updatedAt: "",
      }),
    ).resolves.toBeNull();
    await expect(
      store.getReviewProgress("example/backend", 481, "run-progress"),
    ).resolves.toEqual([
      expect.objectContaining({ stepId: "step-session", status: "follow-up" }),
    ]);
    await expect(
      store.setPreferredRun("example/backend", 481, "run-progress"),
    ).resolves.toBe(true);
    await expect(store.listRuns("example/backend", 481)).resolves.toEqual([
      expect.objectContaining({ runId: "run-progress", preferred: true }),
    ]);
  });

  it("serializes concurrent progress writes so each step is retained", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const headSha = "b".repeat(40);
    const directory = store.runDirectory(
      "example/backend",
      481,
      headSha,
      "run-concurrent-progress",
    );
    await store.writeManifest(
      directory,
      run("run-concurrent-progress", headSha),
    );
    const document = walkthrough(
      "example/backend",
      481,
      "a".repeat(40),
      headSha,
    );
    document.walkthrough.push({
      id: "step-second",
      title: "Inspect the second step",
      reason: "The second behavior needs an independent review step.",
      summary: "Verify the adjacent session behavior.",
      limitations: [],
      dependsOnStepIds: ["step-session"],
      changeGroupId: "group-session",
      flowNodeIds: ["data-flow-node"],
      evidenceIds: ["e-session"],
      testIds: ["test-session"],
      reviewInsightIds: [],
    });
    await store.writeWalkthrough(directory, document);

    await expect(
      Promise.all([
        store.setReviewProgress("example/backend", 481, {
          runId: "run-concurrent-progress",
          stepId: "step-session",
          status: "reviewed",
          note: "Session verified.",
          updatedAt: "ignored",
        }),
        store.setReviewProgress("example/backend", 481, {
          runId: "run-concurrent-progress",
          stepId: "step-second",
          status: "follow-up",
          note: "Check the dependency.",
          updatedAt: "ignored",
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stepId: "step-session" }),
      expect.objectContaining({ stepId: "step-second" }),
    ]);
    await expect(
      store.getReviewProgress(
        "example/backend",
        481,
        "run-concurrent-progress",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "step-session", status: "reviewed" }),
        expect.objectContaining({ stepId: "step-second", status: "follow-up" }),
      ]),
    );
  });

  it("loads bounded persisted diagnostics for an unsuccessful run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const directory = store.runDirectory(
      "example/backend",
      481,
      "b".repeat(40),
      "run-failed",
    );
    await store.writeManifest(directory, {
      ...run("run-failed"),
      status: "failed",
      runtimeVersion: "1.2.3",
      lastProgress: {
        runId: "run-failed",
        stage: "validating",
        message: "Validating output",
        timestamp: "2026-08-04T19:01:00.000Z",
      },
      activity: [
        {
          runId: "run-failed",
          stage: "generating",
          message: "Map batch 1/2 started · 10 source units.",
          timestamp: "2026-08-04T19:00:30.000Z",
        },
        {
          runId: "run-failed",
          stage: "validating",
          message: "Validating output",
          timestamp: "2026-08-04T19:01:00.000Z",
        },
      ],
      error: {
        code: "CLAUDE_FAILED",
        message: "Provider failed.",
        details: ["exit code 1"],
      },
    });
    await store.writeText(
      directory,
      "logs.jsonl",
      `${JSON.stringify({ message: "first line" })}\n${JSON.stringify({ message: "second line" })}`,
    );
    await store.writeText(
      directory,
      "raw-output.txt",
      "Cursor result envelope with a fenced provider response",
    );

    await expect(
      store.loadDiagnostics("example/backend", 481, "run-failed"),
    ).resolves.toMatchObject({
      manifest: {
        runtimeVersion: "1.2.3",
        lastProgress: { stage: "validating", message: "Validating output" },
        activity: [
          expect.objectContaining({ message: "Map batch 1/2 started · 10 source units." }),
          expect.objectContaining({ message: "Validating output" }),
        ],
      },
      error: { code: "CLAUDE_FAILED", details: ["exit code 1"] },
      logExcerpt: ["first line", "second line"],
      rawOutputExcerpt: "Cursor result envelope with a fenced provider response",
    });
  });

  it("does not delete a managed worktree retained by an active analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-store-"));
    const store = new AnalysisStore(root);
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "example",
      "backend",
      "active-head",
    );
    await mkdir(worktree, { recursive: true });
    const expired = new Date(Date.now() - 3 * 86_400_000);
    await utimes(worktree, expired, expired);
    await store.setRetentionSettings({ analysisDays: 7, worktreeDays: 1 });

    await expect(
      store.cleanupExpired(Date.now(), new Set([worktree])),
    ).resolves.toMatchObject({ worktrees: 0 });
    await expect(access(worktree)).resolves.toBeUndefined();
  });
});

function storePath(
  root: string,
  repository: string,
  pullNumber: number,
  headSha: string,
  runId: string,
): string {
  const [owner, repo] = repository.split("/");
  return join(
    root,
    "analyses",
    "github.com",
    owner,
    repo,
    String(pullNumber),
    headSha,
    runId,
  );
}
