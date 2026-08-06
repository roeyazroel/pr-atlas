import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, {
  buildEvidenceCodeLines,
  calculateFitZoom,
  mergeGroupEvidenceItems,
  positionedGraphNodeBox,
  routeGraphEdge,
} from "../src/App";
import { pullRequests } from "../src/data/demo";

describe("PR Atlas desktop workflow", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("normalizes source and diff evidence into unified line rows", () => {
    expect(
      buildEvidenceCodeLines(
        "    7 | return true\n    8 | }",
        "worktree",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "source",
        newLine: 7,
        text: "return true",
      }),
      expect.objectContaining({ kind: "source", newLine: 8, text: "}" }),
    ]);
    expect(
      buildEvidenceCodeLines(
        "diff --git a/src/App.tsx b/src/App.tsx\nindex 123..456 100644\nnew file mode 100644\nsimilarity index 95%\nrename from src/Old.tsx\nrename to src/App.tsx\ncopy from src/Old.tsx\ncopy to src/App.tsx\nGIT binary patch\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -10,1 +20,2 @@\n index = 1\n --- separator\n+added\n-removed\n\\ No newline at end of file",
        "analysis-input",
        "@@ -10,1 +20,2 @@",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "context", oldLine: 10, newLine: 20 }),
      expect.objectContaining({ kind: "context", oldLine: 11, newLine: 21 }),
      expect.objectContaining({ kind: "addition", newLine: 22 }),
      expect.objectContaining({ kind: "deletion", oldLine: 12 }),
    ]);
    expect(
      buildEvidenceCodeLines(
        "@@ -10,1 +20,1 @@\n--- value\n+++ value",
        "analysis-input",
        "@@ -10,1 +20,1 @@",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "deletion",
        oldLine: 10,
        text: "-- value",
      }),
      expect.objectContaining({
        kind: "addition",
        newLine: 20,
        text: "++ value",
      }),
    ]);
  });

  it("unions exact group evidence with unlinked application file locations", () => {
    expect(
      mergeGroupEvidenceItems(
        [{ id: "callback-line", path: "apps/web/src/auth/callback.tsx", line: 44 }],
        [
          "apps/web/src/auth/callback.tsx",
          "apps/api/src/session/session.service.ts:96",
          "apps/api/src/session/session.service.ts:96",
        ],
      ),
    ).toEqual([
      { id: "callback-line", path: "apps/web/src/auth/callback.tsx", line: 44 },
      {
        id: "apps/api/src/session/session.service.ts:96",
        path: "apps/api/src/session/session.service.ts",
        line: 96,
      },
    ]);
  });

  it("fits flow surfaces to a measured narrow canvas viewport", () => {
    expect(calculateFitZoom(700, 360, 546, 360)).toBe(78);
    const measuredBounds = { x: 0, y: 0, width: 546, height: 360 };
    const label = routeGraphEdge(
      { x: 456.8, y: 48, width: 132, height: 44 },
      { x: 456.8, y: 268, width: 132, height: 44 },
      2,
      3,
      [],
      [],
      measuredBounds,
    ).label;
    expect(label.x - 60).toBeGreaterThanOrEqual(measuredBounds.x);
    expect(label.x + 60).toBeLessThanOrEqual(
      measuredBounds.x + measuredBounds.width,
    );
  });

  it("routes graph edges from node boundaries and offsets labels into a lane", () => {
    const fromBox = positionedGraphNodeBox(
      { x: 90, y: 70 },
      { width: 132, height: 44 },
      true,
    );
    const toBox = positionedGraphNodeBox(
      { x: 280, y: 70 },
      { width: 132, height: 44 },
      true,
    );
    expect(fromBox).toMatchObject({ x: 76.8, y: 48, width: 132, height: 44 });
    expect(
      routeGraphEdge(
        fromBox,
        toBox,
      ),
    ).toMatchObject({ from: { x: 208.8, y: 70 }, to: { x: 266.8, y: 70 } });
    expect(
      routeGraphEdge(
        { x: 20, y: 20, width: 120, height: 44 },
        { x: 300, y: 160, width: 120, height: 44 },
      ).label,
    ).not.toEqual({ x: 240, y: 114 });
    const graphBounds = { x: 0, y: 0, width: 700, height: 360 };
    const self = routeGraphEdge(fromBox, fromBox, 0, 1, [], [], graphBounds);
    expect(self.path).toMatch(/^M /);
    expect(self.label.x).toBeGreaterThan(fromBox.x + fromBox.width);
    expect(self.label.y).toBeGreaterThan(fromBox.y + fromBox.height);
    expect(self.pathControl?.y).toBeGreaterThan(fromBox.y + fromBox.height);
    expect(self.to.y).toBeGreaterThanOrEqual(fromBox.y + fromBox.height);
    const selfBoundsRect = {
      x: self.label.x - 60,
      y: self.label.y - 12,
      width: 120,
      height: 24,
    };
    expect(selfBoundsRect.x).toBeGreaterThanOrEqual(graphBounds.x);
    expect(selfBoundsRect.y).toBeGreaterThanOrEqual(graphBounds.y);
    expect(selfBoundsRect.x + selfBoundsRect.width).toBeLessThanOrEqual(
      graphBounds.x + graphBounds.width,
    );
    expect(selfBoundsRect.y + selfBoundsRect.height).toBeLessThanOrEqual(
      graphBounds.y + graphBounds.height,
    );
    const selfAbove = routeGraphEdge(fromBox, fromBox, 0, 2);
    const selfBelow = routeGraphEdge(fromBox, fromBox, 1, 2);
    expect(selfAbove.path).not.toEqual(selfBelow.path);
    expect(selfAbove.label.y).toBeLessThan(fromBox.y);
    expect(selfBelow.label.y).toBeGreaterThan(fromBox.y + fromBox.height);
    const selfObstacle = { x: 210, y: -40, width: 80, height: 44 };
    const selfRouted = routeGraphEdge(fromBox, fromBox, 0, 1, [selfObstacle]);
    const selfLabelRect = {
      x: selfRouted.label.x - 60,
      y: selfRouted.label.y - 12,
      width: 120,
      height: 24,
    };
    expect(
      selfLabelRect.x < selfObstacle.x + selfObstacle.width &&
        selfLabelRect.x + selfLabelRect.width > selfObstacle.x &&
        selfLabelRect.y < selfObstacle.y + selfObstacle.height &&
        selfLabelRect.y + selfLabelRect.height > selfObstacle.y,
    ).toBe(false);
    const firstDuplicate = routeGraphEdge(fromBox, toBox, 0, 2);
    const secondDuplicate = routeGraphEdge(fromBox, toBox, 1, 2);
    expect(firstDuplicate.path).not.toEqual(secondDuplicate.path);
    expect(firstDuplicate.label).not.toEqual(secondDuplicate.label);
    expect(
      Math.hypot(
        firstDuplicate.label.x - secondDuplicate.label.x,
        firstDuplicate.label.y - secondDuplicate.label.y,
      ),
    ).toBeGreaterThanOrEqual(24);
    for (const geometry of [firstDuplicate, secondDuplicate]) {
      const labelRect = {
        x: geometry.label.x - 60,
        y: geometry.label.y - 12,
        width: 120,
        height: 24,
      };
      expect(
        labelRect.x < fromBox.x + fromBox.width &&
          labelRect.x + labelRect.width > fromBox.x &&
          labelRect.y < fromBox.y + fromBox.height &&
          labelRect.y + labelRect.height > fromBox.y,
      ).toBe(false);
      expect(
        labelRect.x < toBox.x + toBox.width &&
          labelRect.x + labelRect.width > toBox.x &&
          labelRect.y < toBox.y + toBox.height &&
          labelRect.y + labelRect.height > toBox.y,
      ).toBe(false);
      expect(
        Math.hypot(
          geometry.label.x - (geometry.pathControl?.x ?? 0),
          geometry.label.y - (geometry.pathControl?.y ?? 0),
        ),
      ).toBeGreaterThanOrEqual(18);
    }
    const obstacle = { x: 220, y: 0, width: 40, height: 44 };
    const obstacleRouted = routeGraphEdge(fromBox, toBox, 0, 2, [obstacle]);
    const obstacleLabelRect = {
      x: obstacleRouted.label.x - 60,
      y: obstacleRouted.label.y - 12,
      width: 120,
      height: 24,
    };
    expect(
      obstacleLabelRect.x < obstacle.x + obstacle.width &&
        obstacleLabelRect.x + obstacleLabelRect.width > obstacle.x &&
        obstacleLabelRect.y < obstacle.y + obstacle.height &&
        obstacleLabelRect.y + obstacleLabelRect.height > obstacle.y,
    ).toBe(false);
    const nodeFour = positionedGraphNodeBox(
      { x: 280, y: 180 },
      { width: 132, height: 44 },
      true,
    );
    const nodeThree = positionedGraphNodeBox(
      { x: 90, y: 180 },
      { width: 132, height: 44 },
      true,
    );
    const nonEndpoint = routeGraphEdge(fromBox, nodeFour, 0, 1, [nodeThree]);
    const nonEndpointLabel = {
      x: nonEndpoint.label.x - 60,
      y: nonEndpoint.label.y - 12,
      width: 120,
      height: 24,
    };
    expect(
      nonEndpointLabel.x < nodeThree.x + nodeThree.width &&
        nonEndpointLabel.x + nonEndpointLabel.width > nodeThree.x &&
        nonEndpointLabel.y < nodeThree.y + nodeThree.height &&
        nonEndpointLabel.y + nonEndpointLabel.height > nodeThree.y,
    ).toBe(false);
    const verticalFrom = { x: 266.8, y: 48, width: 132, height: 44 };
    const verticalTo = { x: 266.8, y: 268, width: 132, height: 44 };
    const verticalObstacles = [
      { x: 266.8, y: 158, width: 132, height: 44 },
      { x: 76.8, y: 158, width: 132, height: 44 },
    ];
    const vertical = routeGraphEdge(
      verticalFrom,
      verticalTo,
      0,
      1,
      verticalObstacles,
    );
    const verticalLabelRect = {
      x: vertical.label.x - 60,
      y: vertical.label.y - 12,
      width: 120,
      height: 24,
    };
    for (const obstacle of verticalObstacles) {
      expect(
        verticalLabelRect.x < obstacle.x + obstacle.width &&
          verticalLabelRect.x + verticalLabelRect.width > obstacle.x &&
          verticalLabelRect.y < obstacle.y + obstacle.height &&
        verticalLabelRect.y + verticalLabelRect.height > obstacle.y,
      ).toBe(false);
    }
    const horizontalFrom = { x: 76.8, y: 48, width: 132, height: 44 };
    const horizontalTo = { x: 456.8, y: 48, width: 132, height: 44 };
    const crossingPath = routeGraphEdge(verticalFrom, verticalTo);
    const crossing = routeGraphEdge(
      horizontalFrom,
      horizontalTo,
      0,
      1,
      [horizontalFrom, horizontalTo],
      [{ from: crossingPath.from, to: crossingPath.to }],
    );
    const crossingLabelRect = {
      x: crossing.label.x - 60,
      y: crossing.label.y - 12,
      width: 120,
      height: 24,
    };
    const crossingPathBounds = {
      minX: Math.min(crossingPath.from.x, crossingPath.to.x) - 6,
      maxX: Math.max(crossingPath.from.x, crossingPath.to.x) + 6,
      minY: Math.min(crossingPath.from.y, crossingPath.to.y) - 6,
      maxY: Math.max(crossingPath.from.y, crossingPath.to.y) + 6,
    };
    expect(
      crossingLabelRect.x < crossingPathBounds.maxX &&
        crossingLabelRect.x + crossingLabelRect.width > crossingPathBounds.minX &&
        crossingLabelRect.y < crossingPathBounds.maxY &&
        crossingLabelRect.y + crossingLabelRect.height > crossingPathBounds.minY,
    ).toBe(false);
    const parallelFrom = { x: 76.8, y: 48, width: 132, height: 44 };
    const parallelTo = { x: 76.8, y: 268, width: 132, height: 44 };
    const parallel = routeGraphEdge(
      parallelFrom,
      parallelTo,
      2,
      3,
      [],
      [],
      graphBounds,
    );
    const parallelLabelRect = {
      x: parallel.label.x - 60,
      y: parallel.label.y - 12,
      width: 120,
      height: 24,
    };
    expect(parallelLabelRect.x).toBeGreaterThanOrEqual(graphBounds.x);
    expect(parallelLabelRect.y).toBeGreaterThanOrEqual(graphBounds.y);
    expect(parallelLabelRect.x + parallelLabelRect.width).toBeLessThanOrEqual(
      graphBounds.x + graphBounds.width,
    );
    expect(parallelLabelRect.y + parallelLabelRect.height).toBeLessThanOrEqual(
      graphBounds.y + graphBounds.height,
    );
  });

  it("closes settings with an outside click and Escape while preserving inside interaction", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(screen.getByText("Workspace settings")).toBeInTheDocument();
    await user.click(screen.getByText("Theme"));
    expect(screen.getByText("Workspace settings")).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByText("Workspace settings")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open settings/i }));
    await user.click(screen.getByLabelText(/active provider:/i));
    expect(screen.queryByText("Workspace settings")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Workspace settings")).not.toBeInTheDocument();
  });

  it("defaults to the system theme and exposes accessible theme controls in settings", async () => {
    const user = userEvent.setup();
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-color-scheme: dark"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    render(<App />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(screen.getByRole("group", { name: /theme/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^system$/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^light$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^dark$/i })).toBeInTheDocument();
  });

  it("persists explicit theme choices and applies them to the document", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<App />);

    await user.click(screen.getByRole("button", { name: /open settings/i }));
    await user.click(screen.getByRole("radio", { name: /^dark$/i }));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(
      JSON.parse(window.localStorage.getItem("atlas:theme") ?? "null"),
    ).toBe("dark");

    await user.click(screen.getByRole("radio", { name: /^light$/i }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(
      JSON.parse(window.localStorage.getItem("atlas:theme") ?? "null"),
    ).toBe("light");
  });

  it("tracks operating-system theme changes while System is selected", async () => {
    const user = userEvent.setup();
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: (
        _type: string,
        callback: (event: MediaQueryListEvent) => void,
      ) => {
        listener = callback;
      },
      removeEventListener: vi.fn(),
    }));
    render(<App />);

    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => listener?.({ matches: true } as MediaQueryListEvent));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await user.click(screen.getByRole("radio", { name: /^light$/i }));
    act(() => listener?.({ matches: false } as MediaQueryListEvent));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("opens with the demo repository and a selected pull request", () => {
    render(<App />);

    expect(screen.getByText("PR Atlas", { exact: true })).toBeInTheDocument();
    expect(document.querySelector(".brand-mark")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select repository/i }),
    ).toHaveTextContent("runway/atlas");
    const list = screen.getByRole("list", { name: /pull request list/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getByRole("listitem", { name: /#482/i })).toHaveClass(
      "selected",
    );
  });

  it("renders the PR Atlas wordmark with an accessible text label", () => {
    render(<App />);

    expect(screen.getByText("PR Atlas", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("LOCAL MVP")).not.toBeInTheDocument();
  });

  it("filters the pull-request list without losing the selected item", async () => {
    const user = userEvent.setup();
    render(<App />);

    const list = screen.getByRole("list", { name: /pull request list/i });
    const initialCards = within(list).getAllByRole("listitem");
    expect(initialCards.length).toBeGreaterThan(1);

    await user.click(screen.getByRole("tab", { name: /^ready$/i }));

    const filteredCards = within(list).getAllByRole("listitem");
    expect(filteredCards.length).toBeLessThan(initialCards.length);
    expect(within(list).getByRole("listitem", { name: /#482/i })).toHaveClass(
      "selected",
    );
  });

  it("switches the selected PR between overview and walkthrough", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("button", { name: /^overview$/i })).toHaveClass(
      "active",
    );

    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));

    expect(screen.getByRole("button", { name: /^walkthrough$/i })).toHaveClass(
      "active",
    );
    expect(screen.getByText(/guided review/i)).toBeInTheDocument();
  });

  it("renders the ready demo PR from its rich 1.1 walkthrough instead of fallback copy", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByText(
        "Refresh tokens rotate at the server boundary before a workspace request can reuse the old credential.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The session service becomes the only owner of refresh-token hashing and rotation.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Parallel refresh handling is covered as a bounded retry, not a distributed lock proof.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No user-visible changes were specified."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("2 covered")).toBeInTheDocument();
    expect(screen.getByText("1 partial · 1 missing")).toBeInTheDocument();
    expect(
      screen.getByText("Review server-side token rotation"),
    ).toBeInTheDocument();

    const fixture = pullRequests.find((pr) => pr.id === "atlas-482");
    const firstStep = fixture?.walkthrough?.walkthrough[0];
    expect(fixture?.walkthrough?.schemaVersion).toBe("1.1.0");
    expect(firstStep).toMatchObject({
      reason:
        "Review the credential boundary first because every callback and refresh path depends on it.",
      evidenceIds: ["demo-session-file", "demo-rotate-symbol"],
      flowNodeIds: ["data-flow-2", "data-flow-3"],
      testIds: ["test1", "test3"],
      reviewInsightIds: ["i1"],
      limitations: [
        "The fixture does not model a provider-side token revocation event.",
      ],
    });

    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));
    expect(
      screen.getByText(/guided review · step 1 of 4/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Review the credential boundary first because every callback and refresh path depends on it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The fixture does not model a provider-side token revocation event.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/apps\/api\/src\/session\/session\.service\.ts/),
    ).not.toHaveLength(0);
    expect(screen.getByText(/rotates token after refresh/)).toBeInTheDocument();
    expect(
      screen.getByText(/Rotation can invalidate parallel requests/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Refresh token data: normalize/i }),
    );
    expect(
      screen.getByRole("heading", { name: "Refresh token data" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Selected: normalize()")).toBeInTheDocument();
    expect(screen.queryByText("Selected: OAuth callback")).not.toBeInTheDocument();
  });

  it("keeps a failed fixture run visibly failed in analysis history", async () => {
    const user = userEvent.setup();
    render(<App />);

    const list = screen.getByRole("list", { name: /pull request list/i });
    await user.click(
      within(list).getByRole("listitem", { name: /#441 tighten webhook/i }),
    );
    await user.click(screen.getByRole("button", { name: /analysis details/i }));

    const history = document.querySelector(".history-row");
    expect(history).not.toBeNull();
    expect(
      within(history as HTMLElement).getByText(/^failed$/i),
    ).toBeInTheDocument();
    expect(
      within(history as HTMLElement).queryByText(/^active$/i),
    ).not.toBeInTheDocument();
  });

  it("keeps notes scoped to each hydrated walkthrough step while navigating and saving", async () => {
    const user = userEvent.setup();
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    };
    const repository = {
      source: "github" as const,
      id: "repo-notes",
      name: "notes",
      fullName: "runway/notes",
      owner: "runway",
      private: true,
      defaultBranch: "main",
      updatedAt: "2026-08-05T08:00:00.000Z",
      url: "https://github.com/runway/notes",
    };
    const pullRequest = {
      source: "github" as const,
      id: "pr-notes",
      repository: repository.fullName,
      number: 77,
      title: "Keep walkthrough notes scoped",
      url: "https://github.com/runway/notes/pull/77",
      state: "open",
      author: "maya",
      baseRef: "main",
      headRef: "feature/notes",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      updatedAt: "2026-08-05T08:00:00.000Z",
      isDraft: false,
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      labels: [],
      reviewDecision: null,
      reviewRequested: false,
    };
    const baseDocument = pullRequests.find(
      (pr) => pr.id === "atlas-482",
    )!.walkthrough!;
    const document = {
      ...baseDocument,
      run: { ...baseDocument.run, id: "run-notes", provider: "claude" },
      pullRequest: {
        ...baseDocument.pullRequest,
        repository: repository.fullName,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      },
    };
    const summary = {
      runId: "run-notes",
      repository: repository.fullName,
      pullNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      provider: "claude" as const,
      status: "ready" as const,
      createdAt: "2026-08-05T08:00:00.000Z",
      schemaVersion: "1.1.0",
      artifactDirectory: "/tmp/run-notes",
    };
    const setReviewProgress = vi.fn(
      async (_repository, _number, value) => value,
    );
    const api = {
      bootstrap: vi.fn(async () => ({
        account: null,
        repositories: [repository],
        warnings: [],
      })),
      listProviders: vi.fn(async () => [
        {
          provider: "claude",
          displayName: "Claude Code",
          executable: "claude",
          installed: true,
          capabilities,
        },
      ]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis: vi.fn(),
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => [summary]),
      loadAnalysisRun: vi.fn(async () => ({
        runId: summary.runId,
        status: "ready" as const,
        document,
        manifest: summary,
        artifactDirectory: summary.artifactDirectory,
      })),
      getReviewProgress: vi.fn(async () => [
        {
          runId: summary.runId,
          stepId: "step-session-boundary",
          status: "pending" as const,
          note: "hydrated first",
          updatedAt: "2026-08-05T08:01:00.000Z",
        },
        {
          runId: summary.runId,
          stepId: "step-callback-handoff",
          status: "pending" as const,
          note: "hydrated second",
          updatedAt: "2026-08-05T08:01:00.000Z",
        },
      ]),
      setReviewProgress,
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "prAtlas", {
      configurable: true,
      writable: true,
      value: api,
    });
    try {
      render(<App />);
      await user.click(
        await screen.findByRole("listitem", {
          name: /#77 keep walkthrough notes scoped/i,
        }),
      );
      await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));
      const note = await screen.findByRole("textbox", { name: /review note/i });
      expect(note).toHaveValue("hydrated first");
      await user.clear(note);
      await user.type(note, "first draft");
      await user.click(
        screen.getByRole("button", {
          name: /step 2: review callback handoff ordering/i,
        }),
      );
      expect(screen.getByRole("textbox", { name: /review note/i })).toHaveValue(
        "hydrated second",
      );
      await user.clear(screen.getByRole("textbox", { name: /review note/i }));
      await user.type(
        screen.getByRole("textbox", { name: /review note/i }),
        "second draft",
      );
      await user.click(
        screen.getByRole("button", { name: /needs follow-up/i }),
      );
      await waitFor(() =>
        expect(setReviewProgress).toHaveBeenCalledWith(
          repository.fullName,
          pullRequest.number,
          expect.objectContaining({
            stepId: "step-callback-handoff",
            note: "second draft",
          }),
        ),
      );
      await user.click(screen.getByRole("button", { name: /next step/i }));
      await user.click(screen.getByRole("button", { name: /previous/i }));
      expect(screen.getByRole("textbox", { name: /review note/i })).toHaveValue(
        "second draft",
      );
      await user.click(
        screen.getByRole("button", {
          name: /step 1: review server-side token rotation/i,
        }),
      );
      expect(screen.getByRole("textbox", { name: /review note/i })).toHaveValue(
        "first draft",
      );
      await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
      await waitFor(() =>
        expect(setReviewProgress).toHaveBeenCalledWith(
          repository.fullName,
          pullRequest.number,
          expect.objectContaining({
            stepId: "step-session-boundary",
            note: "first draft",
          }),
        ),
      );
    } finally {
      Object.defineProperty(window, "prAtlas", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it("shows analysis progress and returns to idle when cancelled", async () => {
    const user = userEvent.setup();
    render(<App />);

    const list = screen.getByRole("list", { name: /pull request list/i });
    await user.click(within(list).getByRole("listitem", { name: /#455/i }));
    expect(screen.getAllByRole("button", { name: /^analyze$/i })).toHaveLength(
      1,
    );
    await user.click(screen.getByRole("button", { name: /^analyze$/i }));

    expect(screen.getByText(/building your walkthrough/i)).toBeInTheDocument();
    expect(screen.getByText(/stage 1 of 6/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/analysis may take several minutes/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(
      screen.getByText(/walkthrough not generated yet/i),
    ).toBeInTheDocument();
  });

  it("completes local analysis into a rendered walkthrough", async () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const list = screen.getByRole("list", { name: /pull request list/i });
      fireEvent.click(within(list).getByRole("listitem", { name: /#455/i }));
      fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));

      await act(async () => {
        vi.advanceTimersByTime(6500);
      });

      expect(
        screen.getByRole("heading", { name: /session ownership/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/walkthrough not generated yet/i),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps live provider analysis running while the IPC request is pending", async () => {
    vi.useFakeTimers();
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    };
    const repository = {
      source: "github",
      id: "repo-live",
      name: "atlas",
      fullName: "runway/atlas",
      owner: "runway",
      private: true,
      defaultBranch: "main",
      updatedAt: "2026-08-04T08:00:00.000Z",
      url: "https://github.com/runway/atlas",
    };
    const pullRequest = {
      source: "github",
      id: "pr-live",
      repository: repository.fullName,
      number: 42,
      title: "Pending live analysis",
      url: "https://github.com/runway/atlas/pull/42",
      state: "open",
      author: "maya",
      baseRef: "main",
      headRef: "feature/live",
      baseSha: "base-sha",
      headSha: "head-sha",
      updatedAt: "2026-08-04T08:30:00.000Z",
      isDraft: false,
      additions: 1_200,
      deletions: 150,
      changedFiles: 30,
      labels: [],
      reviewDecision: null,
      reviewRequested: false,
    };
    const startAnalysis = vi.fn(() => new Promise<never>(() => undefined));
    let progressListener:
      | ((event: {
          runId: string;
          stage: "generating" | "validating";
          message: string;
          timestamp: string;
        }) => void)
      | undefined;
    const api = {
      bootstrap: vi.fn(async () => ({
        account: null,
        repositories: [repository],
        warnings: [],
      })),
      listProviders: vi.fn(async () => [
        {
          provider: "claude",
          displayName: "Claude Code",
          executable: "claude",
          installed: true,
          version: "1.2.3",
          capabilities,
        },
      ]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis,
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => []),
      loadAnalysisRun: vi.fn(async () => null),
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn((listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    };
    Object.defineProperty(window, "prAtlas", {
      configurable: true,
      writable: true,
      value: api,
    });
    try {
      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api.bootstrap).toHaveBeenCalled();
      expect(api.listProviders).toHaveBeenCalled();
      expect(api.listPullRequests).toHaveBeenCalled();
      const list = screen.getByRole("list", { name: /pull request list/i });
      fireEvent.click(
        within(list).getByRole("listitem", {
          name: /#42 pending live analysis/i,
        }),
      );
      expect(
        screen.getAllByRole("button", { name: /^analyze$/i }),
      ).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
      expect(
        screen.getByText(
          /large pr: 30 files and 1,350 changed lines\. analysis may take several minutes\./i,
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      expect(startAnalysis).toHaveBeenCalledTimes(1);

      act(() => {
        progressListener?.({
          runId: "run-live",
          stage: "generating",
          message: "Map batch 1/2 started · 10 source units.",
          timestamp: "2026-08-06T06:28:00.000Z",
        });
        progressListener?.({
          runId: "run-live",
          stage: "validating",
          message: "Reducer started · combining 2 validated map batches.",
          timestamp: "2026-08-06T06:29:00.000Z",
        });
      });

      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(
        screen.getByText(/building your walkthrough/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/stage 5 of 6/i)).toBeInTheDocument();
      expect(
        screen.getByRole("log", { name: /agent activity/i }),
      ).toHaveTextContent("Map batch 1/2 started");
      expect(
        screen.getByRole("log", { name: /agent activity/i }),
      ).toHaveTextContent("Reducer started");
      expect(
        screen.getByText(
          /large pr: 30 files and 1,350 changed lines\. analysis may take several minutes\./i,
        ),
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "prAtlas", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      vi.useRealTimers();
    }
  });

  it("offers same-head reruns for a ready live pull request with the selected provider", async () => {
    const user = userEvent.setup();
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    };
    const repository = {
      source: "github",
      id: "repo-rerun",
      name: "atlas",
      fullName: "runway/atlas",
      owner: "runway",
      private: true,
      defaultBranch: "main",
      updatedAt: "2026-08-04T08:00:00.000Z",
      url: "https://github.com/runway/atlas",
    };
    const pullRequest = {
      source: "github",
      id: "pr-rerun",
      repository: repository.fullName,
      number: 43,
      title: "Ready live walkthrough",
      url: "https://github.com/runway/atlas/pull/43",
      state: "open",
      author: "maya",
      baseRef: "main",
      headRef: "feature/rerun",
      baseSha: "base-sha-rerun",
      headSha: "head-sha-rerun",
      updatedAt: "2026-08-04T08:30:00.000Z",
      isDraft: false,
      additions: 4,
      deletions: 2,
      changedFiles: 2,
      labels: [],
      reviewDecision: null,
      reviewRequested: false,
    };
    const graph = (id: string) => ({
      id,
      nodes: [],
      edges: [],
      guidedTours: [],
    });
    const document = {
      schemaVersion: "1.1.0",
      run: {
        id: "run-rerun",
        createdAt: "2026-08-04T08:35:00.000Z",
        provider: "codex",
        model: "codex-test",
        skillVersion: "test",
      },
      pullRequest: {
        host: "github.com",
        repository: repository.fullName,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      },
      summary: {
        intent: "Ready live walkthrough",
        behavioralChanges: [],
        architecturalImpact: [],
        limitations: [],
      },
      changeGroups: [],
      walkthrough: [],
      graphs: {
        systemOverview: graph("system-overview"),
        dataFlow: graph("data-flow"),
        codeDependency: graph("code-dependency"),
        userAction: graph("user-action"),
      },
      tests: [],
      reviewThreads: [],
      reviewInsights: [],
      evidence: [],
    };
    const runResult = {
      runId: "run-rerun",
      status: "ready",
      document,
      manifest: {
        runId: "run-rerun",
        repository: repository.fullName,
        pullNumber: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        provider: "codex",
        status: "ready",
        createdAt: "2026-08-04T08:35:00.000Z",
        schemaVersion: "1.1.0",
        artifactDirectory: "/tmp/run-rerun",
      },
      artifactDirectory: "/tmp/run-rerun",
    };
    const startAnalysis = vi.fn(async () => runResult);
    const deleteAnalysisRun = vi.fn(async () => true);
    const api = {
      bootstrap: vi.fn(async () => ({
        account: null,
        repositories: [repository],
        warnings: [],
      })),
      listProviders: vi.fn(async () => [
        {
          provider: "claude",
          displayName: "Claude Code",
          executable: "claude",
          installed: true,
          version: "1.2.3",
          capabilities,
        },
        {
          provider: "codex",
          displayName: "Codex CLI",
          executable: "codex",
          installed: true,
          version: "0.9.0",
          capabilities,
        },
      ]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis,
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => []),
      loadAnalysisRun: vi.fn(async () => null),
      deleteAnalysisRun,
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "prAtlas", {
      configurable: true,
      writable: true,
      value: api,
    });
    try {
      render(<App />);
      await user.click(
        await screen.findByRole("listitem", {
          name: /#43 ready live walkthrough/i,
        }),
      );
      await user.click(screen.getByRole("button", { name: /open settings/i }));
      await user.click(screen.getByRole("radio", { name: /codex cli/i }));
      await user.click(screen.getByRole("button", { name: /open settings/i }));

      await user.click(screen.getByRole("button", { name: /^analyze$/i }));
      expect(
        screen.getByRole("heading", {
          name: /send repository context to codex cli/i,
        }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(startAnalysis).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: /analyze again/i }),
      ).toBeInTheDocument();
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      await user.click(
        screen.getByRole("button", { name: /analysis details/i }),
      );
      expect(screen.getByText("Just now")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(deleteAnalysisRun).toHaveBeenCalledWith(
        repository.fullName,
        pullRequest.number,
        runResult.runId,
      );
      expect(screen.queryByText("Just now")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /open historical run/i }),
      ).not.toBeInTheDocument();
      confirm.mockRestore();
      await user.click(screen.getByRole("button", { name: /analyze again/i }));
      expect(
        screen.getByRole("heading", {
          name: /send repository context to codex cli/i,
        }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(startAnalysis).toHaveBeenCalledTimes(2);
      expect(startAnalysis).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: "codex",
          headSha: pullRequest.headSha,
        }),
      );
    } finally {
      Object.defineProperty(window, "prAtlas", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it.each([
    ["failed", "CLAUDE_FAILED"],
    ["invalid", "INVALID_WALKTHROUGH"],
    ["cancelled", "CANCELLED"],
  ] as const)(
    "shows a newly %s run in diagnostics, history, and retry controls without refresh",
    async (status, errorCode) => {
    const user = userEvent.setup();
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    };
    const repository = {
      source: "github",
      id: "repo-diagnostics",
      name: "atlas",
      fullName: "runway/atlas",
      owner: "runway",
      private: true,
      defaultBranch: "main",
      updatedAt: "2026-08-04T08:00:00.000Z",
      url: "https://github.com/runway/atlas",
    };
    const pullRequest = {
      source: "github",
      id: "pr-diagnostics",
      repository: repository.fullName,
      number: 44,
      title: "Failed live walkthrough",
      url: "https://github.com/runway/atlas/pull/44",
      state: "open",
      author: "maya",
      baseRef: "main",
      headRef: "feature/failed",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      updatedAt: "2026-08-04T08:30:00.000Z",
      isDraft: false,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      labels: [],
      reviewDecision: null,
      reviewRequested: false,
    };
    const terminal = {
      runId: `${status}-run`,
      repository: repository.fullName,
      pullNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      provider: "claude" as const,
      status,
      createdAt: "2026-08-04T08:35:00.000Z",
      runtimeVersion: "1.2.3",
      lastProgress: {
        runId: `${status}-run`,
        stage: "validating" as const,
        message: "Validating output",
        timestamp: "2026-08-04T08:36:00.000Z",
      },
      error: {
        code: errorCode,
        message: "The provider exited before returning JSON.",
        details: ["exit code 1"],
      },
      artifactDirectory: "/tmp/failed-run",
    };
    const loadAnalysisDiagnostics = vi.fn(async () => ({
      manifest: terminal,
      error: terminal.error,
      logExcerpt: ["stderr: malformed response"],
      rawOutputExcerpt: "provider result envelope",
    }));
    const exportAnalysisDiagnostics = vi.fn(async () => ({
      saved: true,
      filePath: "/tmp/pr-atlas-diagnostics.json",
    }));
    const startAnalysis = vi.fn(async () => ({
      runId: terminal.runId,
      status: terminal.status,
      manifest: terminal,
      error: terminal.error,
      artifactDirectory: terminal.artifactDirectory,
    }));
    const writeText = vi.fn(async () => undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const api = {
      bootstrap: vi.fn(async () => ({
        account: null,
        repositories: [repository],
        warnings: [],
      })),
      listProviders: vi.fn(async () => [
        {
          provider: "claude",
          displayName: "Claude Code",
          executable: "claude",
          installed: true,
          version: "1.2.3",
          capabilities,
        },
        {
          provider: "codex",
          displayName: "Codex CLI",
          executable: "codex",
          installed: true,
          version: "0.9.0",
          capabilities,
        },
      ]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis,
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => []),
      loadAnalysisRun: vi.fn(async () => null),
      loadAnalysisDiagnostics,
      exportAnalysisDiagnostics,
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "prAtlas", {
      configurable: true,
      writable: true,
      value: api,
    });
    try {
      render(<App />);
      await user.click(
        await screen.findByRole("listitem", {
          name: /#44 failed live walkthrough/i,
        }),
      );
      await user.click(screen.getByRole("button", { name: /^analyze$/i }));
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(startAnalysis).toHaveBeenCalledTimes(1);
      expect(api.listAnalysisRuns).toHaveBeenCalledTimes(1);
      const failure = await screen.findByRole("region", {
        name: /analysis failure/i,
      });
      expect(failure).toHaveTextContent(
        status === "cancelled" ? "Analysis cancelled" : "Analysis failed",
      );
      expect(failure).toHaveTextContent(errorCode);
      expect(failure).toHaveTextContent("Validating output");
      await user.click(
        within(failure).getByRole("button", {
          name: /save diagnostic report/i,
        }),
      );
      expect(exportAnalysisDiagnostics).toHaveBeenCalledWith(
        repository.fullName,
        pullRequest.number,
        terminal.runId,
      );
      await user.click(
        within(failure).getByRole("button", {
          name: /view analysis details/i,
        }),
      );
      const diagnostics = await screen.findByRole("region", {
        name: /analysis diagnostics/i,
      });
      expect(diagnostics).toHaveTextContent(errorCode);
      expect(diagnostics).toHaveTextContent("1.2.3");
      expect(diagnostics).toHaveTextContent("validating: Validating output");
      expect(
        screen.getByText("Just now").closest(".history-row"),
      ).toHaveTextContent(new RegExp(status, "i"));
      await user.click(
        screen.getByRole("button", { name: /copy diagnostics/i }),
      );
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining(errorCode),
      );
      await user.click(
        screen.getByRole("button", { name: /retry with codex cli/i }),
      );
      expect(
        screen.getByRole("heading", {
          name: /send repository context to codex cli/i,
        }),
      ).toBeInTheDocument();
      expect(loadAnalysisDiagnostics).toHaveBeenCalledWith(
        repository.fullName,
        pullRequest.number,
        terminal.runId,
      );
    } finally {
      Object.defineProperty(window, "prAtlas", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
    },
  );

  it("persists the reviewed state while moving around the walkthrough", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));
    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    expect(
      screen.getByRole("button", { name: /reviewed/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^overview$/i }));
    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));

    expect(
      screen.getByRole("button", { name: /reviewed/i }),
    ).toBeInTheDocument();
  });

  it("does not bleed review progress between pull requests sharing group ids", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));
    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    expect(
      screen.getByRole("button", { name: /reviewed/i }),
    ).toBeInTheDocument();

    const list = screen.getByRole("list", { name: /pull request list/i });
    await user.click(within(list).getByRole("listitem", { name: /#476/i }));
    await user.click(screen.getByRole("button", { name: /^walkthrough$/i }));

    expect(
      screen.getByRole("button", { name: /mark reviewed/i }),
    ).toBeInTheDocument();
  });

  it.each([
    ["system", /system/i, "Request lifecycle"],
    ["data", /data/i, "Refresh token data"],
    ["dependency", /dependency/i, "Module dependencies"],
    ["user", /user/i, "User sign-in"],
  ])("changes the flow view to %s", async (_, label, expectedTitle) => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^flows$/i }));
    const flowTab = screen.getByRole("tab", { name: label });
    await user.click(flowTab);

    expect(flowTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: expectedTitle }),
    ).toBeInTheDocument();
  });
});
