import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import {
  DEFAULT_ANALYSIS_RUN_CONFIG,
  DEFAULT_RETENTION_SETTINGS,
  type AgentProvider,
  type AnalysisProgressEvent,
  type AnalysisManifest,
  type ProviderAccounting,
  type AnalysisRunConfig,
  type AnalysisRunResult,
  type AnalysisRunSummary,
  type AnalysisDiagnostics,
  type AnalysisDiagnosticEvent,
  type ReviewProgress,
  type ReviewProgressStatus,
  type RunRetentionSettings,
  type ReviewDocument,
} from "../../shared/contracts.js";
import { validateReviewDocument } from "../../shared/schema.js";
import { validateRepository } from "./validation.js";

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..")
    throw new Error("Unsafe storage path segment.");
  return value;
}
function isInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.includes(`${sep}..${sep}`))
  );
}
const analysisStageSet = new Set<AnalysisProgressEvent["stage"]>([
  "preparing",
  "collecting",
  "inspecting",
  "generating",
  "anchoring",
  "review",
  "tests-risks",
  "flows",
  "assembling",
  "validating",
  "complete",
]);
function safeProgressEvent(
  value: unknown,
  runId: string,
): AnalysisProgressEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    !analysisStageSet.has(event.stage as AnalysisProgressEvent["stage"]) ||
    typeof event.message !== "string" ||
    typeof event.timestamp !== "string"
  )
    return null;
  return {
    runId,
    stage: event.stage as AnalysisProgressEvent["stage"],
    message: event.message.slice(0, 1_000),
    timestamp: event.timestamp,
    ...(event.taskState === "pending" || event.taskState === "running" || event.taskState === "complete" || event.taskState === "failed" ? { taskState: event.taskState } : {}),
  };
}
function boundedTextExcerpt(value: string, maximum = 128 * 1024): string {
  if (value.length <= maximum) return value;
  const half = Math.floor((maximum - 64) / 2);
  return `${value.slice(0, half)}\n\n[... provider output truncated ...]\n\n${value.slice(-half)}`;
}
function safeAccounting(value: unknown): ProviderAccounting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const safeNumber = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  const rawUsage = raw.usage && typeof raw.usage === "object"
    ? raw.usage as Record<string, unknown>
    : undefined;
  const usage = rawUsage
    ? Object.fromEntries(Object.entries(rawUsage)
        .filter(([key, candidate]) => ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens"].includes(key) && safeNumber(candidate) !== undefined)
        .map(([key, candidate]) => [key, Math.floor(safeNumber(candidate)!)])
      )
    : {};
  const rawCost = raw.cost && typeof raw.cost === "object" ? raw.cost as Record<string, unknown> : undefined;
  let cost: ProviderAccounting["cost"];
  if (rawCost?.kind === "reported" && safeNumber(rawCost.amountUsd) !== undefined)
    cost = { kind: "reported", amountUsd: safeNumber(rawCost.amountUsd)!, ...(typeof rawCost.model === "string" ? { model: rawCost.model.slice(0, 200) } : {}), ...(rawCost.incomplete === true ? { incomplete: true } : {}) };
  else if (rawCost?.kind === "estimated" && safeNumber(rawCost.amountUsd) !== undefined && typeof rawCost.model === "string" && typeof rawCost.pricingSource === "string" && typeof rawCost.pricingVersion === "string" && typeof rawCost.pricingAsOf === "string")
    cost = { kind: "estimated", amountUsd: safeNumber(rawCost.amountUsd)!, model: rawCost.model.slice(0, 200), pricingSource: rawCost.pricingSource.slice(0, 200), pricingVersion: rawCost.pricingVersion.slice(0, 100), pricingAsOf: rawCost.pricingAsOf.slice(0, 100), ...(safeNumber(rawCost.maxAmountUsd) !== undefined && safeNumber(rawCost.maxAmountUsd)! >= safeNumber(rawCost.amountUsd)! ? { maxAmountUsd: safeNumber(rawCost.maxAmountUsd)! } : {}), ...(rawCost.incomplete === true ? { incomplete: true } : {}) };
  else if (rawCost?.kind === "unavailable" && typeof rawCost.reason === "string")
    cost = { kind: "unavailable", reason: rawCost.reason.slice(0, 500) };
  return Object.keys(usage).length || cost ? { ...(Object.keys(usage).length ? { usage } : {}), ...(cost ? { cost } : {}) } as ProviderAccounting : undefined;
}
export class AnalysisStore {
  readonly root: string;
  private readonly progressWriteQueues = new Map<string, Promise<void>>();
  private readonly diagnosticWriteQueues = new Map<string, Promise<void>>();
  constructor(root: string) {
    this.root = resolve(root);
  }
  runDirectory(
    repository: string,
    pullNumber: number,
    headSha: string,
    runId: string,
  ): string {
    if (
      !validateRepository(repository) ||
      !Number.isInteger(pullNumber) ||
      pullNumber < 1
    )
      throw new Error("Invalid analysis storage path.");
    const [owner, repo] = repository.split("/");
    const target = resolve(
      this.root,
      "analyses",
      "github.com",
      safeSegment(owner),
      safeSegment(repo),
      String(pullNumber),
      safeSegment(headSha),
      safeSegment(runId),
    );
    if (!isInside(this.root, target))
      throw new Error("Analysis path escaped application storage.");
    return target;
  }
  async writeManifest(
    directory: string,
    manifest: AnalysisManifest,
  ): Promise<void> {
    await this.writeJson(directory, "manifest.json", manifest);
  }
  async writeReview(
    directory: string,
    document: ReviewDocument,
  ): Promise<void> {
    await this.writeJson(directory, "review.json", document);
  }
  async writeInput(
    directory: string,
    name: string,
    content: unknown,
  ): Promise<void> {
    await this.writeJson(
      resolve(directory, "input"),
      `${safeSegment(name)}.json`,
      content,
    );
  }
  async writeText(
    directory: string,
    name: "raw-output.txt" | "logs.jsonl" | "input/diff.patch",
    content: string,
  ): Promise<void> {
    const target = resolve(directory, name);
    if (!isInside(directory, target)) throw new Error("Unsafe artifact path.");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content.slice(0, 8 * 1024 * 1024), "utf8");
  }
  /** Append one bounded, already-redacted operational event without replacing prior evidence. */
  async appendDiagnosticEvent(
    directory: string,
    event: AnalysisDiagnosticEvent,
  ): Promise<void> {
    if (!isInside(this.root, directory)) throw new Error("Unsafe diagnostic directory.");
    const serialize = (value: AnalysisDiagnosticEvent): string => {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, "utf8") <= 64 * 1024) return encoded;
      // Keep the line valid JSON even when a provider supplies unexpectedly
      // large metadata. The complete raw provider output remains in its
      // separately bounded artifact.
      return JSON.stringify({
        ...value,
        message: value.message.slice(0, 8_000),
        metadata: { truncated: true },
      });
    };
    const line = `${serialize(event)}\n`;
    const previous = this.diagnosticWriteQueues.get(directory) ?? Promise.resolve();
    const next = previous.then(async () => {
      const target = resolve(directory, "logs.jsonl");
      await mkdir(directory, { recursive: true });
      await appendFile(target, line, "utf8");
      // Keep crash-safe append logs bounded even when a provider emits a very
      // verbose stream. Retain complete JSONL records from the newest tail.
      const bytes = (await lstat(target)).size;
      if (bytes > 8 * 1024 * 1024) {
        const raw = await readFile(target, "utf8");
        const tail = raw.slice(-8 * 1024 * 1024);
        const firstBoundary = tail.indexOf("\n");
        await writeFile(target, firstBoundary >= 0 ? tail.slice(firstBoundary + 1) : tail, "utf8");
      }
    });
    this.diagnosticWriteQueues.set(directory, next.catch(() => undefined));
    await next;
  }
  async listRuns(
    repository: string,
    pullNumber: number,
    currentHeadSha?: string,
  ): Promise<AnalysisRunSummary[]> {
    if (
      !validateRepository(repository) ||
      !Number.isInteger(pullNumber) ||
      pullNumber < 1
    )
      return [];
    const [owner, repo] = repository.split("/");
    const base = resolve(
      this.root,
      "analyses",
      "github.com",
      safeSegment(owner),
      safeSegment(repo),
      String(pullNumber),
    );
    try {
      const heads = await readdir(base, { withFileTypes: true });
      const runs = await Promise.all(
        heads
          .filter((head) => head.isDirectory())
          .flatMap(async (head) => {
            const dir = resolve(base, head.name);
            const entries = await readdir(dir, { withFileTypes: true });
            return Promise.all(
              entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) =>
                  this.readRun(
                    resolve(dir, entry.name),
                    repository,
                    pullNumber,
                    currentHeadSha,
                  ),
                ),
            );
          }),
      );
      const preferredRunId = await this.readPreferred(base);
      return runs
        .flat()
        .filter((run): run is AnalysisRunSummary => run !== null)
        .map((run) => ({ ...run, preferred: run.runId === preferredRunId }))
        .sort(
          (a, b) =>
            Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)) ||
            b.createdAt.localeCompare(a.createdAt),
        );
    } catch {
      return [];
    }
  }
  async loadRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<AnalysisRunResult | null> {
    if (
      !validateRepository(repository) ||
      !Number.isInteger(pullNumber) ||
      pullNumber < 1 ||
      !/^[A-Za-z0-9-]{1,80}$/.test(runId)
    )
      return null;
    const [owner, repo] = repository.split("/");
    const base = resolve(
      this.root,
      "analyses",
      "github.com",
      safeSegment(owner),
      safeSegment(repo),
      String(pullNumber),
    );
    try {
      const heads = await readdir(base, { withFileTypes: true });
      for (const head of heads) {
        if (!head.isDirectory()) continue;
        const directory = resolve(base, head.name, runId);
        if (!isInside(this.root, directory)) continue;
        const manifest = await this.readManifest(
          directory,
          repository,
          pullNumber,
          runId,
        );
        if (!manifest) continue;
        if (manifest.status !== "ready") return null;
        try {
          const parsed: unknown = JSON.parse(
            await readFile(resolve(directory, "review.json"), "utf8"),
          );
          const validation = validateReviewDocument(parsed);
          if (
            !validation.valid ||
            !validation.document ||
            validation.document.pullRequest.repository !== repository ||
            validation.document.pullRequest.number !== pullNumber ||
            validation.document.pullRequest.headSha !== manifest.headSha ||
            validation.document.pullRequest.baseSha !== manifest.baseSha
          )
            return null;
          return {
            runId,
            status: "ready",
            document: validation.document,
            manifest,
            artifactDirectory: directory,
          };
        } catch {
          return null;
        }
      }
    } catch {
      /* Treat unavailable or malformed application storage as no saved run. */
    }
    return null;
  }
  async loadDiagnostics(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<AnalysisDiagnostics | null> {
    const directory = await this.findRunDirectory(
      repository,
      pullNumber,
      runId,
    );
    if (!directory) return null;
    const manifest = await this.readManifest(
      directory,
      repository,
      pullNumber,
      runId,
    );
    if (!manifest) return null;
    let logExcerpt: string[] = [];
    let events: AnalysisDiagnosticEvent[] = [];
    try {
      /** Bound object metadata so diagnostic exports stay readable and shareable. */
      const boundMetadata = (value: unknown): Record<string, unknown> | undefined => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, entry]) => [
          key.slice(0, 120),
          typeof entry === "string" ? entry.slice(0, 2_000) : entry,
        ]));
      };
      /** Normalize one already-structured diagnostic event. */
      const toEvent = (partial: {
        timestamp?: string;
        level?: AnalysisDiagnosticEvent["level"];
        event: string;
        message: string;
        runId?: string;
        provider?: string;
        stage?: string;
        taskId?: string;
        durationMs?: number;
        metadata?: unknown;
      }): AnalysisDiagnosticEvent => ({
        timestamp: partial.timestamp && Number.isFinite(Date.parse(partial.timestamp)) ? partial.timestamp : new Date(0).toISOString(),
        level: partial.level === "debug" || partial.level === "warn" || partial.level === "error" ? partial.level : "info",
        event: partial.event.slice(0, 120),
        message: partial.message.slice(0, 2_000),
        ...(partial.runId ? { runId: partial.runId.slice(0, 80) } : {}),
        ...(partial.provider && ["claude", "codex", "cursor"].includes(partial.provider) ? { provider: partial.provider as AnalysisDiagnosticEvent["provider"] } : {}),
        ...(partial.stage ? { stage: partial.stage as AnalysisDiagnosticEvent["stage"] } : {}),
        ...(partial.taskId ? { taskId: partial.taskId.slice(0, 120) } : {}),
        ...(typeof partial.durationMs === "number" && Number.isFinite(partial.durationMs) ? { durationMs: Math.max(0, Math.round(partial.durationMs)) } : {}),
        ...(boundMetadata(partial.metadata) ? { metadata: boundMetadata(partial.metadata) } : {}),
      });
      /** Expand coordinator audit rows so rejection and progress details survive the export. */
      const parseCoordinatorAudit = (raw: string): AnalysisDiagnosticEvent[] => raw
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object") return [];
            const record = value as Record<string, unknown>;
            const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
              ? record.payload as Record<string, unknown>
              : undefined;
            const eventName = typeof record.event === "string" ? record.event : "coordinator.audit";
            const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
            const update = payload?.update && typeof payload.update === "object" && !Array.isArray(payload.update)
              ? payload.update as Record<string, unknown>
              : undefined;
            const errors = Array.isArray(payload?.errors)
              ? payload.errors.filter((entry): entry is string => typeof entry === "string").slice(0, 5)
              : [];
            const detail = typeof update?.detail === "string" ? update.detail
              : errors.length > 0 ? errors.join("; ")
              : typeof payload?.message === "string" ? payload.message
              : eventName;
            const state = typeof update?.state === "string" ? update.state : undefined;
            const level: AnalysisDiagnosticEvent["level"] =
              eventName.includes("rejected") || state === "failed" || errors.length > 0 ? "error"
                : state === "complete" ? "info"
                  : "info";
            return [toEvent({
              timestamp: typeof record.at === "string" ? record.at : undefined,
              level,
              event: eventName,
              message: detail,
              taskId,
              metadata: {
                ...(state ? { taskState: state } : {}),
                ...(errors.length ? { errors } : {}),
                ...(payload ? { payload } : {}),
              },
            })];
          } catch {
            return [];
          }
        });
      /** Expand progress snapshots into the latest per-task detail so failures remain visible. */
      const parseCoordinatorProgress = (raw: string): AnalysisDiagnosticEvent[] => raw
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object") return [];
            const record = value as Record<string, unknown>;
            const tasks = record.tasks && typeof record.tasks === "object" && !Array.isArray(record.tasks)
              ? record.tasks as Record<string, unknown>
              : undefined;
            if (!tasks) return [];
            const timestamp = typeof record.at === "string" ? record.at : undefined;
            return Object.entries(tasks).flatMap(([taskId, entry]) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
              const task = entry as Record<string, unknown>;
              const state = typeof task.state === "string" ? task.state : "pending";
              const detail = typeof task.detail === "string" && task.detail.trim()
                ? task.detail
                : `${taskId} is ${state}.`;
              // Keep snapshot noise down: prefer failed rows and rows with detail.
              if (state !== "failed" && !(typeof task.detail === "string" && task.detail.trim())) return [];
              return [toEvent({
                timestamp: typeof task.updatedAt === "string" ? task.updatedAt : timestamp,
                level: state === "failed" ? "error" : "info",
                event: "coordinator.progress",
                message: detail,
                taskId,
                metadata: { taskState: state },
              })];
            });
          } catch {
            return [];
          }
        });
      const parseEvents = (raw: string, fallbackEvent: string): AnalysisDiagnosticEvent[] => raw
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object") return [];
            const record = value as Record<string, unknown>;
            const message = typeof record.message === "string"
              ? record.message
              : typeof record.event === "string"
                ? record.event
                : "Diagnostic event";
            return [toEvent({
              timestamp: typeof record.timestamp === "string" ? record.timestamp : typeof record.at === "string" ? record.at : undefined,
              level: record.level === "debug" || record.level === "warn" || record.level === "error" ? record.level : "info",
              event: typeof record.event === "string" ? record.event : fallbackEvent,
              message,
              runId: typeof record.runId === "string" ? record.runId : undefined,
              provider: typeof record.provider === "string" ? record.provider : undefined,
              stage: typeof record.stage === "string" ? record.stage : undefined,
              taskId: typeof record.taskId === "string" ? record.taskId : undefined,
              durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
              metadata: record.metadata,
            })];
          } catch {
            return [];
          }
        });
      const [primary, auditLog, progressLog] = await Promise.all([
        readFile(resolve(directory, "logs.jsonl"), "utf8").catch(() => ""),
        readFile(resolve(directory, "coordinator", "audit.jsonl"), "utf8").catch(() => ""),
        readFile(resolve(directory, "coordinator", "progress.jsonl"), "utf8").catch(() => ""),
      ]);
      events = [
        ...parseEvents(primary, "diagnostic.message"),
        ...parseCoordinatorAudit(auditLog),
        ...parseCoordinatorProgress(progressLog),
      ]
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-100);
      logExcerpt = events.map((event) => event.message);
    } catch {
      /* preserved manifest error is enough */
    }
    let rawOutputExcerpt = "";
    try {
      rawOutputExcerpt = boundedTextExcerpt(
        await readFile(resolve(directory, "raw-output.txt"), "utf8"),
      );
    } catch {
      /* provider output is optional for preparation failures */
    }
    return {
      manifest,
      ...(manifest.error ? { error: manifest.error } : {}),
      logExcerpt,
      rawOutputExcerpt,
      events,
    };
  }
  async getReviewProgress(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<ReviewProgress[]> {
    const directory = await this.findRunDirectory(
      repository,
      pullNumber,
      runId,
    );
    if (!directory) return [];
    try {
      const value: unknown = JSON.parse(
        await readFile(resolve(directory, "review-progress.json"), "utf8"),
      );
      if (!Array.isArray(value)) return [];
      return value.flatMap((item): ReviewProgress[] => {
        if (!item || typeof item !== "object") return [];
        const progress = item as Partial<ReviewProgress>;
        return progress.runId === runId &&
          typeof progress.changeGroupId === "string" &&
          isProgressStatus(progress.status) &&
          typeof progress.note === "string" &&
          typeof progress.updatedAt === "string"
          ? [
              {
                runId,
                changeGroupId: progress.changeGroupId,
                status: progress.status,
                note: progress.note.slice(0, 4_000),
                updatedAt: progress.updatedAt,
              },
            ]
          : [];
      });
    } catch {
      return [];
    }
  }
  async setReviewProgress(
    repository: string,
    pullNumber: number,
    progress: ReviewProgress,
  ): Promise<ReviewProgress | null> {
    if (
      !isProgressStatus(progress.status) ||
      typeof progress.changeGroupId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(progress.changeGroupId) ||
      typeof progress.note !== "string" ||
      progress.note.length > 4_000
    )
      return null;
    const key = `${repository}:${pullNumber}:${progress.runId}`;
    return this.serializeProgressWrite(key, async () => {
      const loaded = await this.loadRun(repository, pullNumber, progress.runId);
      if (!loaded?.document) return null;
      const changeGroupId = progress.changeGroupId;
      if (!loaded.document.changeGroups.some((group) => group.id === changeGroupId)) return null;
      const safe: ReviewProgress = {
        runId: progress.runId,
        changeGroupId,
        status: progress.status,
        note: progress.note.trim(),
        updatedAt: new Date().toISOString(),
      };
      const current = await this.getReviewProgress(
        repository,
        pullNumber,
        progress.runId,
      );
      const next = [
        ...current.filter((item) => item.changeGroupId !== safe.changeGroupId),
        safe,
      ];
      await this.writeJson(
        loaded.artifactDirectory,
        "review-progress.json",
        next,
      );
      return safe;
    });
  }
  async deleteRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<boolean> {
    const directory = await this.findRunDirectory(
      repository,
      pullNumber,
      runId,
    );
    if (!directory) return false;
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !isInside(this.root, directory)
      )
        return false;
      await rm(directory, { recursive: true, force: false });
      return true;
    } catch {
      return false;
    }
  }
  async setPreferredRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<boolean> {
    const directory = await this.findRunDirectory(
      repository,
      pullNumber,
      runId,
    );
    if (!directory) return false;
    const manifest = await this.readManifest(
      directory,
      repository,
      pullNumber,
      runId,
    );
    if (!manifest || manifest.status !== "ready") return false;
    const base = this.runBase(repository, pullNumber);
    await this.writeJson(base, "preferences.json", { preferredRunId: runId });
    return true;
  }
  async getRetentionSettings(): Promise<RunRetentionSettings> {
    try {
      const value: unknown = JSON.parse(
        await readFile(resolve(this.root, "settings.json"), "utf8"),
      );
      return validRetention(value) ?? { ...DEFAULT_RETENTION_SETTINGS };
    } catch {
      return { ...DEFAULT_RETENTION_SETTINGS };
    }
  }
  async setRetentionSettings(
    value: RunRetentionSettings,
  ): Promise<RunRetentionSettings | null> {
    const settings = validRetention(value);
    if (!settings) return null;
    await this.writeJson(this.root, "settings.json", settings);
    return settings;
  }
  /** Best-effort retention; refuses links and only removes complete run/worktree directories below app storage. */
  async cleanupExpired(
    now = Date.now(),
    protectedWorktrees: ReadonlySet<string> = new Set(),
  ): Promise<{ analyses: number; worktrees: number }> {
    const settings = await this.getRetentionSettings();
    const analysisBefore = now - settings.analysisDays * 86_400_000;
    const worktreeBefore = now - settings.worktreeDays * 86_400_000;
    let analyses = 0;
    let worktrees = 0;
    const scan = async (
      directory: string,
      depth: number,
      action: (path: string) => Promise<boolean>,
    ): Promise<void> => {
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const target = resolve(directory, entry.name);
          if (!isInside(this.root, target)) continue;
          if (depth === 0) {
            if (await action(target)) analyses += 1;
          } else await scan(target, depth - 1, action);
        }
      } catch {
        /* retention never blocks product work */
      }
    };
    const analysisRoot = resolve(this.root, "analyses", "github.com");
    await scan(analysisRoot, 4, async (directory) => {
      try {
        const manifest = JSON.parse(
          await readFile(resolve(directory, "manifest.json"), "utf8"),
        ) as { completedAt?: unknown; createdAt?: unknown };
        const timestamp = Date.parse(
          typeof manifest.completedAt === "string"
            ? manifest.completedAt
            : typeof manifest.createdAt === "string"
              ? manifest.createdAt
              : "",
        );
        if (!Number.isFinite(timestamp) || timestamp >= analysisBefore)
          return false;
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        await rm(directory, { recursive: true, force: false });
        return true;
      } catch {
        return false;
      }
    });
    const worktreeRoot = resolve(this.root, "worktrees", "github.com");
    const scanWorktrees = async (
      directory: string,
      depth: number,
    ): Promise<void> => {
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const target = resolve(directory, entry.name);
          if (!isInside(this.root, target)) continue;
          if (protectedWorktrees.has(target)) continue;
          if (depth === 0) {
            try {
              const info = await lstat(target);
              if (
                info.mtimeMs < worktreeBefore &&
                info.isDirectory() &&
                !info.isSymbolicLink()
              ) {
                await rm(target, { recursive: true, force: false });
                worktrees += 1;
              }
            } catch {
              /* best effort */
            }
          } else await scanWorktrees(target, depth - 1);
        }
      } catch {
        /* unavailable */
      }
    };
    await scanWorktrees(worktreeRoot, 2);
    return { analyses, worktrees };
  }
  private runBase(repository: string, pullNumber: number): string {
    const [owner, repo] = repository.split("/");
    return resolve(
      this.root,
      "analyses",
      "github.com",
      safeSegment(owner),
      safeSegment(repo),
      String(pullNumber),
    );
  }
  private async findRunDirectory(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<string | null> {
    if (
      !validateRepository(repository) ||
      !Number.isInteger(pullNumber) ||
      pullNumber < 1 ||
      !/^[A-Za-z0-9-]{1,80}$/.test(runId)
    )
      return null;
    const base = this.runBase(repository, pullNumber);
    try {
      for (const head of await readdir(base, { withFileTypes: true })) {
        if (!head.isDirectory()) continue;
        const directory = resolve(base, head.name, runId);
        if (
          isInside(this.root, directory) &&
          (await this.readManifest(directory, repository, pullNumber, runId))
        )
          return directory;
      }
    } catch {
      /* unavailable */
    }
    return null;
  }
  private async readPreferred(base: string): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(
        await readFile(resolve(base, "preferences.json"), "utf8"),
      );
      return value &&
        typeof value === "object" &&
        /^[A-Za-z0-9-]{1,80}$/.test(
          (value as { preferredRunId?: unknown }).preferredRunId as string,
        )
        ? (value as { preferredRunId: string }).preferredRunId
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async readRun(
    directory: string,
    repository: string,
    pullNumber: number,
    currentHeadSha?: string,
  ): Promise<AnalysisRunSummary | null> {
    const manifest = await this.readManifest(directory, repository, pullNumber);
    return manifest
      ? {
          ...manifest,
          artifactDirectory: directory,
          outdated: currentHeadSha
            ? manifest.headSha !== currentHeadSha
            : undefined,
        }
      : null;
  }
  private async readManifest(
    directory: string,
    repository: string,
    pullNumber: number,
    runId?: string,
  ): Promise<AnalysisManifest | null> {
    try {
      if (!isInside(this.root, directory)) return null;
      const value: unknown = JSON.parse(
        await readFile(resolve(directory, "manifest.json"), "utf8"),
      );
      if (!value || typeof value !== "object") return null;
      const manifest = value as Record<string, unknown>;
      const provider =
        manifest.provider === undefined ? "claude" : manifest.provider;
      if (
        typeof manifest.runId !== "string" ||
        !/^[A-Za-z0-9-]{1,80}$/.test(manifest.runId) ||
        !["ready", "failed", "invalid", "cancelled"].includes(
          manifest.status as string,
        ) ||
        manifest.repository !== repository ||
        manifest.pullNumber !== pullNumber ||
        (runId && manifest.runId !== runId) ||
        typeof manifest.headSha !== "string" ||
        typeof manifest.baseSha !== "string" ||
        typeof manifest.createdAt !== "string" ||
        !["claude", "codex", "cursor"].includes(provider as string)
      )
        return null;
      const error =
        manifest.error &&
        typeof manifest.error === "object" &&
        typeof (manifest.error as Record<string, unknown>).code === "string" &&
        typeof (manifest.error as Record<string, unknown>).message === "string"
          ? {
              code: (manifest.error as Record<string, string>).code.slice(
                0,
                100,
              ),
              message: (manifest.error as Record<string, string>).message.slice(
                0,
                1_000,
              ),
              ...(Array.isArray(
                (manifest.error as Record<string, unknown>).details,
              )
                ? {
                    details: (
                      (manifest.error as Record<string, unknown>)
                        .details as unknown[]
                    )
                      .filter(
                        (detail): detail is string =>
                          typeof detail === "string",
                      )
                      .slice(0, 20)
                      .map((detail) => detail.slice(0, 1_000)),
                  }
                : {}),
            }
          : undefined;
      const effort =
        typeof manifest.effort === "string" &&
        ["low", "medium", "high", "xhigh", "max"].includes(
          manifest.effort,
        )
          ? (manifest.effort as AnalysisManifest["effort"])
          : undefined;
      const config = validConfig(manifest.config);
      const accounting = safeAccounting(manifest.accounting);
      const lastProgress = safeProgressEvent(
        manifest.lastProgress,
        manifest.runId,
      );
      const activity = Array.isArray(manifest.activity)
        ? manifest.activity
            .flatMap((event) => {
              const safe = safeProgressEvent(event, manifest.runId as string);
              return safe ? [safe] : [];
            })
            .slice(-100)
        : [];
      return {
        runId: manifest.runId,
        repository,
        pullNumber,
        baseSha: manifest.baseSha,
        headSha: manifest.headSha,
        provider: provider as AgentProvider,
        status: manifest.status as AnalysisManifest["status"],
        createdAt: manifest.createdAt,
        ...(typeof manifest.completedAt === "string"
          ? { completedAt: manifest.completedAt }
          : {}),
        ...(typeof manifest.schemaVersion === "string"
          ? { schemaVersion: manifest.schemaVersion }
          : {}),
        ...(typeof manifest.model === "string"
          ? { model: manifest.model }
          : {}),
        ...(accounting ? { accounting } : {}),
        ...(effort ? { effort } : {}),
        ...(typeof manifest.runtimeVersion === "string"
          ? { runtimeVersion: manifest.runtimeVersion.slice(0, 200) }
          : {}),
        ...(lastProgress ? { lastProgress } : {}),
        ...(activity.length ? { activity } : {}),
        ...(config ? { config } : {}),
        ...(error ? { error } : {}),
      };
    } catch {
      return null;
    }
  }
  private async writeJson(
    directory: string,
    file: string,
    value: unknown,
  ): Promise<void> {
    const target = resolve(directory, file);
    if (!isInside(this.root, target)) throw new Error("Unsafe artifact path.");
    await mkdir(directory, { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, target);
  }
  private async serializeProgressWrite<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.progressWriteQueues.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.progressWriteQueues.set(key, next);
    try {
      return await result;
    } finally {
      if (this.progressWriteQueues.get(key) === next)
        this.progressWriteQueues.delete(key);
    }
  }
}
function isProgressStatus(value: unknown): value is ReviewProgressStatus {
  return (
    value === "pending" ||
    value === "reviewed" ||
    value === "follow-up" ||
    value === "skipped"
  );
}
function validConfig(value: unknown): AnalysisRunConfig | null {
  if (value === undefined) return { ...DEFAULT_ANALYSIS_RUN_CONFIG };
  if (!value || typeof value !== "object") return null;
  const config = value as Partial<AnalysisRunConfig>;
  return (config.depth === "quick" ||
    config.depth === "standard" ||
    config.depth === "deep") &&
    typeof config.includeReviewComments === "boolean" &&
    Number.isInteger(config.maxGraphNodes) &&
    (config.maxGraphNodes as number) >= 20 &&
    (config.maxGraphNodes as number) <= 200 &&
    Number.isInteger(config.timeoutMinutes) &&
    (config.timeoutMinutes as number) >= 1 &&
    (config.timeoutMinutes as number) <= 60
    ? {
        depth: config.depth,
        scanMode: config.scanMode === "legacy" ? "legacy" : "coordinator",
        includeReviewComments: config.includeReviewComments,
        maxGraphNodes: config.maxGraphNodes as number,
        timeoutMinutes: config.timeoutMinutes as number,
      }
    : null;
}
function validRetention(value: unknown): RunRetentionSettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Partial<RunRetentionSettings>;
  return Number.isInteger(settings.analysisDays) &&
    Number.isInteger(settings.worktreeDays) &&
    (settings.analysisDays as number) >= 1 &&
    (settings.analysisDays as number) <= 3650 &&
    (settings.worktreeDays as number) >= 1 &&
    (settings.worktreeDays as number) <= 3650
    ? {
        analysisDays: settings.analysisDays as number,
        worktreeDays: settings.worktreeDays as number,
      }
    : null;
}
