import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGENT_PROVIDER_PRIORITY,
  type AgentAdapter,
  type AgentInstallationStatus,
  type AgentProvider,
  type AnalysisManifest,
  type AnalysisProgressEvent,
  type AnalysisRequest,
  type AnalysisRunResult,
  type AnalysisRunSummary,
  type BootstrapResult,
  type PullRequestDTO,
  type ReviewProgress,
  type RunRetentionSettings,
  type AgentAnalysisResult,
} from "../../shared/contracts.js";
import { GithubClient, commandRunner, type CommandRunner } from "./github.js";
import { AnalysisStore } from "./store.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import {
  redactProviderOutput,
  redactProviderValue,
  SKILL_CONTRACT_VERSION,
  SKILL_REFERENCE_URL,
} from "./agent.js";
import {
  safeError,
  validateAnalysisRequest,
  validateRepository,
} from "./validation.js";
import { normalizeDocumentEvidencePaths } from "./evidence.js";
import { validateReviewCoverageFile } from "./review-coverage.js";
import { validateWalkthroughDocument } from "../../shared/schema.js";
import { buildBatchPlan, buildBatchMapValidatorScript, buildBatchReducerValidatorScript, MAX_BATCH_CONCURRENCY, parseGitDiffSections, shouldBatchAnalysis, validateBatchMapOutput, type ChangedDiff } from "./batching.js";

function inside(root: string, target: string): boolean {
  const result = relative(root, target);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
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
async function readChangedDiffs(inputDirectory: string): Promise<ChangedDiff[]> {
  const [raw, diff] = await Promise.all([readFile(resolve(inputDirectory, "files.json"), "utf8"), readFile(resolve(inputDirectory, "diff.patch"), "utf8")]);
  const sections = parseGitDiffSections(diff);
  const unique = new Map<string, ChangedDiff>();
  for (const file of flattenFilePages(JSON.parse(raw))) if (!unique.has(file.filename)) {
    const evidence = sections.get(file.filename);
    if (typeof evidence !== "string" || !evidence.trim()) throw new Error(`Missing complete diff evidence for ${file.filename}.`);
    unique.set(file.filename, { path: file.filename, diff: evidence, additions: typeof file.additions === "number" ? file.additions : 0, deletions: typeof file.deletions === "number" ? file.deletions : 0 });
  }
  return [...unique.values()];
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
      ...(installation?.version
        ? { runtimeVersion: installation.version }
        : {}),
      config: request.config,
      skillContractVersion: SKILL_CONTRACT_VERSION,
      skillReferenceUrl: SKILL_REFERENCE_URL,
    };
    const progress = (
      stage: AnalysisProgressEvent["stage"],
      message: string,
    ) => {
      const event = {
        runId,
        stage,
        message,
        timestamp: new Date().toISOString(),
      };
      manifest.lastProgress = event;
      this.emit(event);
    };
    try {
      progress(
        "preparing",
        "Preparing an application-managed repository worktree.",
      );
      const worktree = await this.prepareWorktree(request, controller.signal);
      progress(
        "collecting",
        "Collecting deterministic pull request artifacts.",
      );
      await this.collectInputs(request, directory, worktree, controller.signal);
      const inputDirectory = resolve(directory, "input");
      if (!inside(this.dataRoot, inputDirectory))
        throw new Error("Unsafe input artifact path.");
      progress(
        "inspecting",
        "Inspecting collected source context and deterministic evidence.",
      );
      const response = await this.runProviderAnalysis(adapter, request, worktree, inputDirectory, directory, controller.signal, progress);
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
            skillVersion: SKILL_CONTRACT_VERSION,
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
      await this.store.writeText(
        directory,
        "logs.jsonl",
        response.logs
          .map((line) =>
            JSON.stringify({
              timestamp: new Date().toISOString(),
              message: redactProviderOutput(line).slice(0, 32_000),
            }),
          )
          .join("\n"),
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
      await this.store.writeManifest(directory, manifest);
      if (response.document)
        await this.store.writeWalkthrough(directory, response.document);
      if (response.status === "ready")
        progress("complete", "Walkthrough is ready.");
      return {
        runId,
        status: response.status,
        ...(response.document ? { document: response.document } : {}),
        ...(manifest.error ? { error: manifest.error } : {}),
        manifest,
        artifactDirectory: directory,
      };
    } catch (error) {
      manifest.status = controller.signal.aborted ? "cancelled" : "failed";
      manifest.completedAt = new Date().toISOString();
      manifest.error = safeError(
        manifest.status === "cancelled" ? "CANCELLED" : "PREPARATION_FAILED",
        manifest.status === "cancelled"
          ? "Analysis was cancelled."
          : "Could not prepare this analysis.",
      );
      await this.store.writeManifest(directory, manifest);
      return {
        runId,
        status: manifest.status,
        error: manifest.error,
        manifest,
        artifactDirectory: directory,
      };
    } finally {
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
    }
    return worktree;
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
    progress: (stage: AnalysisProgressEvent["stage"], message: string) => void,
  ): Promise<AgentAnalysisResult> {
    const files = await readChangedDiffs(inputDirectory);
    const changes = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
    if (!shouldBatchAnalysis({ files: files.length, changes }))
      return adapter.analyze(request, worktree, inputDirectory, signal, progress);
    const plan = buildBatchPlan(files);
    if (!plan.coverage.complete)
      return { status: "invalid", rawOutput: "", logs: [], errors: ["Batch planner did not cover every changed file."] };
    const planManifest = {
      coverage: plan.coverage,
      sourceFiles: plan.sourceFiles,
      chunks: plan.chunks.map((task) => ({ id: task.id, bytes: task.bytes, subsystems: task.subsystems, units: task.files.map(({ path, segment, bytes }) => ({ path, segment, bytes })) })),
    };
    await writeBatchJson(directory, "plan.json", planManifest);
    const execution = new AbortController(); let timedOut = false;
    const abort = () => execution.abort(); signal.addEventListener("abort", abort, { once: true });
    const timeout = request.config?.timeoutMinutes ? setTimeout(() => { timedOut = true; execution.abort(); }, request.config.timeoutMinutes * 60_000) : undefined;
    try {
    progress("generating", `Generating ${plan.chunks.length} map batches (maximum ${MAX_BATCH_CONCURRENCY} concurrent).`);
    const outputs: NonNullable<AgentAnalysisResult["mapOutput"]>[] = [];
    const responses: AgentAnalysisResult[] = [];
    let cursor = 0; let stop = false;
    const worker = async () => {
      while (!execution.signal.aborted && !stop) {
        const task = plan.chunks[cursor++];
        if (!task) return;
        const scope = resolve(directory, "batches", task.id);
        await mkdir(scope, { recursive: true });
        await writeFile(resolve(scope, "files.json"), JSON.stringify(task.files), "utf8");
        await writeFile(resolve(scope, "diff.patch"), task.files.map((file) => file.diff).join("\n"), "utf8");
        await writeFile(resolve(scope, "validate-map-output.mjs"), buildBatchMapValidatorScript(task), "utf8");
        const response = await adapter.analyze(request, scope, scope, execution.signal, () => undefined, request.model, { kind: "map", id: task.id, total: plan.chunks.length, assignedPaths: [...new Set(task.files.map((file) => file.path))], assignedUnits: task.files.map(({ path, segment }) => ({ path, segment })) });
        const validated = response.status === "ready" && response.mapOutput
          ? validateBatchMapOutput(redactProviderValue(response.mapOutput), task)
          : undefined;
        const accepted = validated?.valid ? validated.output : undefined;
        responses.push(accepted ? response : response.status === "ready" ? { ...response, status: "invalid", errors: validated?.errors ?? ["Map output was missing."] } : response);
        if (!accepted) { stop = true; execution.abort(); return; }
        outputs.push(accepted);
        await writeBatchJson(directory, `${task.id}.output.json`, accepted);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_BATCH_CONCURRENCY, plan.chunks.length) }, worker));
    const failed = responses.find((response) => response.status !== "ready" || !response.mapOutput);
    if (signal.aborted || failed || outputs.length !== plan.chunks.length)
      return { status: signal.aborted ? "cancelled" : timedOut ? "failed" : (failed?.status ?? "failed"), rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), errors: timedOut ? ["Analysis timed out before all batches completed."] : failed?.errors ?? ["A map batch did not complete."] };
    const ordered = plan.chunks.map((task) => outputs.find((output) => output.taskId === task.id)!);
    const expectedUnits = plan.chunks.flatMap((task) => task.files.map((file) => `${file.path}:${file.segment}`)).sort();
    const actualUnits = ordered.flatMap((output) => output.observations.map((item) => `${item.path}:${item.segment}`)).sort();
    if (expectedUnits.length !== actualUnits.length || expectedUnits.some((unit, index) => unit !== actualUnits[index]))
      return { status: "invalid", rawOutput: responses.map((response) => response.rawOutput).join("\n"), logs: responses.flatMap((response) => response.logs), errors: ["Validated maps did not cover planned evidence units exactly once."] };
    await writeBatchJson(directory, "map-results.json", ordered);
    const reduceScope = resolve(directory, "batches", "reduce");
    await mkdir(reduceScope, { recursive: true });
    await writeFile(resolve(reduceScope, "map-results.json"), JSON.stringify(ordered), "utf8");
    await writeFile(resolve(reduceScope, "plan.json"), JSON.stringify(planManifest), "utf8");
    await writeFile(resolve(reduceScope, "validate-reduce-output.mjs"), buildBatchReducerValidatorScript(), "utf8");
    await writeFile(resolve(reduceScope, "request.json"), JSON.stringify({ repository: request.repository, pullNumber: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha }), "utf8");
    await Promise.all(["pull-request.json", "review-threads.json", "reviews.json", "issue-comments.json", "review-comments.json"].map(async (name) => writeFile(resolve(reduceScope, name), await readFile(resolve(inputDirectory, name), "utf8"), "utf8")));
    progress("validating", `Validating ${ordered.length}/${plan.chunks.length} map batches and generating the reducer.`);
    const reduced = await adapter.analyze(request, reduceScope, reduceScope, execution.signal, () => undefined, request.model, { kind: "reduce", id: "reduce", total: plan.chunks.length });
    const combined = { ...reduced, rawOutput: [...responses.map((response) => response.rawOutput), reduced.rawOutput].join("\n"), logs: [...responses.flatMap((response) => response.logs), ...reduced.logs] };
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
