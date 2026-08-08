/**
 * Provider-neutral localhost coordinator for anchored scans.  Providers only
 * receive a bearer token and use this contract; repository inspection remains
 * read-only and happens in their own exact-head worktree.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnchoredTaskKind, AnchoredTaskOutput, ProviderAnalysisTask, SemanticAnchor } from "../../shared/contracts.js";
import { anchoredSchemaForProvider, validateAnchoredTaskOutput } from "./anchored-analysis.js";

const TASKS: readonly AnchoredTaskKind[] = ["anchor", "walkthrough", "tests-risks", "flows"];
const MAX_ATOMIC_SUBMISSIONS = 2;
const MAX_COORDINATOR_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_UPDATES = 20;
const MAX_PROGRESS_DETAIL_CHARS = 1_000;
type Identity = { repository: string; pullNumber: number; baseSha: string; headSha: string };
type TaskRecord = { kind: AnchoredTaskKind; id: string; token: string };
type EvidenceValidation = (reference: { path: string; line: number; role: "changed" | "unchanged-context" }) => Promise<{ valid: boolean; errors: string[] }>;
type Submission = { digest: string; response?: CoordinatorSubmitResponse; errors?: string[] };
export type CoordinatorSubmitResponse = { accepted: true; taskId: string; snapshotVersion: number; idempotent?: true };
type PrContext = { pullRequest: unknown; reviewThreads: unknown[]; reviews: unknown[]; issueComments: unknown[]; reviewComments: unknown[] };

function clone<T>(value: T): T { return structuredClone(value); }
function digest(value: unknown): string { return JSON.stringify(value); }
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isAbsolutePath(value: string): boolean { return /^(?:\/(?!\/)|~[\\/]|[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/\/[^\\/]+[\\/][^\\/]+)/i.test(value); }
function changedEvidenceLines(value: unknown, lines = new Map<string, Set<number>>()): Map<string, Set<number>> {
  if (Array.isArray(value)) {
    for (const item of value) changedEvidenceLines(item, lines);
  } else if (isRecord(value)) {
    if (safeText(value.path) && value.role === "changed" && Number.isInteger(value.line)) {
      const pathLines = lines.get(value.path) ?? new Set<number>();
      pathLines.add(value.line as number);
      lines.set(value.path, pathLines);
    }
    for (const item of Object.values(value)) changedEvidenceLines(item, lines);
  }
  return lines;
}
function redactProgressDetail(value: string): string { return value.replace(/(^|[\s"'`=([{,])(?:(?:~[\\/]|\/(?!\/))[^\s"'`)}\],]+|(?:[a-z]:[\\/]|\\\\|\/\/)[^\s"'`)}\],]+)/gi, "$1[PATH]"); }
function redactSecrets(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") return [...secrets].reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, secrets)]));
}
function sanitizePrContext(value: unknown, sanitize: (value: unknown) => unknown): PrContext {
  const forbidden = new Set(["diff", "patch", "diffhunk", "worktree", "directory", "artifactdirectory", "inputdirectory"]);
  const scrub = (entry: unknown, depth = 0): unknown => {
    if (typeof entry === "string" || !entry || typeof entry !== "object") return entry;
    if (depth > 20) throw new Error("sanitized PR context exceeds the supported nesting depth");
    if (Array.isArray(entry)) return entry.map((item) => scrub(item, depth + 1));
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([key, item]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const pathField = normalized === "path" || normalized.endsWith("path");
      return !forbidden.has(normalized) && !(pathField && typeof item === "string" && isAbsolutePath(item));
    }).map(([key, item]) => [key, scrub(item, depth + 1)]));
  };
  const source = scrub(sanitize(value)) as Record<string, unknown>;
  const context = { pullRequest: source?.pullRequest ?? null, reviewThreads: Array.isArray(source?.reviewThreads) ? source.reviewThreads : [], reviews: Array.isArray(source?.reviews) ? source.reviews : [], issueComments: Array.isArray(source?.issueComments) ? source.issueComments : [], reviewComments: Array.isArray(source?.reviewComments) ? source.reviewComments : [] };
  if (Buffer.byteLength(JSON.stringify(context)) > 4 * 1024 * 1024) throw new Error("sanitized PR context exceeds the 4 MiB response limit");
  return context;
}

export class AtlasApiCoordinator {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly byToken = new Map<string, TaskRecord>();
  private readonly results = new Map<string, AnchoredTaskOutput>();
  private readonly attempts = new Map<string, number>();
  private readonly progressUpdates = new Map<string, number>();
  private readonly submissions = new Map<string, Submission>();
  private readonly inflight = new Map<string, Promise<CoordinatorSubmitResponse>>();
  private readonly progress = new Map<string, { state: "pending" | "running" | "complete" | "failed"; detail?: string; updatedAt: string }>();
  private readonly validationFailures = new Map<string, { result: unknown; errors: string[] }>();
  private readonly lastDiagnostics = new Map<string, { code: string; message: string }>();
  private readonly redactionSecrets = new Set<string>();
  private readonly prContext: PrContext;
  private transaction: Promise<void> = Promise.resolve();
  private snapshotVersion = 0;

  constructor(private readonly directory: string, private readonly identity: Identity, private readonly evidencePaths: ReadonlySet<string> = new Set(), private readonly evidenceValidator?: EvidenceValidation, private readonly sanitize: (value: unknown) => unknown = (value) => value, context: unknown = {}, private readonly evidenceHunks: ReadonlyMap<string, readonly ReadonlySet<number>[]> = new Map()) {
    this.prContext = sanitizePrContext(context, (value) => this.sanitizeProvider(value));
    for (const kind of TASKS) {
      const task = { kind, id: kind, token: randomBytes(32).toString("base64url") };
      this.tasks.set(task.id, task); this.byToken.set(task.token, task);
      this.redactionSecrets.add(task.token);
      this.attempts.set(task.id, 0); this.progressUpdates.set(task.id, 0); this.progress.set(task.id, { state: "pending", updatedAt: new Date().toISOString() });
    }
  }

  task(id: AnchoredTaskKind): { id: string; token: string } {
    const task = this.tasks.get(id); if (!task) throw new Error("unknown coordinator task");
    return { id: task.id, token: task.token };
  }
  addRedactionSecret(value: string): void { if (value) this.redactionSecrets.add(value); }
  result(id: AnchoredTaskKind): AnchoredTaskOutput | null { return clone(this.results.get(id) ?? null); }
  submissionStats(id: AnchoredTaskKind) {
    const attempts = this.attempts.get(id) ?? 0;
    return { atomicSubmissionAttempts: attempts, remainingAtomicSubmissionAttempts: MAX_ATOMIC_SUBMISSIONS - attempts, lastDiagnostic: this.lastDiagnostics.get(id) };
  }
  getTask(token: string) {
    const record = this.requireTask(token);
    if (record.kind !== "anchor" && !this.results.has("anchor")) throw new Error("immutable anchor is not available yet");
    const task: ProviderAnalysisTask = record.kind === "anchor"
      ? { kind: "anchor", id: "anchor", total: 1 }
      : { kind: record.kind, id: record.id, total: 3, anchor: this.results.get("anchor") as SemanticAnchor };
    return {
      taskId: record.id,
      schema: anchoredSchemaForProvider(task),
      identity: clone(this.identity),
      snapshotVersion: this.snapshotVersion,
      atomicSubmission: this.submissionStats(record.kind),
      prompt: "Use only read-only exact-head repository tools. Discover the repository yourself. Do not request raw diffs, changed-path lists, saved baselines, result paths, or command allowlists. Submit only the strict task result.",
      ...(this.validationFailures.has(record.id) ? { lastValidationFailure: clone(this.validationFailures.get(record.id)!) } : {}),
    };
  }
  getAnchor(token: string): SemanticAnchor | null {
    this.requireTask(token);
    return clone(this.results.get("anchor") as SemanticAnchor | undefined ?? null);
  }
  getPrContext(token: string): PrContext { this.requireTask(token); return clone(this.prContext); }
  async reportProgress(token: string, update: { state: "pending" | "running" | "complete" | "failed"; detail?: string }) {
    const task = this.requireTask(token);
    if (!update || !["pending", "running", "complete", "failed"].includes(update.state) || (update.detail !== undefined && !safeText(update.detail))) throw new Error("invalid task progress");
    const count = this.progressUpdates.get(task.id) ?? 0;
    if (count >= MAX_PROGRESS_UPDATES) throw new Error("progress update limit exceeded");
    const redacted = this.sanitizeProvider({ detail: update.detail });
    const detail = isRecord(redacted) && safeText(redacted.detail) ? redactProgressDetail(redacted.detail).slice(0, MAX_PROGRESS_DETAIL_CHARS) : undefined;
    const safeUpdate = { state: update.state, ...(detail ? { detail } : {}) };
    this.progressUpdates.set(task.id, count + 1);
    this.progress.set(task.id, { ...safeUpdate, updatedAt: new Date().toISOString() });
    await this.persistProgress(); await this.audit("report_progress", { taskId: task.id, update: safeUpdate });
    return clone(this.progress.get(task.id)!);
  }
  async validateEvidence(token: string, reference: { path: string; line: number; role: "changed" | "unchanged-context" }) {
    this.requireTask(token);
    const structural = !!reference && typeof reference.path === "string" && reference.path.length > 0 && !reference.path.startsWith("/") && !reference.path.split(/[\\/]/).includes("..") && Number.isInteger(reference.line) && reference.line > 0 && (reference.role === "changed" || reference.role === "unchanged-context");
    const captured = reference?.role !== "changed" || this.evidencePaths.size === 0 || this.evidencePaths.has(reference?.path);
    if (!structural || !captured) return { valid: false, errors: ["evidence must be a captured exact-head path with a positive line or null"] };
    return this.evidenceValidator ? this.evidenceValidator(reference) : { valid: true, errors: [] };
  }
  async submit(token: string, idempotencyKey: string, result: unknown): Promise<CoordinatorSubmitResponse> {
    const task = this.requireTask(token);
    if (!safeText(idempotencyKey) || idempotencyKey.length > 200) throw new Error("invalid idempotency key");
    const key = `${task.id}:${idempotencyKey}`; const sanitized = this.sanitizeProvider(result); const payload = digest(sanitized);
    const known = this.submissions.get(key);
    if (known) {
      if (known.digest !== payload) throw new Error("idempotency key reused with different payload");
      if (known.response) return { ...clone(known.response), idempotent: true };
      const pending = this.inflight.get(key);
      if (pending) return pending.then((response) => ({ ...response, idempotent: true }));
      throw new Error(known.errors?.join("; ") ?? "previous submission was rejected");
    }
    if (this.results.has(task.id)) throw new Error("task already settled; replay its original key only");
    if ((this.attempts.get(task.id) ?? 0) >= MAX_ATOMIC_SUBMISSIONS) {
      const error = "atomic submission attempt budget exhausted";
      this.lastDiagnostics.set(task.id, { code: "atomic-submission-attempt-budget-exhausted", message: error });
      throw new Error(error);
    }
    this.submissions.set(key, { digest: payload });
    const work = this.serial(async () => {
      if (this.results.has(task.id)) {
        this.submissions.delete(key);
        throw new Error("task already settled; replay its original key only");
      }
      const used = this.attempts.get(task.id) ?? 0;
      if (used >= MAX_ATOMIC_SUBMISSIONS) {
        const error = "atomic submission attempt budget exhausted";
        this.submissions.delete(key);
        this.lastDiagnostics.set(task.id, { code: "atomic-submission-attempt-budget-exhausted", message: error });
        throw new Error(error);
      }
      this.attempts.set(task.id, used + 1);
      const protocol: ProviderAnalysisTask = task.kind === "anchor"
        ? { kind: "anchor", id: "anchor", total: 1 }
        : { kind: task.kind, id: task.id, total: 3, anchor: this.results.get("anchor") as SemanticAnchor };
      const checked = validateAnchoredTaskOutput(sanitized, protocol);
      if (!checked.valid || !checked.output) {
        this.submissions.set(key, { digest: payload, errors: checked.errors });
        this.validationFailures.set(task.id, { result: clone(sanitized), errors: checked.errors.slice(0, 20) });
        await this.audit("submit_result_rejected", { taskId: task.id, errors: checked.errors });
        throw new Error(checked.errors.join("; "));
      }
      if (task.kind === "anchor" && (this.evidencePaths.size > 0 || this.evidenceHunks.size > 0)) {
        const covered = changedEvidenceLines((checked.output as SemanticAnchor).changeGroups);
        const errors: string[] = [];
        const missingPaths = [...this.evidencePaths].filter((path) => !covered.has(path)).sort();
        if (missingPaths.length > 0) {
          const shown = missingPaths.slice(0, 20);
          errors.push(`Anchor is missing changed evidence for captured changed paths: ${shown.join(", ")}${missingPaths.length > shown.length ? `, and ${missingPaths.length - shown.length} more` : ""}.`);
        }
        const missingHunks = [...this.evidenceHunks].flatMap(([path, hunks]) => hunks.filter((hunk) => ![...(covered.get(path) ?? [])].some((line) => hunk.has(line))).map((hunk) => {
          const ordered = [...hunk].sort((left, right) => left - right);
          return `${path}:${ordered[0]}${ordered.length > 1 ? `-${ordered.at(-1)}` : ""}`;
        })).sort();
        if (missingHunks.length > 0) {
          const shown = missingHunks.slice(0, 20);
          errors.push(`Anchor is missing changed evidence for captured changed hunks: ${shown.join(", ")}${missingHunks.length > shown.length ? `, and ${missingHunks.length - shown.length} more` : ""}.`);
        }
        if (errors.length > 0) {
          this.submissions.set(key, { digest: payload, errors });
          this.validationFailures.set(task.id, { result: clone(sanitized), errors: errors.slice(0, 20) });
          await this.audit("submit_result_rejected", { taskId: task.id, errors });
          throw new Error(errors.join("; "));
        }
      }
      const evidenceErrors: string[] = [];
      const collect = async (value: unknown): Promise<void> => { if (Array.isArray(value)) await Promise.all(value.map(collect)); else if (value && typeof value === "object") for (const [key, item] of Object.entries(value as Record<string, unknown>)) { if ((key === "evidence" || key === "evidenceRefs") && Array.isArray(item)) for (const ref of item) { const checkedEvidence = await this.validateEvidence(task.token, ref as { path: string; line: number; role: "changed" | "unchanged-context" }); if (!checkedEvidence.valid) evidenceErrors.push(...checkedEvidence.errors); } else await collect(item); } };
      await collect(checked.output);
      if (evidenceErrors.length) { this.submissions.set(key, { digest: payload, errors: evidenceErrors }); this.validationFailures.set(task.id, { result: clone(sanitized), errors: evidenceErrors.slice(0, 20) }); await this.audit("submit_result_rejected", { taskId: task.id, errors: evidenceErrors }); throw new Error(evidenceErrors.join("; ")); }
      await this.persistResult(task.id, checked.output);
      this.results.set(task.id, clone(checked.output));
      this.validationFailures.delete(task.id);
      if (task.kind === "anchor") this.snapshotVersion += 1;
      this.progress.set(task.id, { state: "complete", updatedAt: new Date().toISOString() });
      const response = { accepted: true as const, taskId: task.id, snapshotVersion: this.snapshotVersion };
      this.submissions.set(key, { digest: payload, response });
      const telemetry = await Promise.allSettled([
        this.persistProgress(),
        this.audit("submit_result", { taskId: task.id, snapshotVersion: this.snapshotVersion }),
      ]);
      if (telemetry.some((entry) => entry.status === "rejected")) {
        this.lastDiagnostics.set(task.id, { code: "post-settlement-telemetry-failed", message: "The result was accepted and persisted, but coordinator progress or audit telemetry could not be fully persisted." });
      }
      return response;
    });
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }
  private sanitizeProvider(value: unknown): unknown { return redactSecrets(this.sanitize(value), this.redactionSecrets); }
  private requireTask(token: string): TaskRecord { const task = this.byToken.get(token); if (!task) throw new Error("invalid task bearer token"); return task; }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const current = this.transaction.then(work); this.transaction = current.then(() => undefined, () => undefined); return current; }
  private async audit(event: string, payload: unknown) { const root = join(this.directory, "coordinator"); await mkdir(root, { recursive: true }); await appendFile(join(root, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, payload: this.sanitizeProvider(payload) })}\n`); }
  private async persistProgress() { const root = join(this.directory, "coordinator"); await mkdir(root, { recursive: true }); const value = { at: new Date().toISOString(), tasks: Object.fromEntries(this.progress), atomicSubmissions: Object.fromEntries(TASKS.map((id) => [id, this.submissionStats(id)])) }; await appendFile(join(root, "progress.jsonl"), `${JSON.stringify(value)}\n`); const target = join(root, "progress.json"); const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, target); }
  private async persistResult(taskId: string, result: AnchoredTaskOutput) { const root = join(this.directory, "coordinator", "results"); await mkdir(root, { recursive: true }); const target = join(root, `${taskId}.json`); const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(result, null, 2)); await rename(temporary, target); }
}

export async function startAtlasCoordinator(coordinator: AtlasApiCoordinator): Promise<{ url: string; close: () => Promise<void> }> {
  const readBody = async (request: import("node:http").IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    const limit = MAX_COORDINATOR_BODY_BYTES; const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; request.resume(); reject(error); };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > limit - bytes) return fail(new Error("payload exceeds coordinator limit"));
      chunks.push(buffer); bytes += buffer.length;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try { const text = Buffer.concat(chunks, bytes).toString("utf8"); resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
  let server: Server;
  server = createServer(async (request, response) => {
    try {
      const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) throw new Error("missing bearer token");
      const body = request.method === "POST" ? await readBody(request) as Record<string, unknown> : {};
      const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const value = route === "/v1/get_task" ? coordinator.getTask(token) : route === "/v1/get_anchor" ? coordinator.getAnchor(token) : route === "/v1/get_pr_context" ? coordinator.getPrContext(token) : route === "/v1/validate_evidence" ? await coordinator.validateEvidence(token, body.evidence as { path: string; line: number; role: "changed" | "unchanged-context" }) : route === "/v1/report_progress" ? await coordinator.reportProgress(token, body as { state: "pending" | "running" | "complete" | "failed"; detail?: string }) : route === "/v1/submit_result" ? await coordinator.submit(token, body.idempotencyKey as string, body.result) : (() => { throw new Error("unknown coordinator route"); })();
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    } catch (error) { response.writeHead(/token|bearer/i.test(String(error)) ? 401 : 400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("coordinator did not bind a TCP address");
  const url = `http://127.0.0.1:${address.port}`; coordinator.addRedactionSecret(url);
  return { url, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
