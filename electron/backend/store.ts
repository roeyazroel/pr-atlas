import {
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
  type AnalysisRunConfig,
  type AnalysisRunResult,
  type AnalysisRunSummary,
  type AnalysisDiagnostics,
  type ReviewProgress,
  type ReviewProgressStatus,
  type RunRetentionSettings,
  type WalkthroughDocument,
} from "../../shared/contracts.js";
import { validateWalkthroughDocument } from "../../shared/schema.js";
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
  "walkthrough",
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
export class AnalysisStore {
  readonly root: string;
  private readonly progressWriteQueues = new Map<string, Promise<void>>();
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
  async writeWalkthrough(
    directory: string,
    document: WalkthroughDocument,
  ): Promise<void> {
    await this.writeJson(directory, "walkthrough.json", document);
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
            await readFile(resolve(directory, "walkthrough.json"), "utf8"),
          );
          const validation = validateWalkthroughDocument(parsed);
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
    if (!manifest || manifest.status === "ready") return null;
    let logExcerpt: string[] = [];
    try {
      logExcerpt = (await readFile(resolve(directory, "logs.jsonl"), "utf8"))
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            const message =
              value && typeof value === "object"
                ? (value as { message?: unknown }).message
                : undefined;
            return typeof message === "string" ? [message.slice(0, 2_000)] : [];
          } catch {
            return [];
          }
        })
        .slice(-20);
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
          typeof progress.stepId === "string" &&
          isProgressStatus(progress.status) &&
          typeof progress.note === "string" &&
          typeof progress.updatedAt === "string"
          ? [
              {
                runId,
                stepId: progress.stepId,
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
      !/^[A-Za-z0-9._:-]{1,200}$/.test(progress.stepId) ||
      typeof progress.note !== "string" ||
      progress.note.length > 4_000
    )
      return null;
    const key = `${repository}:${pullNumber}:${progress.runId}`;
    return this.serializeProgressWrite(key, async () => {
      const loaded = await this.loadRun(repository, pullNumber, progress.runId);
      if (
        !loaded?.document ||
        !loaded.document.walkthrough.some((step) => step.id === progress.stepId)
      )
        return null;
      const safe: ReviewProgress = {
        runId: progress.runId,
        stepId: progress.stepId,
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
        ...current.filter((item) => item.stepId !== safe.stepId),
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
