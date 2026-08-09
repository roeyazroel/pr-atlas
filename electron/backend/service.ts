import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGENT_PROVIDER_PRIORITY,
  type AgentAdapter,
  type AgentInstallationStatus,
  type AgentProvider,
  type AnalysisManifest,
  type AnalysisProgressEvent,
  type AnalysisDiagnosticEvent,
  type AnalysisRequest,
  type AnalysisRunResult,
  type AnalysisRunSummary,
  type BootstrapResult,
  type PullRequestDTO,
  type PullRequestComment,
  type ReviewProgress,
  type RunRetentionSettings,
  type AgentAnalysisResult,
} from "../../shared/contracts.js";
import { GithubClient, commandRunner, type CommandRunner } from "./github.js";
import { AnalysisStore } from "./store.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CURSOR_COORDINATOR_ISOLATION_FAILED, CursorAdapter } from "./cursor.js";
import {
  redactProviderOutput,
  redactProviderValue,
} from "./agent.js";
import {
  safeError,
  validateAnalysisRequest,
  validateRepository,
} from "./validation.js";
import { normalizeDocumentEvidencePaths } from "./evidence.js";
import { validateReviewCoverageFile } from "./review-coverage.js";
import { validateWalkthroughDocument } from "../../shared/schema.js";
import { assembleAnchoredDocument, shouldUseAnchoredAnalysis, taskOutputFrom, validateAnchoredTaskOutput } from "./anchored-analysis.js";
import { buildBatchPlan, buildBatchMapValidatorScript, buildBatchReducerValidatorScript, MAX_BATCH_CONCURRENCY, parseGitDiffSections as parseLegacyDiffSections, shouldBatchAnalysis, validateBatchMapOutput } from "./batching.js";
import { buildBundledValidatorCommand, buildWindowsValidatorLauncher, validatorLauncherName } from "./validator-command.js";
import { AtlasApiCoordinator, startAtlasCoordinator } from "./coordinator.js";
import type { AnchoredSpecialistOutput, AnchoredTaskOutput, SemanticAnchor } from "../../shared/contracts.js";

function inside(root: string, target: string): boolean {
  const result = relative(root, target);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
}
type ExactHeadTarget = { valid: true; target: string } | { valid: false; error: string };
async function canonicalRegularExactHeadTarget(root: string, path: string): Promise<ExactHeadTarget> {
  const target = resolve(root, path);
  if (!inside(root, target)) return { valid: false, error: "evidence path escapes exact-head worktree" };
  try {
    const canonicalTarget = await realpath(target);
    if (!inside(root, canonicalTarget) || canonicalTarget !== target)
      return { valid: false, error: "evidence path traverses a symlink instead of naming an exact-head file" };
    const metadata = await lstat(canonicalTarget);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      return { valid: false, error: "evidence must name a safe regular exact-head file" };
    return { valid: true, target: canonicalTarget };
  } catch {
    return { valid: false, error: "evidence does not name a readable exact-head file" };
  }
}
function repoPath(root: string, repository: string): string {
  const [owner, repo] = repository.split("/");
  const result = resolve(root, "repositories", "github.com", owner, repo);
  if (!inside(root, result))
    throw new Error("Repository path escaped storage.");
  return result;
}
function flattenFilePages(value: unknown): Array<{ filename: string; patch?: string; additions?: number; deletions?: number }> {
  if (Array.isArray(value)) return value.flatMap(flattenFilePages);
  return value && typeof value === "object" && typeof (value as { filename?: unknown }).filename === "string"
    ? [value as { filename: string; patch?: string; additions?: number; deletions?: number }]
    : [];
}
type ChangedDiff = { path: string; diff: string; additions?: number; deletions?: number };
async function readChangedDiffs(inputDirectory: string): Promise<ChangedDiff[]> {
  const [raw, diff] = await Promise.all([readFile(resolve(inputDirectory, "files.json"), "utf8"), readFile(resolve(inputDirectory, "diff.patch"), "utf8")]);
  const sections = parseLegacyDiffSections(diff);
  const unique = new Map<string, ChangedDiff>();
  for (const file of flattenFilePages(JSON.parse(raw))) if (!unique.has(file.filename)) {
    const evidence = sections.get(file.filename);
    if (typeof evidence !== "string" || !evidence.trim()) throw new Error(`Missing complete diff evidence for ${file.filename}.`);
    unique.set(file.filename, { path: file.filename, diff: evidence, additions: typeof file.additions === "number" ? file.additions : 0, deletions: typeof file.deletions === "number" ? file.deletions : 0 });
  }
  return [...unique.values()];
}
async function writeAnchoredJson(directory: string, name: string, value: unknown): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Unsafe anchored artifact name.");
  const target = resolve(directory, "anchored", name);
  if (!inside(directory, target)) throw new Error("Unsafe anchored artifact path.");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), "utf8");
}
export function changedLines(files: ChangedDiff[]): Map<string, Set<number>> {
  return new Map([...changedLineHunks(files)].map(([path, hunks]) => [path, new Set(hunks.flatMap((hunk) => [...hunk]))]));
}
export function changedLineHunks(files: ChangedDiff[]): Map<string, Set<number>[]> {
  const result = new Map<string, Set<number>[]>();
  for (const file of files) {
    const hunks: Set<number>[] = []; let lines: Set<number> | undefined; let next: number | undefined;
    for (const line of file.diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) { next = undefined; continue; }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { if (lines?.size) hunks.push(lines); lines = new Set<number>(); next = Number(hunk[1]); continue; }
      if (line === "\\ No newline at end of file") continue;
      if (next === undefined) {
        if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
        continue;
      }
      if (line.startsWith("+")) { lines?.add(next++); continue; }
      if (!line.startsWith("-")) next += 1;
    }
    if (lines?.size) hunks.push(lines);
    result.set(file.path, hunks);
  }
  return result;
}

/** A trailing newline terminates the preceding line; it never creates an evidenceable EOF line. */
export function isValidPhysicalLine(source: string, line: number): boolean {
  if (!Number.isInteger(line) || line < 1 || source.length === 0) return false;
  const count = source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
  return line <= count;
}
async function readCoordinatorPrContext(inputDirectory: string, includeReviewComments: boolean | undefined): Promise<Record<string, unknown>> {
  const read = async (name: string) => redactProviderValue(JSON.parse(await readFile(resolve(inputDirectory, name), "utf8")));
  const pullRequest = await read("pull-request.json");
  if (includeReviewComments === false) return { pullRequest, reviewThreads: [], reviews: [], issueComments: [], reviewComments: [] };
  const [reviewThreads, reviews, issueComments, reviewComments] = await Promise.all([read("review-threads.json"), read("reviews.json"), read("issue-comments.json"), read("review-comments.json")]);
  return { pullRequest, reviewThreads, reviews, issueComments, reviewComments };
}
async function writeBatchJson(directory: string, name: string, value: unknown): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Unsafe batch artifact name.");
  const target = resolve(directory, "batches", name);
  if (!inside(directory, target)) throw new Error("Unsafe batch artifact path.");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), "utf8");
}
export class AnalysisService {
  private readonly github: GithubClient;
  private readonly store: AnalysisStore;
  private readonly adapters: ReadonlyMap<AgentProvider, AgentAdapter>;
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeWorktrees = new Map<string, number>();
  constructor(
    private readonly dataRoot: string,
    runner: CommandRunner = commandRunner,
    private readonly emit: (event: AnalysisProgressEvent) => void = () => {},
    claude?: ClaudeAdapter,
    adapters?: AgentAdapter[],
  ) {
    this.github = new GithubClient(runner);
    this.store = new AnalysisStore(dataRoot);
    this.runner = runner;
    const configured = adapters ?? [
      new CodexAdapter(runner),
      new CursorAdapter(runner),
      claude ?? new ClaudeAdapter(runner),
    ];
    const priority = new Map(
      AGENT_PROVIDER_PRIORITY.map((provider, index) => [provider, index]),
    );
    this.adapters = new Map(
      [...configured]
        .sort(
          (left, right) =>
            (priority.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((adapter) => [adapter.id, adapter]),
    );
  }
  private readonly runner: CommandRunner;
  bootstrap(): Promise<BootstrapResult> {
    return this.github.bootstrap();
  }
  listPullRequests(repository: string): Promise<PullRequestDTO[]> {
    return this.github.listPullRequests(repository);
  }
  listPullRequestComments(repository: string, pullNumber: number): Promise<PullRequestComment[]> {
    return this.github.listPullRequestComments(repository, pullNumber);
  }
  createPullRequestComment(repository: string, pullNumber: number, body: string): Promise<PullRequestComment> {
    return this.github.createPullRequestComment(repository, pullNumber, body);
  }
  async listProviders(): Promise<AgentInstallationStatus[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const status = await adapter.detect();
        if (!status.installed || !adapter.listModels)
          return { ...status, models: [] };
        try {
          return { ...status, models: await adapter.listModels() };
        } catch {
          return { ...status, models: [] };
        }
      }),
    );
  }
  async startAnalysis(input: unknown): Promise<AnalysisRunResult> {
    const checked = validateAnalysisRequest(input);
    if (!checked.valid) return this.invalidResult(input, checked.error);
    const request = checked.value;
    const adapter = this.adapters.get(request.provider);
    if (!adapter)
      return this.invalidResult(
        input,
        safeError(
          "INVALID_PROVIDER",
          "Requested analysis provider is unavailable.",
        ),
      );
    if (request.model) {
      const available = adapter.listModels
        ? await adapter.listModels().catch(() => [])
        : [];
      if (!available.some((model) => model.id === request.model))
        return this.invalidResult(
          input,
          safeError(
            "INVALID_MODEL",
            "Selected model is not currently reported by this provider tool.",
          ),
        );
    }
    const runId = randomUUID();
    const managedWorktree = this.worktreePath(request);
    this.retainWorktree(managedWorktree);
    await this.store.cleanupExpired(Date.now(), this.activeWorktreePaths());
    const directory = this.store.runDirectory(
      request.repository,
      request.pullNumber,
      request.headSha,
      runId,
    );
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const installation = await adapter.detect().catch(() => undefined);
    const manifest: AnalysisManifest = {
      runId,
      repository: request.repository,
      pullNumber: request.pullNumber,
      baseSha: request.baseSha,
      headSha: request.headSha,
      provider: request.provider,
      status: "failed",
      createdAt: new Date().toISOString(),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(installation?.version
        ? { runtimeVersion: installation.version }
        : {}),
      config: request.config,
    };
    let diagnosticWrite: Promise<void> = Promise.resolve();
    const diagnosticEvents: AnalysisDiagnosticEvent[] = [];
    const log = (
      level: AnalysisDiagnosticEvent["level"],
      event: string,
      message: string,
      extra: Partial<Pick<AnalysisDiagnosticEvent, "stage" | "taskId" | "durationMs" | "metadata">> = {},
    ) => {
      const safe = redactProviderValue({
        timestamp: new Date().toISOString(),
        level,
        event: event.slice(0, 120),
        message: String(message).slice(0, 32_000),
        runId,
        provider: request.provider,
        ...extra,
      }) as AnalysisDiagnosticEvent;
      diagnosticEvents.push(safe);
      if (diagnosticEvents.length > 500) diagnosticEvents.splice(0, diagnosticEvents.length - 500);
      diagnosticWrite = diagnosticWrite
        .then(() => this.store.appendDiagnosticEvent(directory, safe))
        .catch(() => undefined);
    };
    const startedAt = Date.now();
    log("info", "analysis.started", "Analysis run started.", {
      metadata: {
        repository: request.repository,
        pullNumber: request.pullNumber,
        baseSha: request.baseSha,
        headSha: request.headSha,
        model: request.model,
        effort: request.effort,
        config: request.config,
      },
    });
    const progress = (
      stage: AnalysisProgressEvent["stage"],
      message: string,
      taskState?: AnalysisProgressEvent["taskState"],
    ) => {
      const event = {
        runId,
        stage,
        message,
        timestamp: new Date().toISOString(),
        ...(taskState ? { taskState } : {}),
      };
      manifest.lastProgress = event;
      manifest.activity = [...(manifest.activity ?? []), event].slice(-100);
      log(taskState === "failed" ? "error" : "info", "analysis.progress", message, { stage, metadata: taskState ? { taskState } : undefined });
      this.emit(event);
    };
    try {
      progress(
        "preparing",
        "Preparing an application-managed repository worktree.",
      );
      const worktree = await this.prepareWorktree(request, controller.signal);
      log("info", "worktree.ready", "Managed exact-head worktree is ready.", { stage: "preparing", metadata: { path: worktree } });
      progress(
        "collecting",
        "Collecting deterministic pull request artifacts.",
      );
      await this.collectInputs(request, directory, worktree, controller.signal);
      log("info", "inputs.collected", "Deterministic pull request artifacts were collected.", { stage: "collecting" });
      const inputDirectory = resolve(directory, "input");
      if (!inside(this.dataRoot, inputDirectory))
        throw new Error("Unsafe input artifact path.");
      progress(
        "inspecting",
        "Inspecting collected source context and deterministic evidence.",
      );
      const response = await this.runProviderAnalysis(adapter, request, worktree, inputDirectory, directory, controller.signal, progress);
      log(response.status === "ready" ? "info" : "warn", "provider.completed", `Provider analysis completed with status ${response.status}.`, {
        stage: "generating",
        durationMs: Date.now() - startedAt,
        metadata: { status: response.status, rawOutputBytes: Buffer.byteLength(response.rawOutput ?? "", "utf8"), logCount: response.logs.length, errorCount: response.errors?.length ?? 0 },
      });
      for (const line of response.logs) log("warn", "provider.stderr", line, { stage: "generating" });
      for (const error of response.errors ?? []) log("error", "provider.error", error, { stage: "validating" });
      for (const event of response.diagnosticEvents ?? []) {
        log(event.level, event.event, event.message, {
          taskId: event.taskId,
          durationMs: event.durationMs,
          metadata: event.metadata,
        });
      }
      if (response.document) {
        try {
          response.document = await normalizeDocumentEvidencePaths(
            this.dataRoot,
            request.repository,
            request.headSha,
            worktree,
            inputDirectory,
            response.document,
          );
        } catch (error) {
          response.status = "invalid";
          response.errors = [
            error instanceof Error
              ? error.message
              : "Generated evidence could not be opened safely.",
          ];
          delete response.document;
        }
      }
      if (
        response.document &&
        (response.document.pullRequest.repository !== request.repository ||
          response.document.pullRequest.number !== request.pullNumber ||
          response.document.pullRequest.baseSha !== request.baseSha ||
          response.document.pullRequest.headSha !== request.headSha)
      ) {
        response.status = "invalid";
        response.errors = [
          "Generated walkthrough does not match the requested pull request revisions.",
        ];
        delete response.document;
      }
      if (response.status === "ready" && response.document) {
        const validation = validateWalkthroughDocument(response.document);
        if (!validation.valid) {
          response.status = "invalid";
          response.errors = validation.errors;
          delete response.document;
        }
      }
      if (response.status === "ready" && response.document) {
        const coverage = await validateReviewCoverageFile(
          resolve(inputDirectory, "review-threads.json"),
          response.document,
        );
        if (!coverage.valid) {
          response.status = "invalid";
          response.errors = coverage.errors;
          delete response.document;
        }
      }
      if (response.status === "ready" && response.document) {
        const providerModel = [response.model, response.document.run.model]
          .find(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          ?.trim();
        const model = request.model ?? providerModel;
        response.document = {
          ...response.document,
          run: {
            ...response.document.run,
            id: runId,
            createdAt: manifest.createdAt,
            provider: request.provider,
            ...(model ? { model } : {}),
          },
        };
        if (model) manifest.model = model;
      }
      if (response.errors?.length)
        response.errors = response.errors.map((message) =>
          redactProviderOutput(String(message)).slice(0, 32_000),
        );
      await this.store.writeText(
        directory,
        "raw-output.txt",
        redactProviderOutput(response.rawOutput),
      );
      manifest.status = response.status;
      manifest.completedAt = new Date().toISOString();
      manifest.schemaVersion = response.document?.schemaVersion;
      if (response.errors?.length)
        manifest.error = safeError(
          response.status === "invalid"
            ? "INVALID_WALKTHROUGH"
            : `${request.provider.toUpperCase()}_FAILED`,
          response.status === "invalid"
            ? "Generated walkthrough failed validation."
            : response.errors[0],
          response.status === "invalid"
            ? response.errors.slice(0, 20)
            : undefined,
        );
      if (response.status === "ready")
        progress("complete", "Walkthrough is ready.");
      log("info", "analysis.completed", `Analysis run completed with status ${manifest.status}.`, {
        durationMs: Date.now() - startedAt,
        metadata: { status: manifest.status, schemaVersion: manifest.schemaVersion },
      });
      await diagnosticWrite;
      await this.store.writeManifest(directory, manifest);
      if (response.document)
        await this.store.writeWalkthrough(directory, response.document);
      return {
        runId,
        status: response.status,
        diagnosticEvents,
        ...(response.document ? { document: response.document } : {}),
        ...(manifest.error ? { error: manifest.error } : {}),
        manifest,
        artifactDirectory: directory,
      };
    } catch (error) {
      log("error", "analysis.failed", error instanceof Error ? error.message : "Analysis failed.", {
        durationMs: Date.now() - startedAt,
        metadata: { aborted: controller.signal.aborted },
      });
      manifest.status = controller.signal.aborted ? "cancelled" : "failed";
      manifest.completedAt = new Date().toISOString();
      manifest.error = safeError(
        manifest.status === "cancelled" ? "CANCELLED" : "PREPARATION_FAILED",
        manifest.status === "cancelled"
          ? "Analysis was cancelled."
          : "Could not prepare this analysis.",
      );
      await this.store.writeManifest(directory, manifest);
      await diagnosticWrite;
      return {
        runId,
        status: manifest.status,
        diagnosticEvents,
        error: manifest.error,
        manifest,
        artifactDirectory: directory,
      };
    } finally {
      await diagnosticWrite;
      this.controllers.delete(runId);
      this.releaseWorktree(managedWorktree);
    }
  }
  cancelAnalysis(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  listAnalysisRuns(
    repository: string,
    pullNumber: number,
    currentHeadSha?: string,
  ): Promise<AnalysisRunSummary[]> {
    return this.store.listRuns(repository, pullNumber, currentHeadSha);
  }
  loadAnalysisRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<AnalysisRunResult | null> {
    return this.store.loadRun(repository, pullNumber, runId);
  }
  loadAnalysisDiagnostics(
    repository: string,
    pullNumber: number,
    runId: string,
  ) {
    return this.store.loadDiagnostics(repository, pullNumber, runId);
  }
  getReviewProgress(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<ReviewProgress[]> {
    return this.store.getReviewProgress(repository, pullNumber, runId);
  }
  setReviewProgress(
    repository: string,
    pullNumber: number,
    progress: ReviewProgress,
  ): Promise<ReviewProgress | null> {
    return this.store.setReviewProgress(repository, pullNumber, progress);
  }
  deleteAnalysisRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<boolean> {
    return this.store.deleteRun(repository, pullNumber, runId);
  }
  setPreferredAnalysisRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<boolean> {
    return this.store.setPreferredRun(repository, pullNumber, runId);
  }
  getRetentionSettings(): Promise<RunRetentionSettings> {
    return this.store.getRetentionSettings();
  }
  async setRetentionSettings(
    settings: RunRetentionSettings,
  ): Promise<RunRetentionSettings | null> {
    const saved = await this.store.setRetentionSettings(settings);
    if (saved)
      await this.store.cleanupExpired(Date.now(), this.activeWorktreePaths());
    return saved;
  }
  private async prepareWorktree(
    request: AnalysisRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const clone = repoPath(this.dataRoot, request.repository);
    const worktree = this.worktreePath(request);
    if (!inside(this.dataRoot, clone) || !inside(this.dataRoot, worktree))
      throw new Error("Unsafe worktree path.");
    await mkdir(resolve(clone, ".."), { recursive: true });
    if (!existsSync(resolve(clone, ".git")))
      await this.runner.run(
        "gh",
        ["repo", "clone", request.repository, clone],
        { timeout: 120_000, signal },
      );
    await this.runner.run(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `pull/${request.pullNumber}/head:refs/pr-atlas/${request.pullNumber}`,
      ],
      { cwd: clone, timeout: 120_000, signal },
    );
    // Retention only removes validated, inactive managed directories. Prune here
    // before adding so Git drops any stale registration left by that removal.
    await this.runner.run("git", ["worktree", "prune"], {
      cwd: clone,
      timeout: 120_000,
      signal,
    });
    if (!existsSync(worktree)) {
      await mkdir(resolve(worktree, ".."), { recursive: true });
      await this.runner.run(
        "git",
        ["worktree", "add", "--detach", worktree, request.headSha],
        { cwd: clone, timeout: 120_000, signal },
      );
    } else {
      try {
        await this.verifyManagedWorktree(worktree, request.headSha, signal);
      } catch {
        await this.recreateManagedWorktree(clone, worktree, request.headSha, signal);
      }
    }
    await this.verifyManagedWorktree(worktree, request.headSha, signal);
    return worktree;
  }
  private async canonicalManagedWorktree(worktree: string): Promise<string> {
    if (!inside(this.dataRoot, worktree)) throw new Error("Unsafe managed worktree path.");
    let canonical: string; let canonicalRoot: string;
    try { [canonical, canonicalRoot] = await Promise.all([realpath(worktree), realpath(this.dataRoot)]); } catch { throw new Error("Managed worktree does not exist."); }
    const expected = resolve(canonicalRoot, relative(this.dataRoot, worktree));
    if (canonical !== expected || !inside(canonicalRoot, canonical))
      throw new Error("Managed worktree is not at its canonical expected path.");
    return canonical;
  }
  private async verifyManagedWorktree(worktree: string, headSha: string, signal: AbortSignal): Promise<void> {
    const canonical = await this.canonicalManagedWorktree(worktree);
    const options = { cwd: worktree, timeout: 30_000, signal };
    const root = (await this.runner.run("git", ["rev-parse", "--show-toplevel"], options)).stdout.trim();
    let canonicalRoot: string;
    try { canonicalRoot = root ? await realpath(resolve(root)) : ""; } catch { canonicalRoot = ""; }
    if (canonicalRoot !== canonical) throw new Error("Managed worktree Git root does not match its expected path.");
    const head = (await this.runner.run("git", ["rev-parse", "HEAD"], options)).stdout.trim();
    if (head.toLowerCase() !== headSha.toLowerCase()) throw new Error("Managed worktree is not at the requested exact head.");
    const status = (await this.runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], options)).stdout;
    if (status.trim()) throw new Error("Managed worktree is not clean.");
  }
  private async recreateManagedWorktree(clone: string, worktree: string, headSha: string, signal: AbortSignal): Promise<void> {
    await this.canonicalManagedWorktree(worktree);
    await this.runner.run("git", ["worktree", "remove", "--force", worktree], { cwd: clone, timeout: 120_000, signal });
    await this.runner.run("git", ["worktree", "prune"], { cwd: clone, timeout: 120_000, signal });
    await mkdir(resolve(worktree, ".."), { recursive: true });
    await this.runner.run("git", ["worktree", "add", "--detach", worktree, headSha], { cwd: clone, timeout: 120_000, signal });
  }
  private worktreePath(request: AnalysisRequest): string {
    return resolve(
      this.dataRoot,
      "worktrees",
      "github.com",
      ...request.repository.split("/"),
      request.headSha,
    );
  }
  private retainWorktree(worktree: string): void {
    this.activeWorktrees.set(
      worktree,
      (this.activeWorktrees.get(worktree) ?? 0) + 1,
    );
  }
  private releaseWorktree(worktree: string): void {
    const count = this.activeWorktrees.get(worktree) ?? 0;
    if (count <= 1) this.activeWorktrees.delete(worktree);
    else this.activeWorktrees.set(worktree, count - 1);
  }
  private activeWorktreePaths(): ReadonlySet<string> {
    return new Set(this.activeWorktrees.keys());
  }
  private async runProviderAnalysis(
    adapter: AgentAdapter,
    request: AnalysisRequest,
    worktree: string,
    inputDirectory: string,
    directory: string,
    signal: AbortSignal,
    progress: (stage: AnalysisProgressEvent["stage"], message: string, taskState?: AnalysisProgressEvent["taskState"]) => void,
  ): Promise<AgentAnalysisResult> {
    if (signal.aborted) return { status: "cancelled", rawOutput: "", logs: [], errors: ["Analysis was cancelled before provider work started."] };
    const files = await readChangedDiffs(inputDirectory);
    const changes = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
    if (!shouldUseAnchoredAnalysis({ files: files.length, changes }))
      return adapter.analyze(request, worktree, inputDirectory, signal, progress);
    if (request.config?.scanMode === "legacy")
      return this.runLegacyBatchedAnalysis(adapter, request, worktree, inputDirectory, directory, signal, progress);
    const exactLines = changedLines(files);
    if (files.some((file) => (exactLines.get(file.path)?.size ?? 0) === 0)) {
      progress("generating", "Large PR has at least one changed file with no added exact-head lines; using legacy batching to represent deletion-only changes truthfully.");
      return this.runLegacyBatchedAnalysis(adapter, request, worktree, inputDirectory, directory, signal, progress);
    }
    const prContext = await readCoordinatorPrContext(inputDirectory, request.config?.includeReviewComments);
    const exactHeadRoot = await realpath(worktree);
    const targetChecks = await Promise.all(files.map((file) => canonicalRegularExactHeadTarget(exactHeadRoot, file.path)));
    if (targetChecks.some((check) => !check.valid)) {
      progress("generating", "Large PR includes a changed path that is not a canonical regular exact-head file; using legacy batching to preserve complete coverage.");
      return this.runLegacyBatchedAnalysis(adapter, request, worktree, inputDirectory, directory, signal, progress);
    }
    const coordinator = new AtlasApiCoordinator(directory, { repository: request.repository, pullNumber: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha }, new Set(files.map((file) => file.path)), async (reference) => {
      const checkedTarget = await canonicalRegularExactHeadTarget(exactHeadRoot, reference.path);
      if (!checkedTarget.valid) return { valid: false, errors: [checkedTarget.error] };
      try {
        const bytes = await readFile(checkedTarget.target);
        if (bytes.includes(0)) return { valid: false, errors: ["evidence file is binary"] };
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!isValidPhysicalLine(source, reference.line)) return { valid: false, errors: ["evidence line is outside exact-head file"] };
        const added = exactLines.get(reference.path)?.has(reference.line) ?? false;
        if (reference.role === "changed" && !added) return { valid: false, errors: ["changed evidence is not an added line in the captured diff"] };
        if (reference.role === "unchanged-context" && added) return { valid: false, errors: ["unchanged-context evidence must cite a current non-added line"] };
        return { valid: true, errors: [] };
      } catch { return { valid: false, errors: ["evidence does not name a readable UTF-8 exact-head file"] }; }
    }, (value) => redactProviderValue(value), prContext, changedLineHunks(files));
    const coordinatorStage = { anchor: "anchoring", walkthrough: "walkthrough", "tests-risks": "tests-risks", flows: "flows" } as const;
    /** Forward agent report_progress / submit outcomes into the live activity stream. */
    coordinator.onProgress((update) => {
      const stage = coordinatorStage[update.taskId];
      const message = update.detail?.trim() || `${update.taskId} is ${update.state}.`;
      progress(stage, message, update.state);
    });
    const coordinatorServer = await startAtlasCoordinator(coordinator);
    const execution = new AbortController(); let timedOut = false;
    const abort = () => execution.abort();
    if (signal.aborted) execution.abort(); else signal.addEventListener("abort", abort, { once: true });
    const timeout = request.config?.timeoutMinutes ? setTimeout(() => { timedOut = true; execution.abort(); }, request.config.timeoutMinutes * 60_000) : undefined;
    try {
    if (execution.signal.aborted) return { status: signal.aborted ? "cancelled" : "failed", rawOutput: "", logs: [], errors: timedOut ? ["Analysis timed out before semantic anchor started."] : ["Analysis was cancelled before semantic anchor started."] };
    progress("anchoring", "Semantic anchor started · classifying the PR once.", "running");
    if (execution.signal.aborted) return { status: signal.aborted ? "cancelled" : "failed", rawOutput: "", logs: [], errors: timedOut ? ["Analysis timed out before semantic anchor started."] : ["Analysis was cancelled before semantic anchor started."] };
    const coordinatorTask = <T extends "anchor" | "walkthrough" | "tests-risks" | "flows">(kind: T) => ({ url: coordinatorServer.url, token: coordinator.task(kind).token, shimPath: resolve(__dirname, "coordinator-mcp.cjs"), submitted: () => coordinator.result(kind), submitForHarness: (key: string, result: AnchoredTaskOutput) => coordinator.submit(coordinator.task(kind).token, key, result) });
    const anchorTask = { kind: "anchor", id: "anchor", total: 1, coordinator: coordinatorTask("anchor") } as const;
    const anchorResponse = await adapter.analyze(request, worktree, inputDirectory, execution.signal, () => undefined, request.model, anchorTask);
    if (adapter.id === "cursor" && !signal.aborted && !timedOut && !execution.signal.aborted && anchorResponse.errors?.includes(CURSOR_COORDINATOR_ISOLATION_FAILED)) {
      progress("anchoring", "Cursor coordinator instruction isolation was unavailable; Anchor stopped before legacy fallback.", "failed");
      progress("generating", "Cursor coordinator instruction isolation was unavailable; using legacy analysis.");
      return this.runLegacyBatchedAnalysis(adapter, request, worktree, inputDirectory, directory, signal, progress);
    }
    const anchorValidation = anchorResponse.status === "ready" && taskOutputFrom(anchorResponse)
      ? validateAnchoredTaskOutput(redactProviderValue(taskOutputFrom(anchorResponse)), anchorTask) : undefined;
    const anchor = anchorValidation?.valid ? anchorValidation.output as SemanticAnchor : undefined;
    if (!anchor) return { status: signal.aborted ? "cancelled" : timedOut ? "failed" : (anchorResponse.status === "ready" ? "invalid" : anchorResponse.status), rawOutput: anchorResponse.rawOutput, logs: anchorResponse.logs, errors: timedOut ? ["Analysis timed out before semantic anchor completed."] : anchorResponse.errors ?? anchorValidation?.errors ?? ["Semantic anchor was missing."] };
    await writeAnchoredJson(directory, "anchor.output.json", anchor);
    progress("anchoring", "Semantic anchor completed and validated.", "complete");
    const tasks = ["walkthrough", "tests-risks", "flows"] as const;
    const stage = { walkthrough: "walkthrough", "tests-risks": "tests-risks", flows: "flows" } as const;
    progress("walkthrough", "Walkthrough and reviews specialist started.", "running"); progress("tests-risks", "Tests and risks specialist started.", "running"); progress("flows", "Flows specialist started.", "running");
    const responses = await Promise.all(tasks.map(async (kind) => {
      const task = { kind, id: kind, total: 3, anchor, coordinator: coordinatorTask(kind) } as const;
      let response = await adapter.analyze(request, worktree, inputDirectory, execution.signal, () => undefined, request.model, task);
      const attempts = [response];
      let checked = response.status === "ready" && taskOutputFrom(response) ? validateAnchoredTaskOutput(redactProviderValue(taskOutputFrom(response)), task) : undefined;
      let output = checked?.valid ? checked.output as AnchoredSpecialistOutput : undefined;
      if (!output && response.status === "invalid" && coordinator.submissionStats(kind).atomicSubmissionAttempts === 1 && !execution.signal.aborted) {
        progress(stage[kind], `${kind} submitted one rejected result; running the single bounded correction.`, "running");
        response = await adapter.analyze(request, worktree, inputDirectory, execution.signal, () => undefined, request.model, task);
        attempts.push(response);
        checked = response.status === "ready" && taskOutputFrom(response) ? validateAnchoredTaskOutput(redactProviderValue(taskOutputFrom(response)), task) : undefined;
        output = checked?.valid ? checked.output as AnchoredSpecialistOutput : undefined;
      }
      if (output) await writeAnchoredJson(directory, `${kind}.output.json`, output);
      const failureDetail = !output && checked?.errors?.length
        ? `: ${checked.errors.slice(0, 3).join("; ").slice(0, 800)}`
        : !output && response.errors?.length
          ? `: ${response.errors.slice(0, 3).join("; ").slice(0, 800)}`
          : ".";
      progress(stage[kind], output ? `${kind} specialist completed and validated.` : `${kind} specialist failed validation${failureDetail}`, output ? "complete" : "failed");
      return { kind, response, attempts, output, errors: checked?.errors };
    }));
    const cursorIsolationFailure = adapter.id === "cursor"
      ? responses.find((item) => item.attempts.some((attempt) => attempt.errors?.includes(CURSOR_COORDINATOR_ISOLATION_FAILED)))
      : undefined;
    if (cursorIsolationFailure && !signal.aborted && !timedOut && !execution.signal.aborted) {
      progress(stage[cursorIsolationFailure.kind], `Cursor coordinator instruction isolation was unavailable; ${cursorIsolationFailure.kind} stopped before legacy fallback.`, "failed");
      progress("generating", `Cursor coordinator instruction isolation was unavailable during ${cursorIsolationFailure.kind}; using legacy analysis.`);
      return this.runLegacyBatchedAnalysis(adapter, request, worktree, inputDirectory, directory, signal, progress);
    }
    const failed = responses.find((item) => !item.output);
    const allResponses = [anchorResponse, ...responses.flatMap((item) => item.attempts)];
    if (signal.aborted || timedOut || failed) return { status: signal.aborted ? "cancelled" : timedOut ? "failed" : (failed?.response.status === "ready" ? "invalid" : failed?.response.status ?? "failed"), rawOutput: allResponses.map((item) => item.rawOutput).join("\n"), logs: allResponses.flatMap((item) => item.logs), diagnosticEvents: allResponses.flatMap((item) => item.diagnosticEvents ?? []), model: allResponses.map((item) => item.model).find((value): value is string => typeof value === "string" && value.trim().length > 0), errors: timedOut ? ["Analysis timed out before all anchored specialists completed."] : failed?.response.errors ?? failed?.errors ?? ["An anchored specialist did not complete."] };
    progress("assembling", "Deterministically assembling anchored specialist output.", "running");
    const specialistMap = Object.fromEntries(responses.map((item) => [item.kind, item.output])) as Record<"walkthrough" | "tests-risks" | "flows", AnchoredSpecialistOutput>;
    const reportedModel = [request.model, ...allResponses.map((item) => item.model)].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    const assembled = assembleAnchoredDocument(request, anchor, specialistMap, reportedModel);
    if (!assembled.valid || !assembled.document) return { status: "invalid", rawOutput: allResponses.map((item) => item.rawOutput).join("\n"), logs: allResponses.flatMap((item) => item.logs), diagnosticEvents: allResponses.flatMap((item) => item.diagnosticEvents ?? []), model: reportedModel, errors: assembled.errors };
    progress("assembling", "Deterministic assembly completed.", "complete");
    progress("validating", "Validating deterministic anchored walkthrough assembly.", "running");
    return { status: "ready", document: assembled.document, rawOutput: allResponses.map((item) => item.rawOutput).join("\n"), logs: allResponses.flatMap((item) => item.logs), diagnosticEvents: allResponses.flatMap((item) => item.diagnosticEvents ?? []), model: reportedModel };
    } finally { if (timeout) clearTimeout(timeout); signal.removeEventListener("abort", abort); await coordinatorServer.close(); }
  }
  private async runLegacyBatchedAnalysis(
    adapter: AgentAdapter,
    request: AnalysisRequest,
    worktree: string,
    inputDirectory: string,
    directory: string,
    signal: AbortSignal,
    progress: (stage: AnalysisProgressEvent["stage"], message: string) => void,
  ): Promise<AgentAnalysisResult> {
    const execution = new AbortController(); let timedOut = false;
    const abort = () => execution.abort();
    if (signal.aborted) execution.abort(); else signal.addEventListener("abort", abort, { once: true });
    const timeout = request.config?.timeoutMinutes ? setTimeout(() => { timedOut = true; execution.abort(); }, request.config.timeoutMinutes * 60_000) : undefined;
    const interrupted = (): AgentAnalysisResult => ({ status: signal.aborted ? "cancelled" : "failed", rawOutput: "", logs: [], errors: timedOut ? ["Analysis timed out before legacy batching started."] : ["Analysis was cancelled before legacy batching started."] });
    try {
    if (execution.signal.aborted) return interrupted();
    const files = await readChangedDiffs(inputDirectory);
    if (execution.signal.aborted) return interrupted();
    const changes = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
    if (!shouldBatchAnalysis({ files: files.length, changes }))
      return adapter.analyze(request, worktree, inputDirectory, execution.signal, progress);
    const plan = buildBatchPlan(files);
    if (!plan.coverage.complete)
      return { status: "invalid", rawOutput: "", logs: [], errors: ["Batch planner did not cover every changed file."] };
    const planManifest = {
      coverage: plan.coverage,
      sourceFiles: plan.sourceFiles,
      chunks: plan.chunks.map((task) => ({ id: task.id, bytes: task.bytes, subsystems: task.subsystems, units: task.files.map(({ path, segment, bytes }) => ({ path, segment, bytes })) })),
    };
    await writeBatchJson(directory, "plan.json", planManifest);
    if (execution.signal.aborted) return interrupted();
    progress("generating", `Generating ${plan.chunks.length} map batches (maximum ${MAX_BATCH_CONCURRENCY} concurrent).`);
    const outputs: NonNullable<AgentAnalysisResult["mapOutput"]>[] = [];
    const responses: AgentAnalysisResult[] = [];
    let cursor = 0; let stop = false;
    const worker = async () => {
      while (!execution.signal.aborted && !stop) {
        const task = plan.chunks[cursor++];
        if (!task) return;
        const taskNumber = plan.chunks.indexOf(task) + 1;
        progress("generating", `Map batch ${taskNumber}/${plan.chunks.length} started · ${task.files.length} source units.`);
        const scope = resolve(directory, "batches", task.id);
        await mkdir(scope, { recursive: true });
        await writeFile(resolve(scope, "files.json"), JSON.stringify(task.files), "utf8");
        await writeFile(resolve(scope, "diff.patch"), task.files.map((file) => file.diff).join("\n"), "utf8");
        const validatorFile = "validate-map-output.mjs"; const launcherFile = validatorLauncherName("map");
        await writeFile(resolve(scope, validatorFile), buildBatchMapValidatorScript(task), "utf8");
        if (process.platform === "win32") await writeFile(resolve(scope, launcherFile), buildWindowsValidatorLauncher(validatorFile), "utf8");
        if (execution.signal.aborted) return;
        const response = await adapter.analyze(request, scope, scope, execution.signal, () => undefined, request.model, { kind: "map", id: task.id, total: plan.chunks.length, validatorRuntime: process.execPath, validatorCommand: buildBundledValidatorCommand(validatorFile, process.platform, launcherFile), assignedPaths: [...new Set(task.files.map((file) => file.path))], assignedUnits: task.files.map(({ path, segment }) => ({ path, segment })) });
        const validated = response.status === "ready" && response.mapOutput
          ? validateBatchMapOutput(redactProviderValue(response.mapOutput), task)
          : undefined;
        const accepted = validated?.valid ? validated.output : undefined;
        responses.push(accepted ? response : response.status === "ready" ? { ...response, status: "invalid", errors: validated?.errors ?? ["Map output was missing."] } : response);
        if (!accepted) {
          progress("generating", `Map batch ${taskNumber}/${plan.chunks.length} failed validation.`);
          stop = true; execution.abort(); return;
        }
        outputs.push(accepted);
        await writeBatchJson(directory, `${task.id}.output.json`, accepted);
        progress("generating", `Map batch ${taskNumber}/${plan.chunks.length} completed · ${accepted.observations.length} observations validated.`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_BATCH_CONCURRENCY, plan.chunks.length) }, worker));
    const failed = responses.find((response) => response.status !== "ready" || !response.mapOutput);
    if (signal.aborted || failed || outputs.length !== plan.chunks.length)
      return { status: signal.aborted ? "cancelled" : timedOut ? "failed" : (failed?.status ?? "failed"), rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), diagnosticEvents: responses.flatMap((response) => response.diagnosticEvents ?? []), errors: timedOut ? ["Analysis timed out before all batches completed."] : failed?.errors ?? ["A map batch did not complete."] };
    const ordered = plan.chunks.map((task) => outputs.find((output) => output.taskId === task.id)!);
    const expectedUnits = plan.chunks.flatMap((task) => task.files.map((file) => `${file.path}:${file.segment}`)).sort();
    const actualUnits = ordered.flatMap((output) => output.observations.map((item) => `${item.path}:${item.segment}`)).sort();
    if (expectedUnits.length !== actualUnits.length || expectedUnits.some((unit, index) => unit !== actualUnits[index]))
      return { status: "invalid", rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), diagnosticEvents: responses.flatMap((response) => response.diagnosticEvents ?? []), errors: ["Validated maps did not cover planned evidence units exactly once."] };
    await writeBatchJson(directory, "map-results.json", ordered);
    const reduceScope = resolve(directory, "batches", "reduce");
    await mkdir(reduceScope, { recursive: true });
    await writeFile(resolve(reduceScope, "map-results.json"), JSON.stringify(ordered), "utf8");
    await writeFile(resolve(reduceScope, "plan.json"), JSON.stringify(planManifest), "utf8");
    const reduceValidatorFile = "validate-reduce-output.mjs"; const reduceLauncherFile = validatorLauncherName("reduce");
    await writeFile(resolve(reduceScope, reduceValidatorFile), buildBatchReducerValidatorScript(), "utf8");
    if (process.platform === "win32") await writeFile(resolve(reduceScope, reduceLauncherFile), buildWindowsValidatorLauncher(reduceValidatorFile), "utf8");
    await writeFile(resolve(reduceScope, "request.json"), JSON.stringify({ repository: request.repository, pullNumber: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha }), "utf8");
    await Promise.all(["pull-request.json", "review-threads.json", "reviews.json", "issue-comments.json", "review-comments.json"].map(async (name) => writeFile(resolve(reduceScope, name), await readFile(resolve(inputDirectory, name), "utf8"), "utf8")));
    if (execution.signal.aborted) return { status: signal.aborted ? "cancelled" : "failed", rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), diagnosticEvents: responses.flatMap((response) => response.diagnosticEvents ?? []), errors: timedOut ? ["Analysis timed out before the reducer started."] : ["Analysis was cancelled before the reducer started."] };
    progress("validating", `Reducer started · combining ${ordered.length} validated map batches.`);
    if (execution.signal.aborted) return { status: signal.aborted ? "cancelled" : "failed", rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), diagnosticEvents: responses.flatMap((response) => response.diagnosticEvents ?? []), errors: timedOut ? ["Analysis timed out before the reducer started."] : ["Analysis was cancelled before the reducer started."] };
    const reduced = await adapter.analyze(request, reduceScope, reduceScope, execution.signal, () => undefined, request.model, { kind: "reduce", id: "reduce", total: plan.chunks.length, validatorRuntime: process.execPath, validatorCommand: buildBundledValidatorCommand(reduceValidatorFile, process.platform, reduceLauncherFile) });
    progress("validating", reduced.status === "ready" ? "Reducer completed · validating the final walkthrough." : `Reducer ${reduced.status}.`);
    const combined = { ...reduced, rawOutput: [...responses.map((response) => response.rawOutput), reduced.rawOutput].join("\n"), logs: [...responses.flatMap((response) => response.logs), ...reduced.logs], diagnosticEvents: [...responses.flatMap((response) => response.diagnosticEvents ?? []), ...(reduced.diagnosticEvents ?? [])] };
    return timedOut
      ? { ...combined, status: "failed", document: undefined, errors: ["Analysis timed out before the reducer completed."] }
      : combined;
    } finally { if (timeout) clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }
  private async collectInputs(
    request: AnalysisRequest,
    directory: string,
    worktree: string,
    signal: AbortSignal,
  ): Promise<void> {
    const api = async (name: string, endpoint: string) => {
      const result = await this.runner.run(
        "gh",
        ["api", "--paginate", "--slurp", endpoint],
        { timeout: 60_000, signal },
      );
      await this.store.writeInput(
        directory,
        name,
        JSON.parse(result.stdout.slice(0, 4 * 1024 * 1024)),
      );
    };
    const prefix = `repos/${request.repository}/pulls/${request.pullNumber}`;
    const reviewInputs =
      request.config?.includeReviewComments === false
        ? Promise.all([
            this.store.writeInput(directory, "review-threads", []),
            this.store.writeInput(directory, "reviews", []),
            this.store.writeInput(directory, "issue-comments", []),
            this.store.writeInput(directory, "review-comments", []),
          ])
        : Promise.all([
            api("reviews", `${prefix}/reviews?per_page=100`),
            api(
              "issue-comments",
              `repos/${request.repository}/issues/${request.pullNumber}/comments?per_page=100`,
            ),
            api("review-comments", `${prefix}/comments?per_page=100`),
            this.github
              .fetchReviewThreads(
                request.repository,
                request.pullNumber,
                signal,
              )
              .then((value) =>
                this.store.writeInput(directory, "review-threads", value),
              ),
          ]);
    await Promise.all([
      api("pull-request", prefix),
      api("files", `${prefix}/files?per_page=100`),
      api("commits", `${prefix}/commits?per_page=100`),
      reviewInputs,
    ]);
    const diff = await this.runner.run(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--binary",
        `${request.baseSha}...${request.headSha}`,
      ],
      { cwd: worktree, timeout: 120_000, signal },
    );
    await this.store.writeText(directory, "input/diff.patch", diff.stdout);
  }
  private async invalidResult(
    input: unknown,
    error: ReturnType<typeof safeError>,
  ): Promise<AnalysisRunResult> {
    const repository =
      typeof (input as { repository?: unknown })?.repository === "string" &&
      validateRepository((input as { repository: string }).repository)
        ? (input as { repository: string }).repository
        : "invalid/invalid";
    const pullNumber = Number.isInteger(
      (input as { pullNumber?: unknown })?.pullNumber,
    )
      ? Number((input as { pullNumber: number }).pullNumber)
      : 0;
    const provider = ["claude", "codex", "cursor"].includes(
      (input as { provider?: unknown })?.provider as string,
    )
      ? (input as { provider: AgentProvider }).provider
      : AGENT_PROVIDER_PRIORITY[0];
    const runId = randomUUID();
    const manifest: AnalysisManifest = {
      runId,
      repository,
      pullNumber,
      baseSha: "",
      headSha: "",
      provider,
      status: "invalid",
      createdAt: new Date().toISOString(),
      error,
    };
    return { runId, status: "invalid", error, manifest, artifactDirectory: "" };
  }
}
