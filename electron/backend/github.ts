import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BootstrapResult, GithubAccountDTO, PullRequestComment, PullRequestDTO, RepositoryDTO } from '../../shared/contracts.js';
import { safeExternalUrl, validateCommentBody, validatePullNumber, validateRepository } from './validation.js';

const execFileAsync = promisify(execFile);
export interface CommandResult { stdout: string; stderr?: string; }
export interface CommandRunner { run(file: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<CommandResult>; }
export const commandRunner: CommandRunner = { run: async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, { cwd: options?.cwd, timeout: options?.timeout ?? 30_000, signal: options?.signal, env: options?.env, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return { stdout, stderr };
} };

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function str(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function bounded(value: string, max = 4 * 1024 * 1024): string { return value.length > max ? value.slice(0, max) : value; }
function parseJson(value: string, max = 4 * 1024 * 1024): unknown { return JSON.parse(bounded(value, max)); }
export function sanitizeGhError(_error: unknown): string { return 'GitHub CLI request failed. Check your GitHub CLI authentication and repository access.'; }

const REVIEW_THREAD_PAGE_SIZE = 50;
const REVIEW_COMMENT_PAGE_SIZE = 50;
const REVIEW_COMMENT_FIELDS = `
              id
              body
              author { login }
              authorAssociation
              createdAt
              updatedAt
              url
              path
              line
              originalLine
              startLine
              originalStartLine
              diffHunk
              commit { oid }
              originalCommit { oid }
              originalPosition
              position
              outdated
              subjectType
              state
              pullRequestReview { id author { login } state submittedAt }
              replyTo { id }`;

/**
 * The REST pull-request endpoints expose individual reviews and comments, but
 * not the review-thread state that GitHub renders in the conversation UI. Keep
 * the query deliberately data-only: the provider receives the exact GitHub
 * response, including resolved/outdated state, author provenance, replies, and
 * disagreement text.
 */
export const GITHUB_REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:${REVIEW_THREAD_PAGE_SIZE}, after:$endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          resolvedBy { login }
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          subjectType
          comments(first:${REVIEW_COMMENT_PAGE_SIZE}) {
            nodes {
${REVIEW_COMMENT_FIELDS}
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export const GITHUB_REVIEW_THREAD_COMMENTS_QUERY = `query($threadId:ID!,$endCursor:String) {
  node(id:$threadId) {
    ... on PullRequestReviewThread {
      comments(first:${REVIEW_COMMENT_PAGE_SIZE}, after:$endCursor) {
        nodes {${REVIEW_COMMENT_FIELDS}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export class GithubClient {
  private viewerLogin: string | null = null;
  private viewerTeams: Set<string> | null = null;
  private viewerTeamsLoading: Promise<Set<string>> | null = null;
  constructor(private readonly runner: CommandRunner = commandRunner) {}
  async bootstrap(): Promise<BootstrapResult> {
    const warnings: string[] = [];
    this.viewerLogin = null;
    this.viewerTeams = null;
    this.viewerTeamsLoading = null;
    try { await this.runner.run('gh', ['auth', 'status', '--hostname', 'github.com', '--active'], { timeout: 5_000 }); }
    catch { return { account: null, repositories: [], warnings: ['GitHub CLI is not authenticated for github.com.'] }; }
    let account: GithubAccountDTO | null = null;
    try {
      const value = asObject(parseJson((await this.runner.run('gh', ['api', 'user'], { timeout: 10_000 })).stdout));
      account = { source: 'github', login: str(value.login), name: typeof value.name === 'string' ? value.name : null, avatarUrl: typeof value.avatar_url === 'string' ? value.avatar_url : null };
      if (!account.login) throw new Error('missing login');
      this.viewerLogin = account.login;
    } catch { warnings.push('Could not load the active GitHub account.'); }
    try { return { account, repositories: this.mapRepositories(parseJson((await this.runner.run('gh', ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100'], { timeout: 30_000 })).stdout)), warnings }; }
    catch { return { account, repositories: [], warnings: [...warnings, 'Could not list GitHub repositories.'] }; }
  }
  async listPullRequests(repository: string): Promise<PullRequestDTO[]> {
    if (!validateRepository(repository)) throw new Error('Invalid repository.');
    const fields = 'id,number,title,url,author,baseRefName,headRefName,baseRefOid,headRefOid,updatedAt,state,isDraft,additions,deletions,changedFiles,labels,reviewDecision,reviewRequests';
    const result = await this.runner.run('gh', ['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', fields], { timeout: 30_000 });
    const input = parseJson(result.stdout); if (!Array.isArray(input)) throw new Error('Unexpected GitHub pull request response.');
    const pullRequests = input.map((entry) => {
      const pullRequest = this.mapPullRequest(repository, entry);
      return pullRequest ? { pullRequest, reviewRequests: Array.isArray(asObject(entry).reviewRequests) ? asObject(entry).reviewRequests : [] } : null;
    }).filter((entry): entry is { pullRequest: PullRequestDTO; reviewRequests: unknown[] } => entry !== null);
    if (this.viewerLogin) {
      const reviewRequested = await Promise.all(pullRequests.map((entry) => this.viewerReviewRequested(entry.reviewRequests)));
      await Promise.all(pullRequests.map(async (entry, index) => {
        entry.pullRequest = { ...entry.pullRequest, reviewedByViewer: await this.viewerReviewedPullRequest(repository, entry.pullRequest.number), reviewRequested: reviewRequested[index] === true, authoredByViewer: Boolean(entry.pullRequest.author && entry.pullRequest.author.toLowerCase() === this.viewerLogin?.toLowerCase()) };
      }));
    }
    return pullRequests.map((entry) => entry.pullRequest).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPullRequestComments(repository: string, pullNumber: number): Promise<PullRequestComment[]> {
    if (!validateRepository(repository) || !validatePullNumber(pullNumber)) throw new Error('Invalid pull request comments request.');
    try {
      const result = await this.runner.run('gh', [
        'api', '--paginate', '--slurp', `repos/${repository}/issues/${pullNumber}/comments?per_page=100`,
      ], { timeout: 30_000 });
      return flattenRestCommentPages(parseJson(result.stdout, 8 * 1024 * 1024))
        .map((entry) => normalizePullRequestComment(entry, this.viewerLogin))
        .filter((entry): entry is PullRequestComment => entry !== null)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id);
    } catch (error) {
      throw new Error(sanitizeGhError(error));
    }
  }

  async createPullRequestComment(repository: string, pullNumber: number, body: string): Promise<PullRequestComment> {
    if (!validateRepository(repository) || !validatePullNumber(pullNumber) || !validateCommentBody(body)) throw new Error('Invalid pull request comment request.');
    try {
      const result = await this.runner.run('gh', [
        'api', '--method', 'POST', `repos/${repository}/issues/${pullNumber}/comments`, '-f', `body=${body.trim()}`,
      ], { timeout: 30_000 });
      const comment = normalizePullRequestComment(parseJson(result.stdout, 8 * 1024 * 1024), this.viewerLogin);
      if (!comment) throw new Error('Unexpected GitHub comment response.');
      return comment;
    } catch (error) {
      throw new Error(sanitizeGhError(error));
    }
  }

  /** Fetches raw, paginated GraphQL pages for a pull request's review threads. */
  async fetchReviewThreads(repository: string, pullNumber: number, signal?: AbortSignal): Promise<unknown> {
    if (!validateRepository(repository) || !Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid pull request.');
    const [owner, repo] = repository.split('/');
    const result = await this.runner.run('gh', [
      'api', 'graphql', '--paginate', '--slurp',
      '-f', `query=${GITHUB_REVIEW_THREADS_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `repo=${repo}`,
      '-F', `number=${pullNumber}`,
    ], { timeout: 60_000, signal });
    // commandRunner caps stdout at 8 MiB; retain that full bound here so a
    // large thread/reply set is not silently truncated before it reaches the
    // provider input artifact.
    const raw = parseJson(result.stdout, 8 * 1024 * 1024);
    return this.expandReviewThreadComments(raw, signal);
  }

  private async expandReviewThreadComments(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const threads = reviewThreadNodes(value);
    await Promise.all(threads.map(async (thread) => {
      const comments = asObject(thread.comments);
      const pageInfo = asObject(comments.pageInfo);
      if (pageInfo.hasNextPage !== true || !str(thread.id)) return;
      const pages = await this.fetchReviewThreadCommentPages(str(thread.id), str(pageInfo.endCursor), signal);
      const initial = Array.isArray(comments.nodes) ? comments.nodes : [];
      const additional = pages.flatMap((page) => page.nodes);
      const seenCommentIds = new Set<string>();
      comments.nodes = [...initial, ...additional].filter((comment) => {
        const id = str(asObject(comment).id);
        if (!id) return true;
        if (seenCommentIds.has(id)) return false;
        seenCommentIds.add(id);
        return true;
      });
      const finalPage = pages.at(-1);
      if (finalPage && Object.keys(finalPage.pageInfo).length > 0) comments.pageInfo = finalPage.pageInfo;
    }));
    return value;
  }

  private async fetchReviewThreadCommentPages(threadId: string, initialCursor: string, signal?: AbortSignal): Promise<Array<{ nodes: unknown[]; pageInfo: Record<string, unknown> }>> {
    const args = [
      'api', 'graphql', '--paginate', '--slurp',
      '-f', `query=${GITHUB_REVIEW_THREAD_COMMENTS_QUERY}`,
      '-f', `threadId=${threadId}`,
    ];
    if (initialCursor) args.push('-f', `endCursor=${initialCursor}`);
    const result = await this.runner.run('gh', args, { timeout: 60_000, signal });
    return commentPages(parseJson(result.stdout, 8 * 1024 * 1024));
  }

  private async viewerReviewRequested(requests: unknown[]): Promise<boolean> {
    if (!this.viewerLogin) return false;
    const viewer = this.viewerLogin.toLowerCase();
    const possibleTeams: unknown[] = [];
    for (const request of requests) {
      const item = asObject(request);
      const requestedReviewer = asObject(item.requestedReviewer);
      const type = `${str(item.type)} ${str(item.__typename)} ${str(requestedReviewer.__typename)}`.toLowerCase();
      const directLogins = [str(item.login), str(requestedReviewer.login)].filter(Boolean);
      const explicitTeam = type.includes('team') || Boolean(item.slug || item.teamSlug || requestedReviewer.slug || requestedReviewer.teamSlug);
      if (!explicitTeam && directLogins.some((login) => login.toLowerCase() === viewer)) return true;
      // An untyped login is treated conservatively as a direct-user request;
      // only GitHub data that identifies a team can trigger team membership
      // lookup, avoiding false positives from unrelated requests.
      if (explicitTeam) possibleTeams.push(request);
    }
    if (!possibleTeams.length) return false;
    const teams = await this.viewerTeamIdentifiers();
    return possibleTeams.some((request) => [...teamRequestIdentifiers(request)].some((identity) => teams.has(identity)));
  }

  private async viewerTeamIdentifiers(): Promise<Set<string>> {
    if (this.viewerTeams) return this.viewerTeams;
    if (this.viewerTeamsLoading) return this.viewerTeamsLoading;
    this.viewerTeamsLoading = (async () => {
      try {
        const result = await this.runner.run('gh', ['api', '--paginate', '--slurp', 'user/teams?per_page=100'], { timeout: 30_000 });
        const pages = parseJson(result.stdout);
        const teams = new Set<string>();
        const entries = Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page) ? page : [page]) : [];
        for (const entry of entries) for (const identity of teamRecordIdentifiers(entry)) teams.add(identity);
        return teams;
      } catch { return new Set<string>(); }
    })();
    this.viewerTeams = await this.viewerTeamsLoading;
    this.viewerTeamsLoading = null;
    return this.viewerTeams;
  }

  private async viewerReviewedPullRequest(repository: string, pullNumber: number): Promise<boolean> {
    try {
      const result = await this.runner.run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`], { timeout: 30_000 });
      const value = parseJson(result.stdout);
      const reviews = Array.isArray(value) ? value.flatMap((page) => Array.isArray(page) ? page : [page]) : [];
      return reviews.some((review) => {
        const login = str(asObject(asObject(review).user).login);
        return Boolean(login && this.viewerLogin && login.toLowerCase() === this.viewerLogin.toLowerCase());
      });
    } catch {
      // Relationship metadata is additive; an unavailable reviews endpoint
      // must not hide otherwise valid pull requests from the list.
      return false;
    }
  }
  private mapRepositories(value: unknown): RepositoryDTO[] {
    const flat = Array.isArray(value) ? value.flatMap((item) => Array.isArray(item) ? item : [item]) : [];
    return flat.map((entry) => { const item = asObject(entry); const fullName = str(item.full_name); const [owner, name] = fullName.split('/'); if (!validateRepository(fullName) || !owner || !name) return null; return { source: 'github' as const, id: str(item.node_id, fullName), name, fullName, owner, private: item.private === true, defaultBranch: str(item.default_branch, 'main'), updatedAt: str(item.pushed_at || item.updated_at), url: str(item.html_url, `https://github.com/${fullName}`) }; }).filter((entry): entry is RepositoryDTO => entry !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private mapPullRequest(repository: string, value: unknown): PullRequestDTO | null {
    const item = asObject(value); const number = item.number; const baseSha = str(item.baseRefOid); const headSha = str(item.headRefOid);
    if (!Number.isInteger(number) || (number as number) < 1 || !baseSha || !headSha) return null;
    const labels = Array.isArray(item.labels) ? item.labels.map((label) => str(asObject(label).name)).filter(Boolean).sort() : [];
    return { source: 'github', id: str(item.id, `${repository}#${number}`), repository, number: number as number, title: str(item.title), url: str(item.url, `https://github.com/${repository}/pull/${number}`), state: 'open', author: typeof asObject(item.author).login === 'string' ? str(asObject(item.author).login) : null, baseRef: str(item.baseRefName), headRef: str(item.headRefName), baseSha, headSha, updatedAt: str(item.updatedAt), isDraft: item.isDraft === true, additions: Number.isInteger(item.additions) && (item.additions as number) >= 0 ? item.additions as number : 0, deletions: Number.isInteger(item.deletions) && (item.deletions as number) >= 0 ? item.deletions as number : 0, changedFiles: Number.isInteger(item.changedFiles) && (item.changedFiles as number) >= 0 ? item.changedFiles as number : 0, labels, reviewDecision: typeof item.reviewDecision === 'string' ? item.reviewDecision : null, reviewRequested: false, authoredByViewer: Boolean(this.viewerLogin && str(asObject(item.author).login).toLowerCase() === this.viewerLogin.toLowerCase()), reviewedByViewer: false };
  }
}

function flattenRestCommentPages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((page) => flattenRestCommentPages(page));
  return value && typeof value === 'object' ? [value] : [];
}

function normalizePullRequestComment(value: unknown, viewerLogin: string | null): PullRequestComment | null {
  const item = asObject(value);
  const user = asObject(item.user);
  const id = item.id;
  const nodeId = str(item.node_id).trim();
  const body = item.body;
  const author = str(user.login).trim();
  const createdAt = item.created_at;
  const updatedAt = item.updated_at;
  const url = str(item.html_url).trim();
  if (!Number.isSafeInteger(id) || (id as number) < 1 || !nodeId || typeof body !== 'string' || !author || typeof createdAt !== 'string' || typeof updatedAt !== 'string' || !safeExternalUrl(url)) return null;
  return {
    id: id as number,
    nodeId,
    body,
    author,
    authorAvatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
    authorAssociation: typeof item.author_association === 'string' ? item.author_association : null,
    createdAt,
    updatedAt,
    url,
    viewerDidAuthor: Boolean(viewerLogin && author.toLowerCase() === viewerLogin.toLowerCase()),
  };
}

function reviewThreadNodes(value: unknown): Array<Record<string, unknown>> {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const data = asObject(asObject(page).data);
    const repository = asObject(data.repository);
    const pullRequest = asObject(repository.pullRequest);
    const reviewThreads = asObject(pullRequest.reviewThreads);
    return Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes.map(asObject) : [];
  });
}

function commentPages(value: unknown): Array<{ nodes: unknown[]; pageInfo: Record<string, unknown> }> {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const data = asObject(asObject(page).data);
    const node = asObject(data.node);
    const comments = asObject(node.comments);
    return [{
      nodes: Array.isArray(comments.nodes) ? comments.nodes : [],
      pageInfo: asObject(comments.pageInfo),
    }];
  });
}

function normalizedIdentity(value: unknown): string {
  return str(value).trim().toLowerCase();
}

function addIdentity(identities: Set<string>, value: unknown): void {
  const normalized = normalizedIdentity(value);
  if (normalized) identities.add(normalized);
}

function teamPrimitiveIdentifiers(value: unknown): Set<string> {
  const item = asObject(value);
  const identities = new Set<string>();
  for (const key of ['id', 'node_id', 'slug', 'teamSlug', 'name', 'login']) addIdentity(identities, item[key]);
  return identities;
}

function teamRecordIdentifiers(value: unknown): Set<string> {
  const item = asObject(value);
  const organization = asObject(item.organization);
  const identities = new Set<string>();
  for (const identity of teamPrimitiveIdentifiers(item)) identities.add(identity);

  const organizationIdentity = normalizedIdentity(organization.login || organization.slug || organization.name);
  const teamIdentity = normalizedIdentity(item.slug || item.teamSlug || item.login || item.name);
  if (organizationIdentity && teamIdentity) {
    identities.add(`${organizationIdentity}/${teamIdentity}`);
    identities.add(`${organizationIdentity}:${teamIdentity}`);
  }
  return identities;
}

function teamRequestIdentifiers(value: unknown): Set<string> {
  const item = asObject(value);
  const requestedReviewer = asObject(item.requestedReviewer);
  const itemOrganization = asObject(item.organization);
  const reviewerOrganization = asObject(requestedReviewer.organization);
  const organization = Object.keys(itemOrganization).length ? itemOrganization : reviewerOrganization;
  const organizationIdentity = normalizedIdentity(organization.login || organization.slug || organization.name);
  const identities = new Set<string>();
  if (!organizationIdentity) {
    for (const identity of teamRecordIdentifiers(item)) identities.add(identity);
    for (const identity of teamRecordIdentifiers(requestedReviewer)) identities.add(identity);
    return identities;
  }

  // A team slug/name is only an exact match within its organization. Keep
  // globally unique IDs as a fallback, but never let an unscoped team name in
  // one organization match a same-named team in another organization.
  for (const source of [item, requestedReviewer]) {
    for (const key of ['id', 'node_id']) {
      const identity = normalizedIdentity(asObject(source)[key]);
      if (identity) identities.add(identity);
    }
    for (const key of ['slug', 'teamSlug', 'name', 'login']) {
      const identity = normalizedIdentity(asObject(source)[key]);
      if (!identity) continue;
      identities.add(`${organizationIdentity}/${identity}`);
      identities.add(`${organizationIdentity}:${identity}`);
    }
  }
  return identities;
}
