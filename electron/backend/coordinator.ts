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

const TASKS: readonly AnchoredTaskKind[] = ["anchor", "review", "tests-risks", "flows"];
const MAX_ATOMIC_SUBMISSIONS = 2;
const MAX_ANCHOR_PREFLIGHT_CHECKS = 3;
const MAX_SPECIALIST_PREFLIGHT_CHECKS = 5;
const PREFLIGHT_RECEIPT_BYTES = 32;
const PREFLIGHT_RECEIPT_TTL_MS = 10 * 60 * 1_000;
const MAX_COORDINATOR_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_UPDATES = 20;
const MAX_PROGRESS_DETAIL_CHARS = 1_000;
type Identity = { repository: string; pullNumber: number; baseSha: string; headSha: string };
type TaskRecord = { kind: AnchoredTaskKind; id: string; token: string };
type EvidenceValidation = (reference: { path: string; line: number; role: "changed" | "unchanged-context" }) => Promise<{ valid: boolean; errors: string[] }>;
type Submission = { digest: string; response?: CoordinatorSubmitResponse; errors?: string[] };
type CandidateValidation = { valid: true; output: AnchoredTaskOutput } | { valid: false; errors: string[] };
type PreflightResponse = { valid: true; errors: []; preflightId: string } | { valid: false; errors: string[] };
type PreflightReceipt = { id: string; taskId: string; candidate: AnchoredTaskOutput; expiresAt: number };
type StalePreflightReceipt = Pick<PreflightReceipt, "taskId" | "expiresAt">;
type CoordinatorSubmitResponse = { accepted: true; taskId: string; snapshotVersion: number; idempotent?: true };
type PrContext = { pullRequest: unknown; reviewThreads: unknown[]; reviews: unknown[]; issueComments: unknown[]; reviewComments: unknown[] };
type TaskProgressState = "pending" | "running" | "complete" | "failed";
type TaskProgressUpdate = { state: TaskProgressState; detail?: string; updatedAt: string };
/** Live callback used by AnalysisService to stream task-local progress into the UI. */
export type CoordinatorProgressListener = (update: { taskId: AnchoredTaskKind; state: TaskProgressState; detail?: string; updatedAt: string }) => void;

function clone<T>(value: T): T { return structuredClone(value); }
function digest(value: unknown): string { return JSON.stringify(value); }
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function preflightCheckLimit(kind: AnchoredTaskKind): number { return kind === "anchor" ? MAX_ANCHOR_PREFLIGHT_CHECKS : MAX_SPECIALIST_PREFLIGHT_CHECKS; }
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
  private readonly preflightChecks = new Map<string, number>();
  /** Ephemeral only: validated provider output must never enter coordinator artifacts. */
  private readonly preflightReceipts = new Map<string, PreflightReceipt>();
  /** Superseded receipt metadata distinguishes a safe replacement from a guessed id without retaining its candidate. */
  private readonly stalePreflightReceipts = new Map<string, StalePreflightReceipt>();
  private readonly receiptByTask = new Map<string, string>();
  private readonly progressUpdates = new Map<string, number>();
  private readonly submissions = new Map<string, Submission>();
  private readonly inflight = new Map<string, Promise<CoordinatorSubmitResponse>>();
  private readonly progress = new Map<string, TaskProgressUpdate>();
  private readonly validationFailures = new Map<string, { errors: string[] }>();
  private readonly lastDiagnostics = new Map<string, { code: string; message: string }>();
  private readonly redactionSecrets = new Set<string>();
  private readonly prContext: PrContext;
  private progressListener: CoordinatorProgressListener | undefined;
  private transaction: Promise<void> = Promise.resolve();
  private snapshotVersion = 0;

  constructor(private readonly directory: string, private readonly identity: Identity, private readonly evidencePaths: ReadonlySet<string> = new Set(), private readonly evidenceValidator?: EvidenceValidation, private readonly sanitize: (value: unknown) => unknown = (value) => value, context: unknown = {}, private readonly evidenceHunks: ReadonlyMap<string, readonly ReadonlySet<number>[]> = new Map()) {
    this.prContext = sanitizePrContext(context, (value) => this.sanitizeProvider(value));
    for (const kind of TASKS) {
      const task = { kind, id: kind, token: randomBytes(32).toString("base64url") };
      this.tasks.set(task.id, task); this.byToken.set(task.token, task);
      this.redactionSecrets.add(task.token);
      this.attempts.set(task.id, 0); this.preflightChecks.set(task.id, 0); this.progressUpdates.set(task.id, 0); this.progress.set(task.id, { state: "pending", updatedAt: new Date().toISOString() });
    }
  }

  task(id: AnchoredTaskKind): { id: string; token: string } {
    const task = this.tasks.get(id); if (!task) throw new Error("unknown coordinator task");
    return { id: task.id, token: task.token };
  }
  /** Register a listener that receives redacted task progress for live UI streaming. */
  onProgress(listener: CoordinatorProgressListener): void { this.progressListener = listener; }
  addRedactionSecret(value: string): void { if (value) this.redactionSecrets.add(value); }
  result(id: AnchoredTaskKind): AnchoredTaskOutput | null { return clone(this.results.get(id) ?? null); }
  submissionStats(id: AnchoredTaskKind) {
    const attempts = this.attempts.get(id) ?? 0;
    const checks = this.preflightChecks.get(id) ?? 0;
    return {
      atomicSubmissionAttempts: attempts,
      remainingAtomicSubmissionAttempts: MAX_ATOMIC_SUBMISSIONS - attempts,
      preflightChecks: checks,
      remainingPreflightChecks: preflightCheckLimit(id) - checks,
      lastDiagnostic: this.lastDiagnostics.get(id),
    };
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
      preflight: { checks: this.preflightChecks.get(record.id) ?? 0, remainingChecks: preflightCheckLimit(record.kind) - (this.preflightChecks.get(record.id) ?? 0) },
      prompt: "Use only read-only exact-head repository tools. Discover the repository yourself. Do not request raw diffs, changed-path lists, saved baselines, result paths, or command allowlists. Preflight the complete strict task result, then submit only its preflight receipt and an idempotency key; never resend the result document.",
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
    const recorded = this.recordProgress(task.id, safeUpdate);
    await this.persistProgress(); await this.audit("report_progress", { taskId: task.id, update: safeUpdate });
    return clone(recorded);
  }
  async validateEvidence(token: string, reference: { path: string; line: number; role: "changed" | "unchanged-context" }) {
    this.requireTask(token);
    const structural = !!reference && typeof reference.path === "string" && reference.path.length > 0 && !reference.path.startsWith("/") && !reference.path.split(/[\\/]/).includes("..") && Number.isInteger(reference.line) && reference.line > 0 && (reference.role === "changed" || reference.role === "unchanged-context");
    const captured = reference?.role !== "changed" || this.evidencePaths.size === 0 || this.evidencePaths.has(reference?.path);
    if (!structural || !captured) return { valid: false, errors: ["evidence must be a captured exact-head path with a positive line or null"] };
    return this.evidenceValidator ? this.evidenceValidator(reference) : { valid: true, errors: [] };
  }
  async preflight(token: string, result: unknown): Promise<PreflightResponse> {
    const task = this.requireTask(token);
    if (this.results.has(task.id)) throw new Error("task already settled");
    const checks = this.preflightChecks.get(task.id) ?? 0;
    if (checks >= preflightCheckLimit(task.kind)) throw new Error("preflight check limit exceeded");
    this.preflightChecks.set(task.id, checks + 1);
    await this.persistProgress();
    const checked = await this.validateCandidate(task, this.sanitizeProvider(result));
    const response: PreflightResponse = checked.valid
      ? { valid: true, errors: [], preflightId: this.replacePreflightReceipt(task, checked.output) }
      : { valid: false, errors: checked.errors.slice(0, 20) };
    if (!response.valid) {
      this.validationFailures.set(task.id, { errors: response.errors });
      const detail = response.errors.slice(0, 3).join("; ").slice(0, MAX_PROGRESS_DETAIL_CHARS);
      this.recordProgress(task.id, { state: "running", ...(detail ? { detail: `Result needs correction: ${detail}` } : {}) });
      await this.persistProgress();
    } else this.validationFailures.delete(task.id);
    await this.audit("preflight_result", { taskId: task.id, valid: response.valid, errors: response.errors }).catch(() => undefined);
    return response;
  }
  async submit(token: string, idempotencyKey: string, preflightId: unknown): Promise<CoordinatorSubmitResponse> {
    const task = this.requireTask(token);
    if (!safeText(idempotencyKey) || idempotencyKey.length > 200) throw new Error("invalid idempotency key");
    if (!safeText(preflightId) || preflightId.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(preflightId)) throw new Error("invalid preflight receipt");
    const key = `${task.id}:${idempotencyKey}`; const payload = digest({ preflightId });
    const known = this.submissions.get(key);
    if (known) {
      if (known.digest !== payload) throw new Error("idempotency key reused with different payload");
      if (known.response) return { ...clone(known.response), idempotent: true };
      const pending = this.inflight.get(key);
      if (pending) return pending.then((response) => ({ ...response, idempotent: true }));
      throw new Error(known.errors?.join("; ") ?? "previous submission was rejected");
    }
    if (this.results.has(task.id)) throw new Error("task already settled; replay its original key only");
    this.requireReceipt(task, preflightId);
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
      // A newer valid preflight replaces the previous receipt while this submit waits.
      let currentReceipt: PreflightReceipt;
      try { currentReceipt = this.requireReceipt(task, preflightId); }
      catch (error) {
        this.submissions.delete(key);
        throw error;
      }
      const used = this.attempts.get(task.id) ?? 0;
      if (used >= MAX_ATOMIC_SUBMISSIONS) {
        const error = "atomic submission attempt budget exhausted";
        this.submissions.delete(key);
        this.lastDiagnostics.set(task.id, { code: "atomic-submission-attempt-budget-exhausted", message: error });
        throw new Error(error);
      }
      this.attempts.set(task.id, used + 1);
      await this.persistResult(task.id, currentReceipt.candidate);
      this.results.set(task.id, clone(currentReceipt.candidate));
      this.clearPreflightReceipt(task.id, currentReceipt.id);
      this.validationFailures.delete(task.id);
      if (task.kind === "anchor") this.snapshotVersion += 1;
      this.recordProgress(task.id, { state: "complete", detail: `${task.id} result accepted.` });
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
  private replacePreflightReceipt(task: TaskRecord, candidate: AnchoredTaskOutput): string {
    const previousId = this.receiptByTask.get(task.id);
    const previous = previousId ? this.preflightReceipts.get(previousId) : undefined;
    if (previous) this.stalePreflightReceipts.set(previous.id, { taskId: previous.taskId, expiresAt: previous.expiresAt });
    this.clearPreflightReceipt(task.id);
    const id = randomBytes(PREFLIGHT_RECEIPT_BYTES).toString("base64url");
    this.preflightReceipts.set(id, { id, taskId: task.id, candidate: clone(candidate), expiresAt: Date.now() + PREFLIGHT_RECEIPT_TTL_MS });
    this.receiptByTask.set(task.id, id);
    return id;
  }
  private clearPreflightReceipt(taskId: string, expectedId?: string): void {
    const id = this.receiptByTask.get(taskId);
    if (!id || (expectedId && id !== expectedId)) return;
    this.receiptByTask.delete(taskId);
    this.preflightReceipts.delete(id);
  }
  private requireReceipt(task: TaskRecord, preflightId: string): PreflightReceipt {
    const receipt = this.preflightReceipts.get(preflightId);
    if (!receipt) {
      const stale = this.stalePreflightReceipts.get(preflightId);
      if (stale && stale.expiresAt > Date.now()) {
        if (stale.taskId !== task.id) throw new Error("preflight receipt belongs to a different task");
        throw new Error("preflight receipt is stale");
      }
      this.stalePreflightReceipts.delete(preflightId);
      throw new Error("invalid or expired preflight receipt");
    }
    if (receipt.taskId !== task.id) throw new Error("preflight receipt belongs to a different task");
    if (receipt.expiresAt <= Date.now()) {
      this.clearPreflightReceipt(task.id, receipt.id);
      throw new Error("preflight receipt expired");
    }
    if (this.receiptByTask.get(task.id) !== receipt.id) throw new Error("preflight receipt is stale");
    return receipt;
  }
  private async validateCandidate(task: TaskRecord, value: unknown): Promise<CandidateValidation> {
      const protocol: ProviderAnalysisTask = task.kind === "anchor"
        ? { kind: "anchor", id: "anchor", total: 1 }
        : { kind: task.kind, id: task.id, total: 3, anchor: this.results.get("anchor") as SemanticAnchor };
      const checked = validateAnchoredTaskOutput(value, protocol);
      if (!checked.valid || !checked.output) return { valid: false, errors: [...new Set(checked.errors)] };
      const errors: string[] = [];
      if (task.kind === "anchor" && (this.evidencePaths.size > 0 || this.evidenceHunks.size > 0)) {
        const covered = changedEvidenceLines((checked.output as SemanticAnchor).changeGroups);
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
      }
      const collect = async (candidate: unknown): Promise<void> => {
        if (Array.isArray(candidate)) {
          for (const item of candidate) await collect(item);
        } else if (candidate && typeof candidate === "object") {
          for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
            if ((key === "evidence" || key === "evidenceRefs") && Array.isArray(item)) {
              for (const ref of item) {
                const typedRef = ref as { path: string; line: number; role: "changed" | "unchanged-context" };
                const checkedEvidence = await this.validateEvidence(task.token, typedRef);
                if (!checkedEvidence.valid) errors.push(...checkedEvidence.errors.map((error) => `${typedRef.path}:${typedRef.line} (${typedRef.role}): ${error}`));
              }
            } else await collect(item);
          }
        }
      };
      await collect(checked.output);
      const uniqueErrors = [...new Set(errors)];
      return uniqueErrors.length > 0 ? { valid: false, errors: uniqueErrors } : { valid: true, output: checked.output };
  }
  private sanitizeProvider(value: unknown): unknown { return redactSecrets(this.sanitize(value), this.redactionSecrets); }
  /** Persist the latest task progress and notify any live UI listener. */
  private recordProgress(taskId: string, update: { state: TaskProgressState; detail?: string }): TaskProgressUpdate {
    const recorded: TaskProgressUpdate = { ...update, updatedAt: new Date().toISOString() };
    this.progress.set(taskId, recorded);
    this.progressListener?.({ taskId: taskId as AnchoredTaskKind, state: recorded.state, ...(recorded.detail ? { detail: recorded.detail } : {}), updatedAt: recorded.updatedAt });
    return recorded;
  }
  private requireTask(token: string): TaskRecord { const task = this.byToken.get(token); if (!task) throw new Error("invalid task bearer token"); return task; }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const current = this.transaction.then(work); this.transaction = current.then(() => undefined, () => undefined); return current; }
  private async audit(event: string, payload: unknown) { const root = join(this.directory, "coordinator"); await mkdir(root, { recursive: true }); await appendFile(join(root, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, payload: this.sanitizeProvider(payload) })}\n`); }
  private async persistProgress() { const root = join(this.directory, "coordinator"); await mkdir(root, { recursive: true }); const value = { at: new Date().toISOString(), tasks: Object.fromEntries(this.progress), atomicSubmissions: Object.fromEntries(TASKS.map((id) => [id, this.submissionStats(id)])), preflightChecks: Object.fromEntries(TASKS.map((id) => { const checks = this.preflightChecks.get(id) ?? 0; return [id, { checks, remainingChecks: preflightCheckLimit(id) - checks }]; })) }; await appendFile(join(root, "progress.jsonl"), `${JSON.stringify(value)}\n`); const target = join(root, "progress.json"); const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, target); }
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
      const value = route === "/v1/get_task" ? coordinator.getTask(token) : route === "/v1/get_anchor" ? coordinator.getAnchor(token) : route === "/v1/get_pr_context" ? coordinator.getPrContext(token) : route === "/v1/validate_evidence" ? await coordinator.validateEvidence(token, body.evidence as { path: string; line: number; role: "changed" | "unchanged-context" }) : route === "/v1/preflight_result" ? await coordinator.preflight(token, body.result) : route === "/v1/report_progress" ? await coordinator.reportProgress(token, body as { state: "pending" | "running" | "complete" | "failed"; detail?: string }) : route === "/v1/submit_result" ? await coordinator.submit(token, body.idempotencyKey as string, body.preflightId) : (() => { throw new Error("unknown coordinator route"); })();
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    } catch (error) { response.writeHead(/token|bearer/i.test(String(error)) ? 401 : 400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("coordinator did not bind a TCP address");
  const url = `http://127.0.0.1:${address.port}`; coordinator.addRedactionSecret(url);
  return { url, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
