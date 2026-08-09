import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AtlasApiCoordinator, startAtlasCoordinator } from "../../electron/backend/coordinator";

const anchor = {
  taskId: "anchor",
  changeGroups: [{ id: "group-1", title: "Change", summary: "Summary.", motivation: "Reason.", previousBehavior: "Before.", newBehavior: "After.", attention: "medium", evidence: [{ path: "src/a.ts", line: 1, role: "changed" }] }],
  stories: [{ id: "story-1", title: "Change story", summary: "One change.", relationshipToPrimary: "primary", relationshipRationale: "It owns the only change.", reviewReason: "Review it first.", changeGroupIds: ["group-1"], dependsOnStoryIds: [] }],
  primaryStoryId: "story-1",
  reviewPlan: ["story-1"],
  domains: ["production-path", "experimental-pocs", "migration-rollback", "updater-installer", "runtime-packaging", "reviewer-workflow"].map((id, index) => ({ id, status: index === 0 ? "changed" : "not-evidenced", rationale: "Grounded.", evidence: index === 0 ? [{ path: "src/a.ts", line: 1, role: "changed" }] : [], changeGroupIds: index === 0 ? ["group-1"] : [] })),
} as const;

async function preflightId(coordinator: AtlasApiCoordinator, token: string, candidate: unknown): Promise<string> {
  const response = await coordinator.preflight(token, candidate);
  if (!response.valid) throw new Error(`expected a valid preflight: ${response.errors.join("; ")}`);
  return response.preflightId;
}

describe("Atlas API coordinator", () => {
  it("promotes only the exact sanitized candidate cached behind a task-scoped preflight receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(
      directory,
      { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
      new Set(),
      undefined,
      (value) => JSON.parse(JSON.stringify(value).replaceAll("secret-token", "[REDACTED]")),
    );
    try {
      const task = coordinator.task("anchor");
      const candidate = { ...anchor, changeGroups: [{ ...anchor.changeGroups[0], summary: "validated secret-token candidate" }] };
      const first = await coordinator.preflight(task.token, candidate);
      expect(first).toMatchObject({ valid: true, errors: [], preflightId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      if (!first.valid) throw new Error("expected valid receipt");

      candidate.changeGroups[0].summary = "mutated after preflight";
      const replacement = await coordinator.preflight(task.token, anchor);
      expect(replacement).toMatchObject({ valid: true, preflightId: expect.any(String) });
      if (!replacement.valid) throw new Error("expected replacement receipt");
      expect(replacement.preflightId).not.toBe(first.preflightId);

      await expect(coordinator.submit(task.token, "stale", first.preflightId)).rejects.toThrow(/receipt.*stale|stale.*receipt/i);
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2 });
      await expect(coordinator.submit(coordinator.task("review").token, "wrong-task", replacement.preflightId)).rejects.toThrow(/receipt.*task|task.*receipt/i);
      expect(coordinator.submissionStats("review")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2 });

      await expect(coordinator.submit(task.token, "accepted", replacement.preflightId)).resolves.toMatchObject({ accepted: true, taskId: "anchor" });
      await expect(coordinator.submit(task.token, "accepted", replacement.preflightId)).resolves.toMatchObject({ accepted: true, idempotent: true });
      const audit = await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8");
      expect(audit).not.toContain("validated secret-token candidate");
      expect(audit).not.toContain("candidate");
      expect(await readFile(join(directory, "coordinator", "results", "anchor.json"), "utf8")).not.toContain("mutated after preflight");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("expires an unsubmitted receipt without spending an atomic attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const task = coordinator.task("anchor");
      const receipt = await preflightId(coordinator, task.token, anchor);
      vi.setSystemTime(new Date("2026-08-09T00:10:00.001Z"));
      await expect(coordinator.submit(task.token, "expired", receipt)).rejects.toThrow(/receipt.*expired|expired.*receipt/i);
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2 });
      expect((coordinator as unknown as { preflightReceipts: Map<string, unknown> }).preflightReceipts.has(receipt)).toBe(false);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a legal submission above 256 KiB, bounds overflow, and remains healthy afterward", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    const server = await startAtlasCoordinator(coordinator);
    try {
      const token = coordinator.task("anchor").token;
      const preflightResponse = await fetch(`${server.url}/v1/preflight_result`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ result: { ...anchor, changeGroups: [{ ...anchor.changeGroups[0], summary: "x".repeat(300 * 1024) }] } }) });
      expect(preflightResponse.status).toBe(200);
      const preflight = await preflightResponse.json() as { valid: boolean; preflightId?: string };
      expect(preflight).toMatchObject({ valid: true, preflightId: expect.any(String) });
      const legal = JSON.stringify({ idempotencyKey: "large-legal", preflightId: preflight.preflightId });
      const accepted = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${server.url}/v1/submit_result`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
        request.on("error", reject); request.end(legal);
      });
      expect(accepted).toBe(200);
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${server.url}/v1/submit_result`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
        request.on("error", reject);
        request.write(Buffer.alloc(2 * 1024 * 1024, "a"));
        request.write(Buffer.alloc(2 * 1024 * 1024, "b"));
        request.write(Buffer.alloc(2 * 1024 * 1024, "c"));
        request.end();
      });
      expect(status).toBe(400);
      const health = await fetch(`${server.url}/v1/get_task`, { headers: { authorization: `Bearer ${token}` } });
      expect(health.status).toBe(200);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps task tokens scoped, rejects malformed submissions without poisoning state, serializes races, and makes same-key replays free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const anchorTask = coordinator.task("anchor");
      expect(() => coordinator.getTask("wrong-token")).toThrow(/token/i);
      await expect(coordinator.preflight(anchorTask.token, { taskId: "anchor" })).resolves.toMatchObject({ valid: false, errors: [expect.any(String)] });
      expect(coordinator.getTask(anchorTask.token)).toMatchObject({ lastValidationFailure: { errors: [expect.any(String)] } });
      expect(coordinator.result("anchor")).toBeNull();
      const acceptedReceipt = await preflightId(coordinator, anchorTask.token, anchor);
      const [first, replay] = await Promise.all([
        coordinator.submit(anchorTask.token, "accepted", acceptedReceipt),
        coordinator.submit(anchorTask.token, "accepted", acceptedReceipt),
      ]);
      expect(first.accepted).toBe(true);
      expect(replay).toMatchObject({ accepted: true, idempotent: true });
      expect(coordinator.getAnchor(coordinator.task("review").token)?.taskId).toBe("anchor");
      const audit = await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8");
      expect(audit).toMatch(/preflight_result/);
      expect(audit).toMatch(/submit_result/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an anchor until changed evidence covers every captured changed path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(
      directory,
      { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
      new Set(["src/a.ts", "src/b.ts"]),
      async () => ({ valid: true, errors: [] }),
      (value) => value,
      {},
      new Map([
        ["src/a.ts", [new Set([1]), new Set([10])]],
        ["src/b.ts", [new Set([1])]],
      ]),
    );
    try {
      const task = coordinator.task("anchor");
      const domainOnly = {
        ...anchor,
        domains: anchor.domains.map((domain) => domain.id === "production-path" ? { ...domain, evidence: [...domain.evidence, { path: "src/a.ts", line: 10, role: "changed" as const }, { path: "src/b.ts", line: 1, role: "changed" as const }] } : domain),
      };
      await expect(coordinator.preflight(task.token, domainOnly)).resolves.toMatchObject({ valid: false, errors: [expect.stringMatching(/missing changed evidence.*src\/b\.ts/i), expect.stringMatching(/changed hunk.*src\/a\.ts:10/i)] });
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2, preflightChecks: 1, remainingPreflightChecks: 2 });
      const complete = {
        ...anchor,
        changeGroups: [{ ...anchor.changeGroups[0], evidence: [...anchor.changeGroups[0].evidence, { path: "src/a.ts", line: 10, role: "changed" as const }, { path: "src/b.ts", line: 1, role: "changed" as const }] }],
      };
      await expect(coordinator.submit(task.token, "complete", await preflightId(coordinator, task.token, complete))).resolves.toMatchObject({ accepted: true, taskId: "anchor" });
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 1, remainingAtomicSubmissionAttempts: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reports repository-relative locators for invalid candidate evidence and deduplicates them in order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(
      directory,
      { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
      new Set(),
      async (reference) => reference.path === "src/b.ts"
        ? { valid: false, errors: ["changed evidence is not an added line in the captured diff"] }
        : reference.path === "src/c.ts"
          ? { valid: false, errors: ["evidence line is outside exact-head file"] }
          : { valid: true, errors: [] },
    );
    try {
      const task = coordinator.task("anchor");
      const invalid = {
        ...anchor,
        changeGroups: [{
          ...anchor.changeGroups[0],
          evidence: [
            { path: "src/b.ts", line: 2, role: "changed" as const },
            { path: "src/b.ts", line: 2, role: "changed" as const },
            { path: "src/c.ts", line: 3, role: "unchanged-context" as const },
          ],
        }],
      };
      await expect(coordinator.validateEvidence(task.token, { path: "src/b.ts", line: 2, role: "changed" })).resolves.toEqual({ valid: false, errors: ["changed evidence is not an added line in the captured diff"] });
      const expected = [
        "src/b.ts:2 (changed): changed evidence is not an added line in the captured diff",
        "src/c.ts:3 (unchanged-context): evidence line is outside exact-head file",
      ];
      await expect(coordinator.preflight(task.token, invalid)).resolves.toEqual({ valid: false, errors: expected });
      await expect(coordinator.submit(task.token, "invalid-locators", "x".repeat(43))).rejects.toThrow(/invalid.*receipt/i);
      const audit = (await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audit.at(-1)?.payload.errors).toEqual(expected);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps a durably accepted result accepted when post-settlement telemetry fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const task = coordinator.task("anchor");
      const receipt = await preflightId(coordinator, task.token, anchor);
      vi.spyOn(coordinator as unknown as { persistProgress: () => Promise<void> }, "persistProgress").mockRejectedValueOnce(new Error("progress write failed"));
      await expect(coordinator.submit(task.token, "accepted", receipt)).resolves.toMatchObject({ accepted: true, taskId: "anchor" });
      expect(coordinator.result("anchor")).toEqual(anchor);
      expect(coordinator.submissionStats("anchor").lastDiagnostic).toMatchObject({ code: "post-settlement-telemetry-failed" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("bounds preflight checks without consuming the atomic submission budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const task = coordinator.task("anchor");
      const settling = await preflightId(coordinator, task.token, anchor);
      expect(JSON.parse(await readFile(join(directory, "coordinator", "progress.json"), "utf8")).preflightChecks.anchor).toEqual({ checks: 1, remainingChecks: 2 });
      await expect(coordinator.preflight(task.token, { taskId: "anchor" })).resolves.toMatchObject({ valid: false });
      const audit = (await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audit.at(-1)).toMatchObject({ event: "preflight_result", payload: { taskId: "anchor", valid: false, errors: [expect.any(String)] } });
      expect(audit.at(-1)?.payload).not.toHaveProperty("candidate");
      expect(coordinator.result("anchor")).toBeNull();
      await expect(coordinator.preflight(task.token, { taskId: "anchor" })).resolves.toMatchObject({ valid: false });
      await expect(coordinator.preflight(task.token, { taskId: "anchor" })).rejects.toThrow(/preflight check limit/i);
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2, preflightChecks: 3, remainingPreflightChecks: 0 });
      expect(coordinator.getTask(task.token)).toMatchObject({ preflight: { checks: 3, remainingChecks: 0 } });
      // A previously valid receipt remains promotable after later rejected preflights.
      await coordinator.submit(task.token, "anchor", settling);
      const specialist = coordinator.task("review");
      for (let index = 0; index < 5; index += 1) await expect(coordinator.preflight(specialist.token, { taskId: "review" })).resolves.toMatchObject({ valid: false });
      await expect(coordinator.preflight(specialist.token, { taskId: "review" })).rejects.toThrow(/preflight check limit/i);
      expect(coordinator.getTask(specialist.token)).toMatchObject({ preflight: { checks: 5, remainingChecks: 0 } });
      expect(coordinator.submissionStats("review")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2, preflightChecks: 5, remainingPreflightChecks: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("compares an in-flight idempotency key payload before joining its accepted result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    let releasePersistence!: () => void;
    const persisted = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const task = coordinator.task("anchor");
      const receipt = await preflightId(coordinator, task.token, anchor);
      const original = (coordinator as unknown as { persistResult: (taskId: string, result: unknown) => Promise<void> }).persistResult.bind(coordinator);
      vi.spyOn(coordinator as unknown as { persistResult: (taskId: string, result: unknown) => Promise<void> }, "persistResult").mockImplementation(async (taskId, result) => { await persisted; return original(taskId, result); });
      const first = coordinator.submit(task.token, "same-key", receipt);
      const identical = coordinator.submit(task.token, "same-key", receipt);
      const different = coordinator.submit(task.token, "same-key", "z".repeat(43));
      releasePersistence();
      await expect(different).rejects.toThrow(/idempotency key reused with different payload/i);
      const [accepted, replay] = await Promise.all([first, identical]);
      expect(accepted).toMatchObject({ accepted: true, taskId: "anchor" });
      expect(replay).toMatchObject({ accepted: true, taskId: "anchor", idempotent: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects an invalid system-overview at flow submission before final assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    const coverage = anchor.domains.map((domain) => ({ domainId: domain.id, status: domain.id === "production-path" ? "covered" : "not-applicable", rationale: "Covered." }));
    const graph = (id: string, system = false) => ({
      id, description: "Relationship graph.",
      nodes: [{ id: `${id}-node`, label: "Node", explanation: "Grounded node.", changed: !system, changeGroupIds: system ? [] : ["group-1"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidence: system ? [] : [{ path: "src/a.ts", line: 1, role: "changed" }] }],
      edges: system ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: "Loops", evidence: [{ path: "src/a.ts", line: 1, role: "changed" }], changeGroupIds: ["group-1"], reviewThreadIds: [] }],
      guidedTours: [{ id: `${id}-tour`, title: "Tour", steps: [{ nodeId: `${id}-node`, title: "Inspect", explanation: "Inspect this node." }] }],
    });
    try {
      const anchorTask = coordinator.task("anchor");
      await coordinator.submit(anchorTask.token, "anchor", await preflightId(coordinator, anchorTask.token, anchor));
      const flows = coordinator.task("flows");
      const result = { taskId: "flows", coverage, content: { graphs: { systemOverview: { ...graph("system-overview", true), nodes: [{ ...graph("system-overview", true).nodes[0], evidence: [{ path: "src/a.ts", line: 2, role: "unchanged-context" }] }] }, dataFlow: graph("data-flow"), codeDependency: graph("code-dependency"), userAction: graph("user-action") } } };
      await expect(coordinator.preflight(flows.token, result)).resolves.toMatchObject({ valid: false, errors: [expect.stringMatching(/Flow nodes violate changed\/unchanged anchor evidence semantics/i)] });
      expect(coordinator.result("flows")).toBeNull();
      expect(coordinator.getTask(flows.token)).toMatchObject({ lastValidationFailure: { errors: [expect.stringMatching(/Flow nodes violate/)] } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects arbitrary receipts without retaining, auditing, or spending atomic attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const task = coordinator.task("anchor");
      for (let index = 0; index < 20; index += 1) await expect(coordinator.submit(task.token, `fresh-${index}`, "x".repeat(42) + index.toString(36).slice(-1))).rejects.toThrow(/receipt/i);
      expect(coordinator.submissionStats("anchor")).toMatchObject({ atomicSubmissionAttempts: 0, remainingAtomicSubmissionAttempts: 2 });
      await expect(readFile(join(directory, "coordinator", "audit.jsonl"), "utf8")).rejects.toThrow();
      expect((coordinator as unknown as { submissions: Map<string, unknown>; inflight: Map<string, unknown> }).submissions.size).toBe(0);
      expect((coordinator as unknown as { submissions: Map<string, unknown>; inflight: Map<string, unknown> }).inflight.size).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a role for exact-head evidence and keeps rejected preflight candidates out of task state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) }, new Set(["src/a.ts"]), async () => ({ valid: true, errors: [] }), (value) => JSON.parse(JSON.stringify(value).replaceAll("secret-token", "[REDACTED]")));
    try {
      const task = coordinator.task("anchor");
      await expect(coordinator.validateEvidence(task.token, { path: "src/a.ts", line: 1 } as never)).resolves.toMatchObject({ valid: false });
      await expect(coordinator.preflight(task.token, { taskId: "anchor", secret: "secret-token" })).resolves.toMatchObject({ valid: false });
      expect(coordinator.getTask(task.token)).toMatchObject({ lastValidationFailure: { errors: [expect.any(String)] } });
      const audit = await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8");
      expect(audit).not.toContain("secret-token");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("bounds, redacts, and caps provider progress before it reaches coordinator artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) }, new Set(), undefined, (value) => JSON.parse(JSON.stringify(value).replaceAll("secret-token", "[REDACTED]")));
    try {
      const live: Array<{ taskId: string; state: string; detail?: string }> = [];
      coordinator.onProgress((update) => live.push(update));
      const token = coordinator.task("anchor").token;
      await coordinator.reportProgress(token, { state: "running", detail: `secret-token /private/worktree ${"x".repeat(2_000)}` });
      for (let index = 1; index < 20; index += 1) await coordinator.reportProgress(token, { state: "running", detail: `update-${index}` });
      await expect(coordinator.reportProgress(token, { state: "complete", detail: "one too many" })).rejects.toThrow(/progress update limit/i);
      const progress = JSON.parse(await readFile(join(directory, "coordinator", "progress.json"), "utf8"));
      expect(progress.tasks.anchor.detail).toBe("update-19");
      expect(progress.preflightChecks.anchor).toEqual({ checks: 0, remainingChecks: 3 });
      expect(live).toHaveLength(20);
      expect(live[0]).toMatchObject({ taskId: "anchor", state: "running" });
      expect(live[0].detail).toContain("[REDACTED] [PATH]");
      expect(live.at(-1)).toMatchObject({ taskId: "anchor", state: "running", detail: "update-19" });
      const audit = await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8");
      expect(audit).not.toContain("secret-token");
      expect(audit).not.toContain("/private/worktree");
      const events = audit.trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.event === "report_progress");
      expect(events).toHaveLength(20);
      expect(events[0].payload.update.detail).toContain("[REDACTED] [PATH]");
      expect(events[0].payload.update.detail.length).toBeLessThanOrEqual(1_000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps preflight correction progress running for live UI and bundle logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    try {
      const live: Array<{ taskId: string; state: string; detail?: string }> = [];
      coordinator.onProgress((update) => live.push(update));
      const token = coordinator.task("anchor").token;
      await expect(coordinator.preflight(token, { taskId: "anchor" })).resolves.toMatchObject({ valid: false });
      expect(live.at(-1)).toMatchObject({ taskId: "anchor", state: "running" });
      expect(live.at(-1)?.detail).toMatch(/required|schema|invalid|domains/i);
      const progress = JSON.parse(await readFile(join(directory, "coordinator", "progress.json"), "utf8"));
      expect(progress.tasks.anchor.state).toBe("running");
      expect(progress.tasks.anchor.detail).toMatch(/required|schema|invalid|domains/i);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("redacts coordinator bearer values and cross-platform absolute paths without removing relative paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) }, new Set(), undefined, (value) => value, {
      pullRequest: { posix: { path: "/private/worktree" }, windows: { filePath: "C:\\Users\\atlas\\secret" }, unc: { path: "\\\\server\\share\\secret" }, relative: { path: "src\\feature.ts" } }, reviewThreads: [{ path: "C:\\private\\thread" }, { path: "\\\\server\\share\\thread" }, { path: "src\\thread.ts" }], reviews: [], issueComments: [], reviewComments: [],
    });
    const server = await startAtlasCoordinator(coordinator);
    try {
      const task = coordinator.task("anchor");
      const token = task.token;
      await coordinator.reportProgress(token, { state: "running", detail: `token ${token} ${server.url} paths /private/worktree C:\\Users\\atlas\\secret \\\\server\\share\\secret src\\feature.ts` });
      await coordinator.submit(token, "redacted-anchor", await preflightId(coordinator, token, { ...anchor, changeGroups: [{ ...anchor.changeGroups[0], summary: `submitted ${token} ${server.url}` }] }));
      const context = coordinator.getPrContext(token);
      expect(context).toMatchObject({ pullRequest: { posix: {}, windows: {}, unc: {}, relative: { path: "src\\feature.ts" } }, reviewThreads: [{}, {}, { path: "src\\thread.ts" }] });
      const persisted = await readFile(join(directory, "coordinator", "results", "anchor.json"), "utf8");
      const audit = await readFile(join(directory, "coordinator", "audit.jsonl"), "utf8");
      for (const secret of [token, server.url, "/private/worktree", "C:\\Users\\atlas\\secret", "\\\\server\\share\\secret"]) {
        expect(persisted).not.toContain(secret);
        expect(audit).not.toContain(secret);
      }
      expect(audit).toContain("[PATH]");
      expect(audit).toContain("[REDACTED]");
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("scopes sanitized PR context to a valid bearer without exposing diff or filesystem artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-coordinator-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) }, new Set(), undefined, (value) => JSON.parse(JSON.stringify(value).replaceAll("secret-token", "[REDACTED]")), { pullRequest: { title: "Safe", diff: "must-not-leak", diffHunk: "also-not-safe", nested: { keep: "canonical metadata", diff_hunk: "nested raw diff", DIFF_HUNK: "case variant" }, path: "/private/worktree", body: "secret-token" }, reviewThreads: [{ path: "src/a.ts", line: 7, commitSha: "abc", patch: "must-not-leak", diffHunk: "must-not-leak", worktree: "/private/worktree" }], reviews: [], issueComments: [], reviewComments: [] });
    try {
      const token = coordinator.task("anchor").token;
      expect(() => coordinator.getPrContext("wrong-token")).toThrow(/token/i);
      expect(coordinator.getPrContext(token)).toEqual({ pullRequest: { title: "Safe", nested: { keep: "canonical metadata" }, body: "[REDACTED]" }, reviewThreads: [{ path: "src/a.ts", line: 7, commitSha: "abc" }], reviews: [], issueComments: [], reviewComments: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
