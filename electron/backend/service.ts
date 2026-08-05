import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGENT_PROVIDER_PRIORITY, type AgentAdapter, type AgentInstallationStatus, type AgentProvider, type AnalysisManifest, type AnalysisProgressEvent, type AnalysisRequest, type AnalysisRunResult, type AnalysisRunSummary, type BootstrapResult, type PullRequestDTO } from '../../shared/contracts.js';
import { GithubClient, commandRunner, type CommandRunner } from './github.js';
import { AnalysisStore } from './store.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { CursorAdapter } from './cursor.js';
import { readRepositoryMapping, repositoriesMatch, repositoryFromRemote, writeRepositoryMapping } from './mappings.js';
import { redactProviderOutput, SKILL_CONTRACT_VERSION, SKILL_REFERENCE_URL } from './agent.js';
import { safeError, validateAnalysisRequest, validateRepository } from './validation.js';
import { normalizeDocumentEvidencePaths } from './evidence.js';
import { validateReviewCoverageFile } from './review-coverage.js';

function inside(root: string, target: string): boolean { const result = relative(root, target); return result === '' || (!result.startsWith(`..${sep}`) && result !== '..'); }
function repoPath(root: string, repository: string): string { const [owner, repo] = repository.split('/'); const result = resolve(root, 'repositories', 'github.com', owner, repo); if (!inside(root, result)) throw new Error('Repository path escaped storage.'); return result; }
export class AnalysisService {
  private readonly github: GithubClient; private readonly store: AnalysisStore; private readonly adapters: ReadonlyMap<AgentProvider, AgentAdapter>; private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly dataRoot: string, runner: CommandRunner = commandRunner, private readonly emit: (event: AnalysisProgressEvent) => void = () => {}, claude?: ClaudeAdapter, adapters?: AgentAdapter[]) {
    this.github = new GithubClient(runner); this.store = new AnalysisStore(dataRoot); this.runner = runner;
    const configured = adapters ?? [new CodexAdapter(runner), new CursorAdapter(runner), claude ?? new ClaudeAdapter(runner)];
    const priority = new Map(AGENT_PROVIDER_PRIORITY.map((provider, index) => [provider, index]));
    this.adapters = new Map([...configured].sort((left, right) => (priority.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right.id) ?? Number.MAX_SAFE_INTEGER)).map((adapter) => [adapter.id, adapter]));
  }
  private readonly runner: CommandRunner;
  bootstrap(): Promise<BootstrapResult> { return this.github.bootstrap(); }
  listPullRequests(repository: string): Promise<PullRequestDTO[]> { return this.github.listPullRequests(repository); }
  async mapLocalRepository(repository: string, localPath: string): Promise<{ repository: string; path: string }> {
    if (!validateRepository(repository)) throw new Error('Invalid repository.');
    if (typeof localPath !== 'string' || !localPath.trim()) throw new Error('A local repository path is required.');
    const candidate = resolve(localPath);
    let canonicalPath: string;
    let remote: string;
    try {
      const root = await this.runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: candidate, timeout: 10_000 });
      canonicalPath = resolve(root.stdout.trim());
      if (!root.stdout.trim()) throw new Error('missing repository root');
      remote = (await this.runner.run('git', ['remote', 'get-url', 'origin'], { cwd: canonicalPath, timeout: 10_000 })).stdout.trim();
    } catch {
      throw new Error('Could not verify the selected local Git repository.');
    }
    const remoteRepository = repositoryFromRemote(remote);
    if (!remoteRepository || !repositoriesMatch(remoteRepository, repository)) throw new Error('The local repository origin does not match the selected GitHub repository.');
    // Never persist a credential-bearing origin (for example an HTTPS token).
    // The validated repository identity is sufficient to reconstruct the
    // canonical GitHub origin when seeding the managed clone.
    await writeRepositoryMapping(this.dataRoot, { repository, path: canonicalPath, remote: `https://github.com/${repository}.git`, updatedAt: new Date().toISOString() });
    return { repository, path: canonicalPath };
  }
  async listProviders(): Promise<AgentInstallationStatus[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      const status = await adapter.detect();
      if (!status.installed || !adapter.listModels) return { ...status, models: [] };
      try { return { ...status, models: await adapter.listModels() }; }
      catch { return { ...status, models: [] }; }
    }));
  }
  async startAnalysis(input: unknown): Promise<AnalysisRunResult> {
    const checked = validateAnalysisRequest(input); if (!checked.valid) return this.invalidResult(input, checked.error);
    const request = checked.value; const adapter = this.adapters.get(request.provider); if (!adapter) return this.invalidResult(input, safeError('INVALID_PROVIDER', 'Requested analysis provider is unavailable.'));
    if (request.model) {
      const available = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
      if (!available.some((model) => model.id === request.model)) return this.invalidResult(input, safeError('INVALID_MODEL', 'Selected model is not currently reported by this provider tool.'));
    }
    const runId = randomUUID(); const directory = this.store.runDirectory(request.repository, request.pullNumber, request.headSha, runId); const controller = new AbortController(); this.controllers.set(runId, controller);
    const manifest: AnalysisManifest = { runId, repository: request.repository, pullNumber: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha, provider: request.provider, status: 'failed', createdAt: new Date().toISOString(), ...(request.model ? { model: request.model } : {}), skillContractVersion: SKILL_CONTRACT_VERSION, skillReferenceUrl: SKILL_REFERENCE_URL };
    const progress = (stage: AnalysisProgressEvent['stage'], message: string) => this.emit({ runId, stage, message, timestamp: new Date().toISOString() });
    try {
      progress('preparing', 'Preparing an application-managed repository worktree.');
      const worktree = await this.prepareWorktree(request, controller.signal);
      progress('collecting', 'Collecting deterministic pull request artifacts.'); await this.collectInputs(request, directory, worktree, controller.signal);
      const inputDirectory = resolve(directory, 'input'); if (!inside(this.dataRoot, inputDirectory)) throw new Error('Unsafe input artifact path.');
      progress('generating', `Generating a local walkthrough with ${adapter.displayName}.`); const response = await adapter.analyze(request, worktree, inputDirectory, controller.signal, progress);
      if (response.document) {
        try { response.document = await normalizeDocumentEvidencePaths(this.dataRoot, request.repository, request.headSha, worktree, inputDirectory, response.document); }
        catch (error) { response.status = 'invalid'; response.errors = [error instanceof Error ? error.message : 'Generated evidence could not be opened safely.']; delete response.document; }
      }
      if (response.document && (response.document.pullRequest.repository !== request.repository || response.document.pullRequest.number !== request.pullNumber || response.document.pullRequest.baseSha !== request.baseSha || response.document.pullRequest.headSha !== request.headSha)) { response.status = 'invalid'; response.errors = ['Generated walkthrough does not match the requested pull request revisions.']; delete response.document; }
      if (response.status === 'ready' && response.document) {
        const coverage = await validateReviewCoverageFile(resolve(inputDirectory, 'review-threads.json'), response.document);
        if (!coverage.valid) { response.status = 'invalid'; response.errors = coverage.errors; delete response.document; }
      }
      if (response.status === 'ready' && response.document) {
        const providerModel = [response.model, response.document.run.model].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
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
      if (response.errors?.length) response.errors = response.errors.map((message) => redactProviderOutput(String(message)).slice(0, 32_000));
      await this.store.writeText(directory, 'raw-output.txt', response.rawOutput); await this.store.writeText(directory, 'logs.jsonl', response.logs.map((line) => JSON.stringify({ timestamp: new Date().toISOString(), message: line.slice(0, 32_000) })).join('\n'));
      manifest.status = response.status; manifest.completedAt = new Date().toISOString(); manifest.schemaVersion = response.document?.schemaVersion; if (response.errors?.length) manifest.error = safeError(response.status === 'invalid' ? 'INVALID_WALKTHROUGH' : `${request.provider.toUpperCase()}_FAILED`, response.status === 'invalid' ? 'Generated walkthrough failed validation.' : response.errors[0], response.status === 'invalid' ? response.errors.slice(0, 20) : undefined);
      await this.store.writeManifest(directory, manifest); if (response.document) await this.store.writeWalkthrough(directory, response.document); if (response.status === 'ready') progress('complete', 'Walkthrough is ready.');
      return { runId, status: response.status, ...(response.document ? { document: response.document } : {}), ...(manifest.error ? { error: manifest.error } : {}), manifest, artifactDirectory: directory };
    } catch (error) { manifest.status = controller.signal.aborted ? 'cancelled' : 'failed'; manifest.completedAt = new Date().toISOString(); manifest.error = safeError(manifest.status === 'cancelled' ? 'CANCELLED' : 'PREPARATION_FAILED', manifest.status === 'cancelled' ? 'Analysis was cancelled.' : 'Could not prepare this analysis.'); await this.store.writeManifest(directory, manifest); return { runId, status: manifest.status, error: manifest.error, manifest, artifactDirectory: directory }; }
    finally { this.controllers.delete(runId); }
  }
  cancelAnalysis(runId: string): boolean { const controller = this.controllers.get(runId); if (!controller) return false; controller.abort(); return true; }
  listAnalysisRuns(repository: string, pullNumber: number, currentHeadSha?: string): Promise<AnalysisRunSummary[]> { return this.store.listRuns(repository, pullNumber, currentHeadSha); }
  loadAnalysisRun(repository: string, pullNumber: number, runId: string): Promise<AnalysisRunResult | null> { return this.store.loadRun(repository, pullNumber, runId); }
  private async prepareWorktree(request: AnalysisRequest, signal: AbortSignal): Promise<string> {
    const clone = repoPath(this.dataRoot, request.repository); const worktree = resolve(this.dataRoot, 'worktrees', 'github.com', ...request.repository.split('/'), request.headSha); if (!inside(this.dataRoot, clone) || !inside(this.dataRoot, worktree)) throw new Error('Unsafe worktree path.'); await mkdir(resolve(clone, '..'), { recursive: true });
    if (!existsSync(resolve(clone, '.git'))) {
      const mapping = await readRepositoryMapping(this.dataRoot, request.repository);
      if (mapping) {
        // Clone the user's repository into an application-owned checkout. This
        // reads the source repository without changing its branch or worktree;
        // resetting origin makes later fetches deterministic and GitHub-backed.
        await this.runner.run('git', ['clone', '--no-local', mapping.path, clone], { timeout: 120_000, signal });
        await this.runner.run('git', ['remote', 'set-url', 'origin', `https://github.com/${request.repository}.git`], { cwd: clone, timeout: 10_000, signal });
      } else await this.runner.run('gh', ['repo', 'clone', request.repository, clone], { timeout: 120_000, signal });
    }
    await this.runner.run('git', ['fetch', '--no-tags', 'origin', `pull/${request.pullNumber}/head:refs/pr-atlas/${request.pullNumber}`], { cwd: clone, timeout: 120_000, signal });
    if (!existsSync(worktree)) { await mkdir(resolve(worktree, '..'), { recursive: true }); await this.runner.run('git', ['worktree', 'add', '--detach', worktree, request.headSha], { cwd: clone, timeout: 120_000, signal }); }
    return worktree;
  }
  private async collectInputs(request: AnalysisRequest, directory: string, worktree: string, signal: AbortSignal): Promise<void> {
    const api = async (name: string, endpoint: string) => { const result = await this.runner.run('gh', ['api', '--paginate', '--slurp', endpoint], { timeout: 60_000, signal }); await this.store.writeInput(directory, name, JSON.parse(result.stdout.slice(0, 4 * 1024 * 1024))); };
    const prefix = `repos/${request.repository}/pulls/${request.pullNumber}`;
    const reviewThreads = this.github.fetchReviewThreads(request.repository, request.pullNumber, signal).then((value) => this.store.writeInput(directory, 'review-threads', value));
    await Promise.all([api('pull-request', prefix), api('files', `${prefix}/files?per_page=100`), api('commits', `${prefix}/commits?per_page=100`), api('reviews', `${prefix}/reviews?per_page=100`), api('issue-comments', `repos/${request.repository}/issues/${request.pullNumber}/comments?per_page=100`), api('review-comments', `${prefix}/comments?per_page=100`), reviewThreads]);
    const diff = await this.runner.run('git', ['diff', '--no-ext-diff', '--binary', `${request.baseSha}...${request.headSha}`], { cwd: worktree, timeout: 120_000, signal }); await this.store.writeText(directory, 'input/diff.patch', diff.stdout);
  }
  private async invalidResult(input: unknown, error: ReturnType<typeof safeError>): Promise<AnalysisRunResult> { const repository = typeof (input as { repository?: unknown })?.repository === 'string' && validateRepository((input as { repository: string }).repository) ? (input as { repository: string }).repository : 'invalid/invalid'; const pullNumber = Number.isInteger((input as { pullNumber?: unknown })?.pullNumber) ? Number((input as { pullNumber: number }).pullNumber) : 0; const provider = ['claude', 'codex', 'cursor'].includes((input as { provider?: unknown })?.provider as string) ? (input as { provider: AgentProvider }).provider : AGENT_PROVIDER_PRIORITY[0]; const runId = randomUUID(); const manifest: AnalysisManifest = { runId, repository, pullNumber, baseSha: '', headSha: '', provider, status: 'invalid', createdAt: new Date().toISOString(), error }; return { runId, status: 'invalid', error, manifest, artifactDirectory: '' }; }
}
