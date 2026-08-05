import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDown, ArrowUp, Bot, Check, ChevronDown, CircleHelp,
  Clock3, Code2, ExternalLink, FileCode2, Files, GitPullRequest, GitPullRequestArrow,
  History, LayoutList, ListFilter, Loader2, MessageSquare, MoreHorizontal, Network,
  Play, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Square, TestTube2,
  UserRound, Users, Workflow, X,
} from 'lucide-react';
import { analysisStages, pullRequests, repositories } from './data/demo';
import { AnalysisStage, ChangeGroup, Evidence, Flow, FlowNode, PullRequest, PRStatus, Repository, ReviewInsight, ReviewReply, ReviewState, ReviewThread, TestMapping } from './types';
import RichThreadsView from './components/ThreadsView';
import { AGENT_PROVIDER_PRIORITY, type AgentInstallationStatus, type AgentProvider, type AnalysisProgressEvent, type AnalysisRunResult, type AnalysisRunSummary, type BootstrapResult, type Graph as ContractGraph, type GraphEdge, type GraphNode, type PullRequestDTO, type RepositoryDTO, type UpdateCheckResult, type WalkthroughDocument } from '../shared/contracts';

type View = 'overview' | 'walkthrough' | 'groups' | 'insights' | 'flows' | 'files' | 'tests' | 'threads' | 'details';
export type Filter = 'all' | PRStatus | 'mine' | 'review' | 'reviewed';
type UpdateDownloadState = 'idle' | 'downloading' | 'downloaded' | 'failed';
const reviewKey = (prId: string, groupId: string) => `${prId}:${groupId}`;
const MIN_GRAPH_ZOOM = 25;

const statusMeta: Record<PRStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'ready' },
  outdated: { label: 'Outdated', tone: 'outdated' },
  processing: { label: 'Processing', tone: 'processing' },
  unprocessed: { label: 'Unprocessed', tone: 'unprocessed' },
  failed: { label: 'Failed', tone: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'failed' },
};

const viewItems: { id: View; label: string; icon: typeof LayoutList }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutList },
  { id: 'walkthrough', label: 'Walkthrough', icon: Sparkles },
  { id: 'groups', label: 'Change groups', icon: GitPullRequestArrow },
  { id: 'insights', label: 'Insights', icon: AlertCircle },
  { id: 'flows', label: 'Flows', icon: Network },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'tests', label: 'Tests', icon: TestTube2 },
  { id: 'threads', label: 'Review threads', icon: MessageSquare },
  { id: 'details', label: 'Analysis details', icon: Code2 },
];

const liveApi = () => (typeof window !== 'undefined' ? window.prAtlas : undefined);
const safeString = (value: unknown, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const safeArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const shortSha = (sha: string) => sha ? sha.slice(0, 7) : 'unknown';
const initialsFor = (name: string | null) => safeString(name, 'GitHub').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const relativeDate = (iso: string) => { const timestamp = Date.parse(iso); if (Number.isNaN(timestamp)) return iso || 'unknown'; const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000)); return minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} hr ago` : `${Math.round(minutes / 1440)} days ago`; };
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedTheme = Exclude<ThemeMode, 'system'>;
const THEME_STORAGE_KEY = 'atlas:theme';
const PROVIDER_STORAGE_KEY = 'atlas:provider';
const MODEL_STORAGE_KEY = 'atlas:provider-models';
const CUSTOM_PROMPT_STORAGE_KEY = 'atlas:custom-prompt';
const providerDefaults: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor Agent' };
const themeModes: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return 'system';
    let value: unknown = raw;
    try { value = JSON.parse(raw); } catch { /* accept legacy unquoted values */ }
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

function readSystemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readProviderPreference(): AgentProvider | null {
  try {
    const raw = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!raw) return null;
    let value: unknown = raw;
    try { value = JSON.parse(raw); } catch { /* accept legacy unquoted values */ }
    return value === 'claude' || value === 'codex' || value === 'cursor' ? value : null;
  } catch {
    return null;
  }
}

function providerLabel(provider: string | undefined): string {
  return provider && provider in providerDefaults ? providerDefaults[provider as AgentProvider] : provider || 'Unknown provider';
}

function providerStatusLabel(status: AgentInstallationStatus): string {
  return status.installed ? `Installed${status.version ? ` · ${status.version}` : ''}` : 'Unavailable';
}

function emptyLivePR(dto: PullRequestDTO, repository: Repository): PullRequest {
  return {
    source: 'github', id: dto.id, number: dto.number, repositoryId: repository.id, repositoryFullName: dto.repository,
    title: dto.title, author: dto.author ?? 'Unknown author', initials: initialsFor(dto.author), branch: dto.headRef, base: dto.baseRef,
    baseSha: dto.baseSha, headSha: dto.headSha, url: dto.url, updated: relativeDate(dto.updatedAt), additions: dto.additions,
    deletions: dto.deletions, files: dto.changedFiles, status: 'unprocessed', labels: dto.labels, summary: 'No walkthrough generated for this GitHub pull request yet.',
    changedAreas: dto.labels.length ? dto.labels : ['Repository changes'], groups: [], insights: [], flows: [], tests: [], threads: [], evidence: [], history: [],
    draft: dto.isDraft, reviewDecision: dto.reviewDecision, reviewRequested: dto.reviewRequested,
    authoredByViewer: dto.authoredByViewer === true, reviewedByViewer: dto.reviewedByViewer === true,
  };
}

function mapRepository(dto: RepositoryDTO): Repository {
  return { source: 'github', id: dto.fullName, name: dto.name, owner: dto.owner, fullName: dto.fullName, host: 'github.com', openPRs: 0, private: dto.private, defaultBranch: dto.defaultBranch, updatedAt: dto.updatedAt, url: dto.url };
}

function mapGraph(contract: ContractGraph | undefined, fallback: Flow): Flow {
  if (!contract) return fallback;
  const ids = (value: unknown) => safeArray(value).filter((id): id is string => typeof id === 'string');
  const nodes = safeArray(contract.nodes).map((raw, index) => { const node = objectValue(raw); const id = safeString(node.id, `${contract.id}-${index + 1}`); return { id, label: safeString(node.label ?? node.title, id), explanation: safeString(node.explanation, 'No additional explanation provided.'), changed: node.changed === true, evidenceIds: ids(node.evidenceIds), changeGroupIds: ids(node.changeGroupIds), testIds: ids(node.testIds), reviewThreadIds: ids(node.reviewThreadIds), reviewInsightIds: ids(node.reviewInsightIds) }; });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = contract.id === 'system-overview' ? [] : safeArray(contract.edges).flatMap((raw, index) => { const edge = objectValue(raw) as Partial<GraphEdge>; return typeof edge.source === 'string' && typeof edge.target === 'string' && nodeIds.has(edge.source) && nodeIds.has(edge.target) ? [{ id: safeString(edge.id, `${contract.id}-edge-${index + 1}`), source: edge.source, target: edge.target, label: safeString(edge.label, 'connects'), evidenceIds: ids(edge.evidenceIds), changeGroupIds: ids(edge.changeGroupIds), reviewThreadIds: ids(edge.reviewThreadIds) }] : []; });
  const guidedTours = safeArray(contract.guidedTours).map((raw, index) => { const tour = objectValue(raw); return { id: safeString(tour.id, `${contract.id}-tour-${index + 1}`), title: safeString(tour.title, `Review ${fallback.title}`), steps: safeArray(tour.steps).map((step) => { const item = objectValue(step); return { nodeId: safeString(item.nodeId), title: safeString(item.title), explanation: safeString(item.explanation) }; }).filter((step) => nodeIds.has(step.nodeId)) }; });
  return { id: contract.id, type: contract.id, title: fallback.title, description: safeString((contract as unknown as Record<string, unknown>).description, fallback.description), nodes, edges, guidedTours: guidedTours.length ? guidedTours : fallback.guidedTours };
}

export function mapWalkthroughDocument(document: WalkthroughDocument, pr: PullRequest, provider?: string): PullRequest {
  const evidence = safeArray(document.evidence).map((raw, index) => { const item = objectValue(raw); return { id: safeString(item.id, `evidence-${index + 1}`), label: safeString(item.title ?? item.label, `Evidence ${index + 1}`), path: safeString(item.path ?? item.location, safeString(item.id, 'Unknown evidence')), kind: safeString(item.kind, 'file') as Evidence['kind'], ...(Number.isInteger(item.line) && Number(item.line) > 0 ? { line: Number(item.line) } : {}), ...(typeof item.url === 'string' ? { url: item.url } : {}) }; });
  const evidenceById = new Map(safeArray(document.evidence).map((raw) => { const item = objectValue(raw); return [safeString(item.id), item]; }));
  const evidenceLocation = (id: unknown, fallback: string) => { const item = typeof id === 'string' ? evidenceById.get(id) : undefined; if (!item) return fallback; const path = safeString(item.path ?? item.location, fallback); return Number.isInteger(item.line) && Number(item.line) > 0 ? `${path}:${Number(item.line)}` : path; };
  const rawGroups = safeArray(document.changeGroups).map((raw, index) => { const item = objectValue(raw); const ids = safeArray(item.evidenceIds).filter((id): id is string => typeof id === 'string'); const files = ids.map((id) => evidenceById.get(id)).map((item) => item && safeString(item.path ?? item.location)).filter((path): path is string => Boolean(path)); const attention = safeString(item.attention, 'medium'); return { id: safeString(item.id, `change-${index + 1}`), title: safeString(item.title, `Change group ${index + 1}`), description: safeString(item.summary ?? item.description, 'No group summary provided.'), attention: (attention === 'high' || attention === 'low' ? attention : 'medium') as ChangeGroup['attention'], files, before: safeString(item.previousBehavior ?? item.before, 'Previous behavior is not specified.'), after: safeString(item.newBehavior ?? item.after, 'New behavior is not specified.'), rationale: safeString(item.motivation ?? item.rationale, 'The walkthrough did not provide a motivation.'), reviewed: false, evidenceIds: ids }; });
  const order = new Map(safeArray(document.walkthrough).map((raw, index) => { const item = objectValue(raw); return [safeString(item.changeGroupId), index]; }));
  rawGroups.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const graphs = document.graphs ?? {};
  const flows = (['systemOverview', 'dataFlow', 'codeDependency', 'userAction'] as const).map((key) => { const graph = objectValue(graphs)[key] as ContractGraph | undefined; const fallbackId = key === 'systemOverview' ? 'system-overview' : key === 'dataFlow' ? 'data-flow' : key === 'codeDependency' ? 'code-dependency' : 'user-action'; const neutralFallback: Flow = { id: fallbackId, type: fallbackId, title: key === 'systemOverview' ? 'System overview' : key === 'dataFlow' ? 'Data flow' : key === 'codeDependency' ? 'Code dependency' : 'User action', description: 'No graph details were provided by this walkthrough.', nodes: [], edges: [], guidedTours: [] }; return mapGraph(graph, neutralFallback); });
  const tests = safeArray(document.tests).map((raw, index) => { const item = objectValue(raw); return { id: safeString(item.id, `test-${index + 1}`), test: safeString(item.title ?? item.name, `Test ${index + 1}`), behavior: safeString(item.behavior ?? item.description, 'Behavior mapping not specified.'), status: (safeString(item.status, 'missing') === 'covered' ? 'covered' : safeString(item.status, '') === 'partial' ? 'partial' : 'missing') as TestMapping['status'], evidence: evidenceLocation(safeArray(item.evidenceIds)[0], 'No evidence linked') }; });
  const nullableString = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
  const nullableLine = (value: unknown) => Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
  const threads = safeArray(document.reviewThreads).flatMap((raw, index) => {
    const item = objectValue(raw);
    const status = safeString(item.status, 'active').toLowerCase();
    if (status === 'absent' || status === 'none') return [];
    const evidenceId = safeArray(item.evidenceIds)[0];
    const evidenceItem = typeof evidenceId === 'string' ? evidenceById.get(evidenceId) : undefined;
    const path = nullableString(item.path) ?? (evidenceItem ? nullableString(evidenceItem.path ?? evidenceItem.location) : null);
    const author = safeString(item.author ?? item.user, 'Review participant');
    const provenance = safeString(item.provenance, 'human');
    const state = (['active', 'open', 'resolved', 'outdated', 'disputed', 'dismissed', 'informational', 'unknown'].includes(status) ? status : 'active') as ReviewState;
    const replies = safeArray(item.replies).map((rawReply, replyIndex): ReviewReply => {
      const reply = objectValue(rawReply);
      const replyAuthor = safeString(reply.author ?? reply.user, 'Review participant');
      return {
        id: safeString(reply.id, `thread-${index + 1}-reply-${replyIndex + 1}`),
        author: replyAuthor,
        initials: initialsFor(replyAuthor),
        body: safeString(reply.body, 'Reply content is not specified.'),
        authorAssociation: nullableString(reply.authorAssociation),
        createdAt: nullableString(reply.createdAt),
        updatedAt: nullableString(reply.updatedAt),
        url: nullableString(reply.url),
        path: nullableString(reply.path),
        line: nullableLine(reply.line),
        originalLine: nullableLine(reply.originalLine),
        side: nullableString(reply.side),
        commitSha: nullableString(reply.commitSha),
        originalCommitSha: nullableString(reply.originalCommitSha),
      };
    });
    const replyCount = Number.isInteger(item.replyCount) && Number(item.replyCount) >= 0 ? Number(item.replyCount) : replies.length;
    return [{
      id: safeString(item.id, `thread-${index + 1}`), author, initials: initialsFor(author), body: safeString(item.body ?? item.summary, 'Review thread content is not specified.'),
      state, provenance, evidenceIds: safeArray(item.evidenceIds).filter((id): id is string => typeof id === 'string'), authorAssociation: nullableString(item.authorAssociation), createdAt: nullableString(item.createdAt), updatedAt: nullableString(item.updatedAt),
      url: nullableString(item.url), resolvedBy: nullableString(item.resolvedBy), path, file: path ?? 'Repository evidence', line: nullableLine(item.line) ?? (evidenceItem ? nullableLine(evidenceItem.line) : null),
      originalLine: nullableLine(item.originalLine), side: nullableString(item.side), startLine: nullableLine(item.startLine), originalStartLine: nullableLine(item.originalStartLine),
      commitSha: nullableString(item.commitSha), originalCommitSha: nullableString(item.originalCommitSha), replies, replyCount,
      changeGroupIds: safeArray(item.changeGroupIds).filter((id): id is string => typeof id === 'string'), graphNodeIds: safeArray(item.graphNodeIds).filter((id): id is string => typeof id === 'string'), reviewInsightIds: safeArray(item.reviewInsightIds).filter((id): id is string => typeof id === 'string'),
      source: (provenance === 'automated' ? 'bot' : 'human') as ReviewThread['source'],
    }];
  });
  const insights = safeArray(document.reviewInsights).map((raw, index) => { const item = objectValue(raw); const status = safeString(item.status, 'active'); return { id: safeString(item.id, `insight-${index + 1}`), title: safeString(item.title, `Review insight ${index + 1}`), detail: safeString(item.detail ?? item.summary, 'No additional review insight detail provided.'), provenance: safeString(item.provenance, 'automated') === 'human' ? 'human' : 'automated', state: (['resolved', 'outdated', 'disputed'].includes(status) ? status : 'active') as ReviewState, location: evidenceLocation(safeArray(item.evidenceIds)[0], 'Repository evidence'), count: Math.max(1, safeArray(item.reviewThreadIds).length) } as ReviewInsight; });
  const runProvider = safeString(document.run?.provider).toLowerCase();
  const analysisProvenance: PullRequest['analysisProvenance'] = provider === 'claude' || provider === 'codex' || provider === 'cursor' ? provider : (runProvider === 'claude' || runProvider === 'codex' || runProvider === 'cursor' ? runProvider : 'claude');
  return { ...pr, groups: rawGroups, insights, flows, tests, evidence, threads, summary: safeString(document.summary?.intent, 'Walkthrough loaded from the validated provider artifact.'), analysisProvenance, walkthrough: document };
}

export function matchesRelationshipFilter(pr: PullRequest, filter: Filter): boolean {
  if (filter === 'mine') return pr.authoredByViewer === true;
  if (filter === 'review') return pr.reviewRequested === true;
  if (filter === 'reviewed') return pr.reviewedByViewer === true;
  return true;
}

export function calculateFitZoom(surfaceWidth: number, surfaceHeight: number): number {
  return Math.max(MIN_GRAPH_ZOOM, Math.min(120, Math.floor(Math.min(700 / Math.max(1, surfaceWidth), 360 / Math.max(1, surfaceHeight)) * 100)));
}

function readStored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function StatusPill({ status }: { status: PRStatus }) {
  const meta = statusMeta[status];
  return <span className={`status-pill ${meta.tone}`}><span className="status-dot" />{meta.label}</span>;
}

function Avatar({ initials, className = '' }: { initials: string; className?: string }) {
  return <span className={`avatar ${className}`} aria-hidden="true">{initials}</span>;
}

function App() {
  const api = liveApi();
  const electronMode = Boolean(api);
  const [hasStoredRepositorySelection] = useState(() => localStorage.getItem('atlas:selected-repo') !== null);
  const [selectedRepo, setSelectedRepo] = useState(() => readStored('atlas:selected-repo', 'atlas'));
  const [filter, setFilter] = useState<Filter>(() => readStored('atlas:filter', 'all'));
  const [repositoryQuery, setRepositoryQuery] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(() => readStored('atlas:selected-pr', 'atlas-482'));
  const [view, setView] = useState<View>('overview');
  const [flowType, setFlowType] = useState<Flow['type']>('system-overview');
  const [reviewed, setReviewed] = useState<Record<string, boolean>>(() => readStored('atlas:reviewed', {}));
  const [analysis, setAnalysis] = useState<{ id: string; runId?: string; stage: number; running: boolean; live?: boolean; provider?: AgentProvider } | null>(null);
  const [analysisDone, setAnalysisDone] = useState<Record<string, boolean>>({});
  const [account, setAccount] = useState<{ label: string; detail: string; live: boolean }>({ label: 'Local fixture', detail: 'GitHub CLI not connected in browser preview', live: false });
  const [liveRepositories, setLiveRepositories] = useState<Repository[]>([]);
  const [livePRs, setLivePRs] = useState<Record<string, PullRequest[]>>({});
  const [liveRuns, setLiveRuns] = useState<Record<string, AnalysisRunSummary[]>>({});
  const [liveDocuments, setLiveDocuments] = useState<Record<string, WalkthroughDocument>>({});
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [mappingStatus, setMappingStatus] = useState<string | null>(null);
  const [confirmLiveAnalysis, setConfirmLiveAnalysis] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [analysisStatus, setAnalysisStatus] = useState<PRStatus | null>(null);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const resolvedTheme: ResolvedTheme = themeMode === 'system' ? systemTheme : themeMode;
  const [providers, setProviders] = useState<AgentInstallationStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateDownloadState, setUpdateDownloadState] = useState<UpdateDownloadState>('idle');
  const [updateDownloadError, setUpdateDownloadError] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(() => readProviderPreference() ?? AGENT_PROVIDER_PRIORITY[0]);
  const [selectedModels, setSelectedModels] = useState<Partial<Record<AgentProvider, string>>>(() => readStored(MODEL_STORAGE_KEY, {}));
  const [customPrompt, setCustomPrompt] = useState(() => readStored(CUSTOM_PROMPT_STORAGE_KEY, ''));
  const selectedProviderStatus = providers.find((status) => status.provider === selectedProvider);
  const activeProviderName = electronMode ? (selectedProviderStatus?.displayName ?? providerLabel(selectedProvider)) : 'Demo runtime';

  useEffect(() => { localStorage.setItem('atlas:selected-repo', JSON.stringify(selectedRepo)); }, [selectedRepo]);
  useEffect(() => { localStorage.setItem('atlas:filter', JSON.stringify(filter)); }, [filter]);
  useEffect(() => { localStorage.setItem('atlas:selected-pr', JSON.stringify(selectedId)); }, [selectedId]);
  useEffect(() => { localStorage.setItem('atlas:reviewed', JSON.stringify(reviewed)); }, [reviewed]);
  useEffect(() => { localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selectedModels)); }, [selectedModels]);
  useEffect(() => { localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, JSON.stringify(customPrompt)); }, [customPrompt]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    if (themeMode !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'dark' : 'light');
    setSystemTheme(media.matches ? 'dark' : 'light');
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else media.addListener?.(onChange);
    return () => {
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
      else media.removeListener?.(onChange);
    };
  }, [themeMode]);

  const chooseTheme = (next: ThemeMode) => {
    setThemeMode(next);
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next));
  };
  const chooseProvider = (next: AgentProvider) => {
    if (electronMode && !providers.find((status) => status.provider === next)?.installed) return;
    setSelectedProvider(next);
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next));
  };
  const applyProviderStatuses = (statuses: AgentInstallationStatus[]) => {
    const priority = new Map(AGENT_PROVIDER_PRIORITY.map((provider, index) => [provider, index]));
    const orderedStatuses = [...statuses].sort((left, right) => (priority.get(left.provider) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right.provider) ?? Number.MAX_SAFE_INTEGER));
    setProviders(orderedStatuses);
    setProviderError(null);
    setSelectedModels((current) => {
      const next = { ...current };
      for (const status of orderedStatuses) {
        const models = status.models ?? [];
        if (!models.length) { delete next[status.provider]; continue; }
        if (!models.some((model) => model.id === next[status.provider])) next[status.provider] = (models.find((model) => model.isDefault) ?? models[0]).id;
      }
      return next;
    });
    setSelectedProvider((current) => {
      if (orderedStatuses.some((status) => status.provider === current && status.installed)) return current;
      const fallback = orderedStatuses.find((status) => status.installed);
      return fallback?.provider ?? current;
    });
  };
  const loadProviders = () => {
    const currentApi = api;
    if (!currentApi) return;
    setProvidersLoading(true);
    void currentApi.listProviders!().then(applyProviderStatuses).catch((error: unknown) => setProviderError(error instanceof Error ? error.message : 'Could not detect analysis providers.')).finally(() => setProvidersLoading(false));
  };
  useEffect(() => {
    if (!api) return;
    loadProviders();
    setLiveLoading(true);
    void api.bootstrap().then((result: BootstrapResult) => {
      setAccount(result.account ? { label: `@${result.account.login}`, detail: result.warnings.join(' ') || 'Read-only GitHub CLI session', live: true } : { label: 'GitHub CLI offline', detail: result.warnings.join(' ') || 'GitHub CLI unavailable; fixture data is still available.', live: false });
      setLiveRepositories(result.repositories.map(mapRepository));
      if (result.repositories[0]) setSelectedRepo((current) => (hasStoredRepositorySelection && repositories.some((repo) => repo.id === current)) || result.repositories.some((repo) => repo.fullName === current) ? current : result.repositories[0].fullName);
      setLiveError(result.warnings.length ? result.warnings.join(' ') : null);
    }).catch((error: unknown) => { setAccount({ label: 'GitHub CLI offline', detail: 'Could not load GitHub discovery; fixture data is still available.', live: false }); setLiveError(error instanceof Error ? error.message : 'Could not load GitHub discovery.'); }).finally(() => setLiveLoading(false));
  }, [api, hasStoredRepositorySelection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api?.checkForUpdate) return;
    let cancelled = false;
    void api.checkForUpdate().then((result) => { if (!cancelled) { setUpdateInfo(result); setUpdateDownloadState('idle'); setUpdateDownloadError(''); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeAnalysisProgress((event: AnalysisProgressEvent) => {
      setAnalysisMessage(event.message);
      setAnalysis((current) => current && (current.runId === event.runId || (current.live && current.id === selectedId)) ? { ...current, runId: event.runId, stage: event.stage === 'complete' ? analysisStages.length - 1 : Math.max(0, ['preparing', 'collecting', 'inspecting', 'generating', 'validating', 'complete'].indexOf(event.stage)), message: event.message } : current);
    });
  }, [api, selectedId]);

  const allRepositories = useMemo(() => [...repositories, ...liveRepositories], [liveRepositories]);
  const visibleRepositories = useMemo(() => { const needle = repositoryQuery.trim().toLowerCase(); return allRepositories.filter((repo) => !needle || repo.id === selectedRepo || `${repo.owner}/${repo.name} ${repo.fullName ?? ''}`.toLowerCase().includes(needle)); }, [allRepositories, repositoryQuery, selectedRepo]);
  const selectedRepository = allRepositories.find((repo) => repo.id === selectedRepo) ?? repositories[0];
  const isLiveRepository = selectedRepository.source === 'github';
  const repoPRs = useMemo(() => isLiveRepository ? (livePRs[selectedRepository.id] ?? []) : pullRequests.filter((pr) => pr.repositoryId === selectedRepo), [isLiveRepository, livePRs, selectedRepository.id, selectedRepo]);

  useEffect(() => {
    if (!api || !isLiveRepository || !selectedRepository.fullName || livePRs[selectedRepository.id]) return;
    let cancelled = false;
    setLiveLoading(true); setLiveError(null);
    void api.listPullRequests(selectedRepository.fullName).then(async (dtos) => {
      if (cancelled) return;
      const mapped = dtos.map((dto) => emptyLivePR(dto, selectedRepository));
      setLivePRs((current) => ({ ...current, [selectedRepository.id]: mapped }));
      await Promise.all(mapped.map(async (pr) => {
        try {
          const runs = await api.listAnalysisRuns(selectedRepository.fullName!, pr.number, pr.headSha);
          if (cancelled) return;
          setLiveRuns((current) => ({ ...current, [pr.id]: runs }));
          const currentReady = runs.find((run) => run.status === 'ready' && !run.outdated);
          const latest = runs[0];
          let next: PullRequest = { ...pr, status: latest?.status === 'failed' || latest?.status === 'invalid' ? 'failed' : latest?.status === 'cancelled' ? 'cancelled' : latest?.outdated ? 'outdated' : 'unprocessed', analyzedSha: latest?.headSha, analysisDiagnostic: latest?.error?.message, history: runs.map((run) => ({ id: run.runId, date: relativeDate(run.createdAt), duration: '—', status: run.status === 'ready' ? 'completed' : run.status, provider: run.provider, model: run.model ?? 'Tool default', schemaVersion: run.schemaVersion, skillVersion: run.skillContractVersion, statusLabel: run.error?.message })) as PullRequest['history'] };
          if (currentReady) {
            const result = await api.loadAnalysisRun(selectedRepository.fullName!, pr.number, currentReady.runId);
            if (result?.status === 'ready' && result.document) { setLiveDocuments((current) => ({ ...current, [pr.id]: result.document! })); next = { ...mapWalkthroughDocument(result.document, next, currentReady?.provider), status: 'ready', evidenceHeadSha: currentReady.headSha }; }
            else next = { ...next, status: 'failed', analysisDiagnostic: 'Saved walkthrough failed strict validation. Run analysis again.' };
          }
          setLivePRs((current) => ({ ...current, [selectedRepository.id]: (current[selectedRepository.id] ?? []).map((item) => item.id === pr.id ? next : item) }));
        } catch (error) { if (!cancelled) setLiveError(error instanceof Error ? error.message : 'Could not load analysis history.'); }
      }));
    }).catch((error: unknown) => { if (!cancelled) setLiveError(error instanceof Error ? error.message : 'Could not load pull requests.'); }).finally(() => { if (!cancelled) setLiveLoading(false); });
    return () => { cancelled = true; };
  }, [api, isLiveRepository, selectedRepository]);

  useEffect(() => {
    if (repoPRs.length && !repoPRs.some((pr) => pr.id === selectedId)) setSelectedId(repoPRs[0].id);
  }, [repoPRs, selectedId]);
  const visiblePRs = useMemo(() => repoPRs.filter((pr) => {
    const matchesStatus = filter === 'all' || (['ready', 'processing', 'unprocessed', 'outdated', 'failed'] as PRStatus[]).includes(filter as PRStatus) && pr.status === filter;
    const matchesRelationship = matchesRelationshipFilter(pr, filter);
    const haystack = `${pr.title} ${pr.number} ${pr.author} ${pr.branch}`.toLowerCase();
    return matchesStatus && matchesRelationship && haystack.includes(query.toLowerCase());
  }), [repoPRs, filter, query, reviewed]);
  const baseSelectedPR = repoPRs.find((pr) => pr.id === selectedId) ?? repoPRs[0] ?? (isLiveRepository ? null : pullRequests[0]);
  const fixtureReadyPR = pullRequests.find((pr) => pr.status === 'ready' && pr.groups.length > 0) ?? pullRequests[0];
  const liveDocument = baseSelectedPR?.source === 'github' ? liveDocuments[baseSelectedPR.id] : undefined;
  const selectedPR = !baseSelectedPR ? null : liveDocument ? mapWalkthroughDocument(liveDocument, baseSelectedPR, baseSelectedPR.analysisProvenance) : baseSelectedPR.source === 'fixture' && analysisDone[baseSelectedPR.id] && (baseSelectedPR.groups.length === 0 || baseSelectedPR.status === 'outdated')
    ? { ...baseSelectedPR, status: 'ready' as const, groups: fixtureReadyPR.groups, insights: fixtureReadyPR.insights, flows: fixtureReadyPR.flows, tests: fixtureReadyPR.tests, threads: fixtureReadyPR.threads, evidence: fixtureReadyPR.evidence, history: [...baseSelectedPR.history, { id: `${baseSelectedPR.id}-local`, date: 'Just now', duration: '3m 12s', status: 'completed' as const, model: 'Codex local' }] }
    : baseSelectedPR;

  useEffect(() => {
    if (selectedPR && selectedPR.repositoryId !== selectedRepo) setSelectedId(repoPRs[0]?.id ?? pullRequests[0].id);
  }, [selectedRepo]); // eslint-disable-line react-hooks/exhaustive-deps

  const runLiveAnalysis = async () => {
    const provider = selectedProviderStatus?.provider;
    if (!api || !selectedPR || selectedPR.source !== 'github' || !selectedPR.repositoryFullName || analysis?.running) return;
    if (!provider || !selectedProviderStatus?.installed) { setConfirmLiveAnalysis(false); setSettingsOpen(true); setAnalysisMessage('Select an installed analysis provider before starting.'); return; }
    setConfirmLiveAnalysis(false); setView('walkthrough'); setAnalysisMessage(`Preparing ${selectedProviderStatus.displayName} analysis…`); setAnalysisStatus('processing'); setAnalysis({ id: selectedPR.id, stage: 0, running: true, live: true, provider });
    let result: AnalysisRunResult;
    try {
      const model = selectedModels[provider];
      const supplemental = customPrompt.trim();
      result = await api.startAnalysis({ repository: selectedPR.repositoryFullName, pullNumber: selectedPR.number, baseSha: selectedPR.baseSha, headSha: selectedPR.headSha, provider, ...(model ? { model } : {}), ...(supplemental ? { customPrompt: supplemental } : {}) });
    } catch (error) {
      setAnalysisStatus('failed'); setAnalysisMessage(error instanceof Error ? error.message : 'Analysis request failed.'); setAnalysis((current) => current ? { ...current, running: false } : current); return;
    }
    setAnalysis((current) => current ? { ...current, runId: result.runId, running: false, stage: analysisStages.length - 1, provider } : current);
    if (result.status === 'ready' && result.document) {
      setLiveDocuments((current) => ({ ...current, [selectedPR.id]: result.document! })); setAnalysisStatus('ready'); setAnalysisMessage('Walkthrough is ready.');
      setLiveRuns((current) => ({ ...current, [selectedPR.id]: [{ ...result.manifest, artifactDirectory: result.artifactDirectory }, ...(current[selectedPR.id] ?? []).filter((run) => run.runId !== result.runId)] }));
      setLivePRs((current) => ({ ...current, [selectedRepository.id]: (current[selectedRepository.id] ?? []).map((pr) => pr.id === selectedPR.id ? { ...mapWalkthroughDocument(result.document!, pr, result.manifest.provider), status: 'ready', analysisProvenance: result.manifest.provider, analyzedSha: result.manifest.headSha, evidenceHeadSha: result.manifest.headSha, history: [{ id: result.runId, date: 'Just now', duration: '—', status: 'completed' as const, provider: result.manifest.provider, model: result.manifest.model ?? result.document!.run.model ?? 'Tool default', schemaVersion: result.manifest.schemaVersion, skillVersion: result.manifest.skillContractVersion }, ...pr.history] } : pr) }));
    } else {
      const status: PRStatus = result.status === 'cancelled' ? 'cancelled' : 'failed'; setAnalysisStatus(status); setAnalysisMessage(result.error?.message ?? `Analysis ${result.status}.`);
      setLivePRs((current) => ({ ...current, [selectedRepository.id]: (current[selectedRepository.id] ?? []).map((pr) => pr.id === selectedPR.id ? { ...pr, status, analysisDiagnostic: result.error?.message } : pr) }));
    }
  };

  const startAnalysis = () => {
    if (!selectedPR || analysis?.running) return;
    if (selectedPR.source === 'github') {
      if (providersLoading || !providers.length) { setSettingsOpen(true); setAnalysisMessage('Detecting installed analysis providers…'); return; }
      if (!selectedProviderStatus?.installed) { setSettingsOpen(true); setAnalysisMessage('Select an installed analysis provider before starting.'); return; }
      setConfirmLiveAnalysis(true); return;
    }
    setView('walkthrough'); setAnalysis({ id: selectedPR.id, stage: 0, running: true, live: false });
  };

  const selectPullRequest = (pr: PullRequest) => {
    setSelectedId(pr.id);
    setView('overview');
    if (pr.source === 'github' && pr.status === 'unprocessed') {
      if (providersLoading || !selectedProviderStatus?.installed) {
        setSettingsOpen(true);
        setAnalysisMessage(providersLoading ? 'Detecting installed analysis providers…' : 'Select an installed analysis provider before starting.');
      } else setConfirmLiveAnalysis(true);
    }
  };

  const cancelAnalysis = async () => {
    if (analysis?.live && analysis.runId && api && selectedPR) { await api.cancelAnalysis(analysis.runId); setAnalysisStatus('cancelled'); setAnalysisMessage('Analysis cancelled.'); setLivePRs((current) => ({ ...current, [selectedRepository.id]: (current[selectedRepository.id] ?? []).map((pr) => pr.id === selectedPR.id ? { ...pr, status: 'cancelled' } : pr) })); }
    setAnalysis(null);
  };

  const refreshLive = () => {
    if (!api) return;
    loadProviders();
    void api.checkForUpdate?.().then((result) => { setUpdateInfo(result); setUpdateDownloadState('idle'); setUpdateDownloadError(''); }).catch(() => undefined);
    if (isLiveRepository) setLivePRs((current) => { const next = { ...current }; delete next[selectedRepository.id]; return next; });
    else { setLiveLoading(true); void api.bootstrap().then((result) => { setLiveRepositories(result.repositories.map(mapRepository)); setLiveError(result.warnings.length ? result.warnings.join(' ') : null); }).catch(() => setLiveError('Could not refresh GitHub discovery.')).finally(() => setLiveLoading(false)); }
  };

  const downloadAvailableUpdate = async () => {
    if (!api?.downloadUpdate || updateDownloadState === 'downloading') return;
    setUpdateDownloadState('downloading'); setUpdateDownloadError('');
    try {
      const result = await api.downloadUpdate();
      if (result.success) setUpdateDownloadState('downloaded');
      else { setUpdateDownloadState('failed'); setUpdateDownloadError(result.error ?? 'Could not download the update.'); }
    } catch { setUpdateDownloadState('failed'); setUpdateDownloadError('Could not download the update.'); }
  };

  const openDownloadedUpdate = async () => {
    if (!api?.openDownloadedUpdate) return;
    try {
      if (!await api.openDownloadedUpdate()) setUpdateDownloadError('Could not open the installer. It remains in Downloads.');
    } catch { setUpdateDownloadError('Could not open the installer. It remains in Downloads.'); }
  };

  const openHistoricalRun = async (runId: string) => {
    if (!api || !selectedPR || selectedPR.source !== 'github' || !selectedPR.repositoryFullName) return;
    const summary = (liveRuns[selectedPR.id] ?? []).find((run) => run.runId === runId && run.status === 'ready');
    if (!summary) return;
    const result = await api.loadAnalysisRun(selectedPR.repositoryFullName, selectedPR.number, runId);
    if (result?.status !== 'ready' || !result.document) { setLiveError('The selected historical walkthrough could not be loaded safely.'); return; }
    setLiveDocuments((current) => ({ ...current, [selectedPR.id]: result.document! }));
    setLivePRs((current) => ({ ...current, [selectedRepository.id]: (current[selectedRepository.id] ?? []).map((pr) => pr.id === selectedPR.id ? { ...mapWalkthroughDocument(result.document!, pr, summary.provider), status: summary.outdated ? 'outdated' : 'ready', analyzedSha: summary.headSha, evidenceHeadSha: summary.headSha, analysisProvenance: summary.provider } : pr) }));
    setView('overview');
  };

  const openSelectedPr = () => { if (selectedPR?.source === 'github' && selectedPR.url && api) void api.openExternal(selectedPR.url); };
  const mapSelectedRepository = async () => {
    if (!api?.mapLocalRepository || selectedRepository.source !== 'github' || !selectedRepository.fullName) return;
    setMappingStatus('Choose the existing local checkout…');
    try { const result = await api.mapLocalRepository(selectedRepository.fullName); setMappingStatus(result ? `Mapped ${result.path}` : 'Mapping cancelled.'); }
    catch (error) { setMappingStatus(error instanceof Error ? error.message : 'Could not map this repository.'); }
  };
  const openEvidence = (path: string, line?: number) => {
    if (!selectedPR || selectedPR.source !== 'github' || !selectedPR.repositoryFullName || !api) return;
    const parsed = path.match(/^(.*?):(\d+)$/);
    const evidencePath = parsed ? parsed[1] : path;
    const evidenceLine = line ?? (parsed ? Number(parsed[2]) : undefined);
    void api.openEvidence?.(selectedPR.repositoryFullName, selectedPR.evidenceHeadSha ?? selectedPR.headSha, evidencePath, evidenceLine);
  };
  useEffect(() => {
    if (!analysis?.running || analysis.live) return;
    const timer = window.setInterval(() => setAnalysis((current) => {
      if (!current) return current;
      if (current.stage >= analysisStages.length - 1) {
        setAnalysisDone((done) => ({ ...done, [current.id]: true }));
        return { ...current, running: false };
      }
      return { ...current, stage: current.stage + 1 };
    }), 900);
    return () => window.clearInterval(timer);
  }, [analysis?.running]);

  const activeAnalysis = analysis?.id === selectedPR?.id ? analysis : null;
  const activeAnalysisProviderName = activeAnalysis?.provider ? (providers.find((status) => status.provider === activeAnalysis.provider)?.displayName ?? providerLabel(activeAnalysis.provider)) : activeProviderName;
  const canStartSelectedAnalysis = selectedPR !== null && ((selectedPR.source === 'github' && selectedPR.status === 'ready') || selectedPR.status === 'unprocessed' || selectedPR.status === 'failed' || selectedPR.status === 'outdated' || selectedPR.status === 'cancelled');
  const markGroup = (group: ChangeGroup) => setReviewed((current) => {
    if (!selectedPR) return current;
    const key = reviewKey(selectedPR.id, group.id);
    return { ...current, [key]: !current[key] };
  });

  return (
    <div className="app-shell" data-theme={resolvedTheme}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true"><img src="./favicon.png" alt="" /></div><span>PR Atlas</span><span className="beta">LOCAL MVP</span></div>
        <div className="topbar-context"><span className={`context-dot ${account.live ? 'live' : 'fixture'}`} /> <span>github.com</span><span className="context-separator">/</span><strong>{selectedRepository?.owner ?? 'runway'}</strong><span className="auth-state" title={account.detail}>{account.label}</span></div>
        <div className="topbar-actions">
          <button className="icon-button" aria-label="Refresh pull requests" title="Refresh pull requests" onClick={refreshLive} disabled={liveLoading}><RefreshCw size={16} className={liveLoading ? 'spin' : ''} /></button>
          <button className="icon-button" aria-label="Open settings" title="Settings" onClick={() => setSettingsOpen((open) => !open)}><Settings size={16} /></button>
          <div className="agent-wrap">
            <button className="agent-button" onClick={() => setShowAgentMenu((open) => !open)} aria-expanded={showAgentMenu}><span className="agent-pulse" /><Bot size={15} /> {activeProviderName} <ChevronDown size={13} /></button>
            {showAgentMenu && <div className="popover agent-popover"><div className="popover-title">Analysis runtime</div>{!electronMode ? <><div className="agent-option"><span className="agent-dot" />Demo analysis <span>Fixture only</span></div><div className="agent-option muted">Browser preview never starts provider processes.</div></> : providersLoading ? <div className="agent-option muted"><span className="agent-dot" />Detecting providers…</div> : providers.length ? providers.map((status) => <div className={`agent-option ${status.installed ? '' : 'muted'}`} key={status.provider}><span className={status.installed ? 'agent-pulse' : 'agent-dot'} />{status.displayName} <span className={status.installed ? 'connected' : ''}>{providerStatusLabel(status)}</span></div>) : <div className="agent-option muted">No installed provider detected.</div>}</div>}
          </div>
          <Avatar initials="RA" />
          {settingsOpen && <div className="popover settings-popover"><div className="popover-title">Workspace settings</div><fieldset className="theme-fieldset"><legend>Theme</legend><div className="theme-options">{themeModes.map(({ value, label }) => <label className="theme-option" key={value}><input type="radio" name="theme-mode" value={value} checked={themeMode === value} onChange={() => chooseTheme(value)} /><span>{label}</span></label>)}</div><p id="theme-description" className="theme-description">System follows your operating-system appearance.</p></fieldset>{electronMode ? <fieldset className="provider-fieldset"><legend>Analysis provider</legend>{providersLoading && <p className="provider-note">Detecting Claude Code, Codex CLI, and Cursor Agent…</p>}{providerError && <p className="provider-note provider-error">{providerError}</p>}{!providersLoading && !providers.length && !providerError && <p className="provider-note">No provider detection result yet.</p>}{providers.map((status) => <label className={`provider-option ${status.installed ? '' : 'unavailable'}`} key={status.provider}><input type="radio" name="analysis-provider" value={status.provider} checked={selectedProvider === status.provider} disabled={!status.installed} onChange={() => chooseProvider(status.provider)} /><span className="provider-option-main"><strong>{status.displayName}</strong><small>{status.executable}</small></span><span className="provider-option-status">{providerStatusLabel(status)}</span></label>)}</fieldset> : <p className="provider-note">Browser demo runtime only; installed provider detection is available in Electron.</p>}{electronMode && selectedProviderStatus?.installed && <label className="model-setting"><span>Model for {selectedProviderStatus.displayName}</span>{selectedProviderStatus.models?.length ? <select aria-label={`Model for ${selectedProviderStatus.displayName}`} value={selectedModels[selectedProvider] ?? ''} onChange={(event) => setSelectedModels((current) => ({ ...current, [selectedProvider]: event.target.value }))}>{selectedProviderStatus.models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select> : <small>The installed tool did not report selectable models; its configured default will be used.</small>}</label>}<label className="prompt-setting"><span>Supplemental collection guidance</span><textarea aria-label="Supplemental collection guidance" value={customPrompt} maxLength={4000} rows={3} placeholder="Example: collect more migration, rollback, or test evidence" onChange={(event) => setCustomPrompt(event.target.value)} /><small>This may guide additional evidence collection, but cannot change the required walkthrough structure.</small></label><div className="settings-row"><span>Data source</span><strong>{electronMode && account.live ? 'GitHub CLI + local artifacts' : 'Demo fixture (browser)'}</strong></div><div className="settings-row"><span>Provider</span><strong>{activeProviderName}</strong></div><div className="settings-row"><span>Unprocessed PRs</span><strong>Ask to analyze on selection</strong></div><div className="settings-note">Repository context stays local except when an analysis run sends it to {activeProviderName}’s configured model service.</div></div>}
        </div>
      </header>

      {confirmLiveAnalysis && <div className="modal-backdrop"><section className="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="confirm-analysis-title"><div className="eyebrow">{activeProviderName} analysis</div><h3 id="confirm-analysis-title">Send repository context to {activeProviderName}?</h3><p>PR Atlas will collect the selected pull request and local repository context and send it to {activeProviderName}’s configured model service. The validated walkthrough stays in local artifacts.</p>{selectedModels[selectedProvider] && <p className="confirm-detail">Model: <code>{selectedModels[selectedProvider]}</code></p>}{customPrompt.trim() && <p className="confirm-detail">Supplemental focus: {customPrompt.trim()}</p>}<div className="confirm-actions"><button className="secondary-button" onClick={() => setConfirmLiveAnalysis(false)}>Cancel</button><button className="primary-button" onClick={() => void runLiveAnalysis()}>Continue</button></div></section></div>}

      <div className="workspace">
        <aside className="sidebar">
          <div className="repo-picker">
            <div className="eyebrow">Repository</div>
            <div className="search-box repo-search"><Search size={14} /><input type="search" aria-label="Search repositories" value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} placeholder="Search repositories" /></div>
            <label className="select-wrap"><span className="repo-icon">{selectedRepository?.name.slice(0, 1).toUpperCase()}</span><select aria-label="Select repository" value={selectedRepo} onChange={(event) => setSelectedRepo(event.target.value)}><optgroup label="Demo workspace">{visibleRepositories.filter((repo) => repo.source === 'fixture').map((repo) => <option value={repo.id} key={repo.id}>{repo.owner}/{repo.name}</option>)}</optgroup>{visibleRepositories.some((repo) => repo.source === 'github') && <optgroup label="GitHub · live">{visibleRepositories.filter((repo) => repo.source === 'github').map((repo) => <option value={repo.id} key={repo.id}>{repo.fullName}</option>)}</optgroup>}</select><ChevronDown size={14} /></label>
            <div className="repo-meta"><span>{selectedRepository?.source === 'github' ? 'Live GitHub repository' : selectedRepository?.private ? 'Private demo repository' : 'Public demo repository'}</span><span>{selectedRepository?.openPRs || (isLiveRepository ? (livePRs[selectedRepository.id]?.length ?? '—') : 0)} open</span></div>
            {isLiveRepository && api?.mapLocalRepository && <button className="secondary-button map-repository" onClick={() => void mapSelectedRepository()}><Files size={13} /> Map existing checkout</button>}
            {mappingStatus && <p className="mapping-status" role="status">{mappingStatus}</p>}
          </div>
          <div className="sidebar-section filter-section">
            <div className="section-heading"><span>Pull requests</span><span className="count-badge">{repoPRs.length}</span></div>
            <div className="search-box"><Search size={14} /><input aria-label="Search pull requests" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search PRs" /><kbd>/</kbd></div>
            <div className="filter-list" role="tablist" aria-label="Pull request filters">
              {(['all', 'mine', 'review', 'reviewed', 'ready', 'processing', 'unprocessed', 'outdated', 'failed'] as Filter[]).map((value) => {
                const label = value === 'all' ? 'All pull requests' : value === 'mine' ? 'Authored by me' : value === 'review' ? 'Review requested' : value === 'reviewed' ? 'Reviewed by me' : statusMeta[value as PRStatus].label;
                const count = value === 'all' ? repoPRs.length : value === 'mine' || value === 'review' || value === 'reviewed' ? repoPRs.filter((pr) => matchesRelationshipFilter(pr, value)).length : repoPRs.filter((pr) => pr.status === value).length;
                return <button key={value} role="tab" aria-label={label} aria-selected={filter === value} className={`filter-item ${filter === value ? 'active' : ''}`} onClick={() => setFilter(value)}><span>{label}</span><span className="filter-count">{count}</span></button>;
              })}
            </div>
          </div>
          <div className="sidebar-footer">{updateInfo?.available && updateInfo.releaseUrl && <div className="update-notice" role="status" aria-label={`New version available ${updateInfo.latestVersion}`}><div className="update-summary"><ArrowUp size={14} /><span><strong>New version available</strong><b>v{updateInfo.latestVersion}</b><small>Current version {updateInfo.currentVersion}</small></span></div><div className="update-actions">{updateInfo.downloadUrl && updateInfo.artifactName && api?.downloadUpdate && (updateDownloadState === 'downloaded' ? <button aria-label={`Open downloaded update ${updateInfo.latestVersion}`} onClick={() => void openDownloadedUpdate()}><ExternalLink size={11} />Open installer</button> : <button aria-label={`${updateDownloadState === 'failed' ? 'Retry' : 'Download'} update ${updateInfo.latestVersion}`} disabled={updateDownloadState === 'downloading'} onClick={() => void downloadAvailableUpdate()}><ArrowDown size={11} />{updateDownloadState === 'downloading' ? 'Downloading…' : updateDownloadState === 'failed' ? 'Retry' : 'Download'}</button>)}<button className="update-release-link" aria-label={`View release ${updateInfo.latestVersion}`} onClick={() => void api?.openExternal(updateInfo.releaseUrl!)}>View release</button></div>{updateDownloadState === 'downloaded' && !updateDownloadError && <small className="update-message">Saved to Downloads.</small>}{updateDownloadError && <small className="update-message error">{updateDownloadError}</small>}</div>}<div className="footer-line"><ShieldCheck size={14} /> <span>Read-only GitHub access</span></div><div className="footer-line muted"><Clock3 size={14} /> <span>Synced just now</span></div><button className="help-button"><CircleHelp size={14} /> Keyboard shortcuts</button></div>
        </aside>

        <section className="pr-list-pane" aria-label="Pull request list">
          <div className="pane-header"><div><div className="eyebrow">{selectedRepository?.owner}/{selectedRepository?.name}</div><h1>Pull requests</h1></div><button className="icon-button" aria-label="More pull request list actions"><MoreHorizontal size={16} /></button></div>
          <div className="pr-list" role="list" aria-label="Pull request list">{liveLoading && isLiveRepository && visiblePRs.length === 0 && <div className="empty-state"><Loader2 size={20} className="spin" /><p>Loading GitHub pull requests…</p></div>}{visiblePRs.map((pr) => <button aria-label={`#${pr.number} ${pr.title}`} className={`pr-row ${selectedPR?.id === pr.id ? 'selected' : ''}`} key={pr.id} onClick={() => selectPullRequest(pr)} role="listitem"><div className="pr-row-top"><span className="pr-number">#{pr.number}</span><StatusPill status={pr.status} /></div><div className="pr-title">{pr.title}</div><div className="pr-row-meta"><Avatar initials={pr.initials} className="small" /><span>{pr.author}</span><span className="meta-divider">·</span><span>{pr.updated}</span></div><div className="pr-row-bottom"><span className="branch"><GitPullRequest size={12} /> {pr.branch}</span><span>{pr.files} files</span></div></button>)}{!liveLoading && liveError && isLiveRepository && visiblePRs.length === 0 && <div className="empty-state error-state"><AlertCircle size={20} /><p>{liveError}</p><button onClick={refreshLive}>Retry</button></div>}{!liveLoading && !liveError && visiblePRs.length === 0 && (repoPRs.length === 0 ? <div className="empty-state"><GitPullRequest size={20} /><p>No open pull requests.</p><button onClick={refreshLive}>Refresh</button></div> : <div className="empty-state"><Search size={20} /><p>No pull requests match these filters.</p><button onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></div>)}</div>
          <div className="list-footer"><span><span className="live-dot" /> {isLiveRepository ? 'Read-only GitHub data' : 'Read-only demo fixture'}</span><span>{isLiveRepository ? 'Synced from GitHub' : 'Updated 2m ago'}</span></div>
        </section>

        <main className="content-pane">
          {selectedPR ? <>
            <div className="pr-header"><div className="breadcrumb"><span>{selectedPR.repositoryFullName ?? selectedPR.repositoryId}</span><span>/</span><span>pull request</span><span>/</span><strong>#{selectedPR.number}</strong><span className="source-label">{selectedPR.source === 'github' ? 'GitHub' : 'Demo PR'}</span></div>{selectedPR.status === 'outdated' && <div className="stale-banner"><AlertCircle size={14} /><strong>This walkthrough is outdated.</strong><span>Analyzed SHA <code>{shortSha(selectedPR.analyzedSha ?? 'unknown')}</code> · current SHA <code>{shortSha(selectedPR.headSha)}</code></span><button onClick={startAnalysis}>Update walkthrough</button><span className="stale-note">New commits may change the evidence below.</span></div>}<div className="pr-heading-row"><div><div className="title-line"><h2>{selectedPR.title}</h2><StatusPill status={selectedPR.status} /></div><div className="pr-subtitle"><Avatar initials={selectedPR.initials} className="small" /><span>{selectedPR.author}</span><span>wants to merge</span><code>{selectedPR.branch}</code><span>into</span><code>{selectedPR.base}</code></div></div><div className="heading-actions"><button className="secondary-button" aria-label="Open pull request on GitHub" onClick={openSelectedPr} disabled={selectedPR.source !== 'github'}><ExternalLink size={14} /> {selectedPR.source === 'github' ? 'View on GitHub' : 'Demo PR · GitHub link disabled'}</button>{canStartSelectedAnalysis && <button className="primary-button" onClick={startAnalysis} disabled={activeAnalysis?.running}><Play size={14} /> {activeAnalysis?.running ? 'Analyzing…' : selectedPR.status === 'failed' ? 'Retry analysis' : selectedPR.status === 'ready' ? 'Analyze again' : 'Analyze locally'}</button>}</div></div><div className="pr-stats"><span><ArrowUp size={13} className="additions" /> {selectedPR.additions} additions</span><span><ArrowDown size={13} className="deletions" /> {selectedPR.deletions} deletions</span><span><Files size={13} /> {selectedPR.files} files</span><span><GitPullRequest size={13} /> {selectedPR.changedAreas.join(' · ')}</span><span className="stats-spacer" /><span>Updated {selectedPR.updated}</span></div></div>
            <nav className="view-nav" aria-label="Pull request sections">{viewItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={14} /> {label}{id === 'insights' && selectedPR.insights.length > 0 && <span className="nav-count">{selectedPR.insights.length}</span>}</button>)}</nav>
            <div className="content-scroll"><ViewContent view={view} pr={selectedPR} flowType={flowType} setFlowType={setFlowType} activeAnalysis={activeAnalysis} providerName={activeAnalysisProviderName} analysisMessage={analysisMessage} startAnalysis={startAnalysis} markGroup={markGroup} reviewed={reviewed} cancelAnalysis={() => void cancelAnalysis()} reopenWalkthrough={() => setView('walkthrough')} openHistoricalRun={(runId) => void openHistoricalRun(runId)} openEvidence={openEvidence} />
            </div>
          </> : <section className="empty-detail" aria-labelledby="empty-detail-title"><div className="empty-detail-content"><div className="empty-detail-mark" aria-hidden="true"><img src="./favicon.png" alt="" /></div><div className="eyebrow">Repository ready</div><h2 id="empty-detail-title">{liveLoading ? 'Loading pull requests' : liveError ? 'Pull requests are unavailable' : 'No open pull requests'}</h2><p>{liveLoading ? <>Checking GitHub for open work in <strong>{selectedRepository.fullName ?? `${selectedRepository.owner}/${selectedRepository.name}`}</strong>…</> : liveError ? 'Refresh the repository to try the read-only GitHub request again.' : <><strong>{selectedRepository.fullName ?? `${selectedRepository.owner}/${selectedRepository.name}`}</strong> is all clear. New pull requests will appear here with their walkthrough status and review evidence.</>}</p>{!liveLoading && <div className="empty-detail-actions"><button className="primary-button" onClick={refreshLive}><RefreshCw size={14} /> Refresh pull requests</button></div>}<div className="empty-detail-meta"><ShieldCheck size={14} /><span>Read-only GitHub data</span><span aria-hidden="true">·</span><span>Local analysis artifacts</span></div></div></section>}
        </main>
      </div>
    </div>
  );
}

function ViewContent({ view, pr, flowType, setFlowType, activeAnalysis, providerName, analysisMessage, startAnalysis, markGroup, reviewed, cancelAnalysis, reopenWalkthrough, openHistoricalRun, openEvidence }: { view: View; pr: PullRequest; flowType: Flow['type']; setFlowType: (type: Flow['type']) => void; activeAnalysis: { id: string; stage: number; running: boolean; live?: boolean; provider?: AgentProvider } | null; providerName: string; analysisMessage?: string; startAnalysis: () => void; markGroup: (group: ChangeGroup) => void; reviewed: Record<string, boolean>; cancelAnalysis: () => void; reopenWalkthrough: () => void; openHistoricalRun: (runId: string) => void; openEvidence: (path: string, line?: number) => void; }) {
  if (activeAnalysis?.running && (view === 'walkthrough' || pr.status === 'unprocessed')) return <AnalysisProgress analysis={activeAnalysis} providerName={providerName} message={analysisMessage} onCancel={cancelAnalysis} />;
  if (view === 'overview') return <Overview pr={pr} onStart={startAnalysis} />;
  if (view === 'walkthrough') return <Walkthrough pr={pr} markGroup={markGroup} reviewed={reviewed} openEvidence={openEvidence} />;
  if (view === 'groups') return <GroupsView pr={pr} markGroup={markGroup} reviewed={reviewed} />;
  if (view === 'insights') return <InsightsView insights={pr.insights} openEvidence={openEvidence} />;
  if (view === 'flows') return <FlowsView flows={pr.flows} flowType={flowType} setFlowType={setFlowType} evidence={pr.evidence} groups={pr.groups} threads={pr.threads} openEvidence={openEvidence} />;
  if (view === 'files') return <FilesView pr={pr} openEvidence={openEvidence} />;
  if (view === 'tests') return <TestsView pr={pr} openEvidence={openEvidence} />;
  if (view === 'threads') return <RichThreadsView pr={pr} openEvidence={openEvidence} />;
  return <DetailsView pr={pr} providerName={providerName} onReopen={reopenWalkthrough} onOpenRun={openHistoricalRun} openEvidence={openEvidence} />;
}

function Overview({ pr, onStart }: { pr: PullRequest; onStart: () => void }) {
  const provider = pr.analysisProvenance && pr.analysisProvenance !== 'demo' ? providerLabel(pr.analysisProvenance) : null;
  return <div className="overview view-section"><div className="overview-intro"><div><div className="eyebrow">{pr.source === 'github' ? (provider ? `Validated ${provider} walkthrough` : 'Live pull request') : 'Demo analysis'}</div><h3>Understand the changed system.</h3><p>{pr.summary}</p></div>{pr.status !== 'ready' && <button className="primary-button" onClick={onStart}><Sparkles size={14} /> {pr.status === 'processing' ? 'View analysis' : 'Start local analysis'}</button>}</div><div className="summary-grid"><Metric icon={GitPullRequestArrow} label="Logical changes" value={String(pr.groups.length)} hint="grouped from the diff" /><Metric icon={AlertCircle} label="Review insights" value={String(pr.insights.length)} hint="clustered by concern" /><Metric icon={Workflow} label="Behavior flows" value={String(pr.flows.length)} hint="system and user paths" /><Metric icon={TestTube2} label="Tests mapped" value={pr.tests.length ? `${pr.tests.filter((test) => test.status === 'covered').length}/${pr.tests.length}` : '—'} hint="to changed behavior" /></div><div className="overview-columns"><section><SectionTitle label="What changed" action="Open walkthrough" onAction={() => document.querySelector<HTMLButtonElement>('[aria-label="Pull request sections"] button:nth-child(2)')?.click()} /><div className="change-list">{pr.groups.slice(0, 3).map((group, index) => <div className="change-row" key={group.id}><span className="change-index">0{index + 1}</span><div><strong>{group.title}</strong><p>{group.description}</p></div><AttentionTag level={group.attention} /></div>)}</div></section><section><SectionTitle label="Review pulse" action="See all insights" /><div className="pulse-list">{pr.insights.slice(0, 3).map((insight) => <InsightRow insight={insight} key={insight.id} />)}</div></section></div><EvidenceStrip pr={pr} /></div>;
}

function AnalysisProgress({ analysis, providerName, onCancel, message }: { analysis: { stage: number; running: boolean; live?: boolean }; providerName: string; onCancel: () => void; message?: string }) {
  const live = Boolean(analysis.live);
  return <div className="analysis-screen"><div className="analysis-kicker"><span className="live-dot" /> {live ? `${providerName} · live analysis` : 'Demo analysis · deterministic fixture'}</div><h3>Building your walkthrough</h3><p className="analysis-lede">{live ? `${providerName} is processing repository context. Progress is streamed from the local Electron service; no result is installed until validation succeeds.` : 'This demo analysis is a deterministic local fixture and is not an analysis of a real pull request.'}</p>{message && <div className="analysis-message" role="status">{message}</div>}<div className="stage-list">{analysisStages.map((stage: AnalysisStage, index) => <div className={`analysis-stage ${index < analysis.stage ? 'complete' : index === analysis.stage ? 'current' : ''}`} key={stage.label}><div className="stage-icon">{index < analysis.stage ? <Check size={14} /> : index === analysis.stage ? <Loader2 size={14} className="spin" /> : <span>{index + 1}</span>}</div><div><strong>{stage.label}</strong><span>{stage.detail}</span></div>{index < analysis.stage && <span className="stage-done">Done</span>}</div>)}</div><div className="analysis-footer"><span>Stage {Math.min(analysis.stage + 1, analysisStages.length)} of {analysisStages.length}</span><div className="progress-track"><span style={{ width: `${((analysis.stage + (analysis.running ? 0.35 : 1)) / analysisStages.length) * 100}%` }} /></div><button className="secondary-button" onClick={onCancel}><Square size={13} /> Cancel</button></div></div>;
}

function Walkthrough({ pr, markGroup, reviewed, openEvidence }: { pr: PullRequest; markGroup: (group: ChangeGroup) => void; reviewed: Record<string, boolean>; openEvidence: (path: string, line?: number) => void }) {
  const [active, setActive] = useState(0);
  const group = pr.groups[active] ?? pr.groups[0];
  if (!group) return <EmptyAnalysis />;
  const isReviewed = (item: ChangeGroup) => Boolean(reviewed[reviewKey(pr.id, item.id)]);
  return <div className="walkthrough view-section"><div className="walkthrough-head"><div><div className="eyebrow">Guided review · {active + 1} of {pr.groups.length}</div><h3>{group.title}</h3><p>{group.description}</p></div><div className="walkthrough-actions"><button className="secondary-button"><CircleHelp size={14} /> Why this order?</button><button className={`review-button ${isReviewed(group) ? 'checked' : ''}`} onClick={() => markGroup(group)}>{isReviewed(group) ? <Check size={14} /> : <span className="empty-check" />} {isReviewed(group) ? 'Reviewed' : 'Mark reviewed'}</button></div></div><div className="walkthrough-layout"><div className="step-rail">{pr.groups.map((item, index) => <button key={item.id} className={`step-item ${index === active ? 'active' : ''} ${isReviewed(item) ? 'done' : ''}`} onClick={() => setActive(index)}><span className="step-number">{isReviewed(item) ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{item.files.length} files · {item.attention} attention</small></span></button>)}</div><div className="walkthrough-body"><div className="behavior-compare"><div className="compare-col before"><div className="compare-label">Before</div><p>{group.before}</p></div><div className="compare-arrow"><ArrowDown size={14} /></div><div className="compare-col after"><div className="compare-label">New behavior</div><p>{group.after}</p></div></div><div className="reason-callout"><Sparkles size={15} /><div><strong>Why this matters</strong><p>{group.rationale}</p></div></div><section className="evidence-section"><SectionTitle label="Evidence in this change" /><div className="evidence-list">{group.files.map((file) => <button key={file} className="evidence-row" onClick={() => openEvidence(file)}><FileCode2 size={14} /><code>{file}</code><ExternalLink size={13} /></button>)}</div></section><div className="pager"><button className="secondary-button" disabled={active === 0} onClick={() => setActive((index) => Math.max(0, index - 1))}>← Previous</button><button className="primary-button" disabled={active === pr.groups.length - 1} onClick={() => setActive((index) => Math.min(pr.groups.length - 1, index + 1))}>Next change <ArrowUp size={14} /></button></div></div></div></div>;
}

function GroupsView({ pr, markGroup, reviewed }: { pr: PullRequest; markGroup: (group: ChangeGroup) => void; reviewed: Record<string, boolean> }) { const isReviewed = (group: ChangeGroup) => Boolean(reviewed[reviewKey(pr.id, group.id)]); return <div className="view-section"><SectionIntro eyebrow="Structure" title="Logical change groups" description="Files are implementation containers. Review these behavior units first." /><div className="group-table">{pr.groups.map((group, index) => <div className="group-row" key={group.id}><div className="group-order">{String(index + 1).padStart(2, '0')}</div><div className="group-main"><div className="group-title-line"><h4>{group.title}</h4><AttentionTag level={group.attention} /></div><p>{group.description}</p><div className="file-chips">{group.files.map((file) => <span key={file}><FileCode2 size={12} />{file.split('/').pop()}</span>)}</div></div><button className={`review-button compact ${isReviewed(group) ? 'checked' : ''}`} onClick={() => markGroup(group)}>{isReviewed(group) ? <Check size={14} /> : <span className="empty-check" />}{isReviewed(group) ? 'Reviewed' : 'Mark reviewed'}</button></div>)}</div></div>; }

function InsightsView({ insights, openEvidence }: { insights: ReviewInsight[]; openEvidence: (path: string, line?: number) => void }) { return <div className="view-section"><SectionIntro eyebrow="Signal, with provenance" title="Review insights" description="Clusters preserve who raised a concern and whether it is still actionable." /><div className="insights-list">{insights.map((insight) => <div className="insight-card" key={insight.id}><div className="insight-card-top"><div className="insight-icon"><AlertCircle size={16} /></div><div className="insight-head"><h4>{insight.title}</h4><div className="insight-meta"><span className={`provenance ${insight.provenance}`}>{insight.provenance === 'human' ? <UserRound size={12} /> : <Bot size={12} />}{insight.provenance === 'human' ? 'Human signal' : 'Automated signal'}</span><StateTag state={insight.state} /><span>{insight.count} mentions</span></div></div></div><p>{insight.detail}</p><button className="location-link" onClick={() => openEvidence(insight.location)}><FileCode2 size={13} /> {insight.location} <ExternalLink size={12} /></button></div>)}</div></div>; }

function FlowsView({ flows, flowType, setFlowType, evidence, groups, threads, openEvidence }: { flows: Flow[]; flowType: Flow['type']; setFlowType: (type: Flow['type']) => void; evidence: Evidence[]; groups: ChangeGroup[]; threads: ReviewThread[]; openEvidence: (path: string, line?: number) => void }) {
  const flow = flows.find((item) => item.type === flowType) ?? flows[0];
  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState<'all' | 'changed' | 'context'>('all');
  const [highlightedGroup, setHighlightedGroup] = useState('');
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState(0);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  useEffect(() => { setTourStep(0); setSelectedNode(null); setSearch(''); setNodeFilter('all'); setHighlightedGroup(''); setZoom(100); setPan({ x: 0, y: 0 }); }, [flow?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key >= '1' && event.key <= '4') setFlowType((['system-overview', 'data-flow', 'code-dependency', 'user-action'] as Flow['type'][])[Number(event.key) - 1]);
      if (event.key === 'n' || event.key === 'ArrowRight') setTourStep((step) => Math.min((flow?.guidedTours[0]?.steps.length ?? 1) - 1, step + 1));
      if (event.key === 'p' || event.key === 'ArrowLeft') setTourStep((step) => Math.max(0, step - 1));
      if (event.key === '+') setZoom((value) => Math.min(160, value + 10));
      if (event.key === '-') setZoom((value) => Math.max(MIN_GRAPH_ZOOM, value - 10));
      if (event.key === '0') { setZoom(100); setPan({ x: 0, y: 0 }); }
      if (event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('[aria-label="Search flow nodes"]')?.focus(); }
      if (event.key === 'Escape') setSelectedNode(null);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [flow?.guidedTours, setFlowType]);
  if (!flow) return <EmptyAnalysis />;
  const filteredNodes = flow.nodes.filter((node) => {
    const matchesKind = nodeFilter === 'all' || (nodeFilter === 'changed' ? node.changed : !node.changed);
    return matchesKind && `${node.label} ${node.explanation} ${node.evidenceIds.join(' ')}`.toLowerCase().includes(search.toLowerCase());
  });
  const visibleIds = new Set(filteredNodes.map((node) => node.id));
  const selected = filteredNodes.find((node) => node.id === selectedNode) ?? filteredNodes[0];
  const tour = flow.guidedTours[0];
  const tourNodeId = tour?.steps[tourStep]?.nodeId;
  const tabLabels: Record<Flow['type'], string> = { 'system-overview': 'System overview', 'data-flow': 'Data flow', 'code-dependency': 'Code dependency', 'user-action': 'User action' };
  const overview = flow.type === 'system-overview';
  const nodePosition = (index: number) => overview ? { x: 60 + (index % 2) * 280, y: 55 + Math.floor(index / 2) * 145 } : { x: 90 + (index % 3) * 190, y: 70 + Math.floor(index / 3) * 110 };
  const nodeWidth = overview ? 220 : 132;
  const nodeHeight = overview ? 92 : 44;
  const rows = Math.max(1, Math.ceil(flow.nodes.length / (overview ? 2 : 3)));
  const surfaceWidth = overview ? 620 : 700;
  const surfaceHeight = Math.max(360, 100 + rows * (overview ? 145 : 110));
  const fitToView = () => { setZoom(calculateFitZoom(surfaceWidth, surfaceHeight)); setPan({ x: 0, y: 0 }); };
  const resetView = () => { setZoom(100); setPan({ x: 0, y: 0 }); };
  const referencedEvidence = (selected?.evidenceIds ?? []).flatMap((id) => { const item = evidence.find((candidate) => candidate.id === id); return item ? [item] : []; });
  const associatedThreads = (selected?.reviewThreadIds ?? []).flatMap((id) => { const thread = threads.find((candidate) => candidate.id === id); return thread ? [thread] : []; });
  const graphGroups = groups.filter((group) => flow.nodes.some((node) => node.changeGroupIds.includes(group.id)));
  return <div className="view-section">
    <SectionIntro eyebrow="Trace the system" title="Behavior flows" description="Four directed views keep subsystem context, data, code, and user actions distinct." />
    <div className="flow-tabs" role="tablist">{(['system-overview', 'data-flow', 'code-dependency', 'user-action'] as Flow['type'][]).map((type) => <button key={type} role="tab" aria-label={tabLabels[type]} aria-selected={flowType === type} className={flowType === type ? 'active' : ''} onClick={() => setFlowType(type)}>{tabLabels[type]}</button>)}</div>
    <div className="flow-toolbar"><div className="search-box"><Search size={14} /><input aria-label="Search flow nodes" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search flow nodes" /><kbd>/</kbd></div><div className="node-filter" aria-label="Graph node filter">{(['all', 'changed', 'context'] as const).map((kind) => <button key={kind} className={`secondary-button ${nodeFilter === kind ? 'active' : ''}`} aria-label={kind === 'all' ? 'All nodes' : kind === 'changed' ? 'Changed nodes' : 'Context nodes'} onClick={() => setNodeFilter(kind)}>{kind === 'all' ? 'All' : kind === 'changed' ? 'Changed' : 'Context'}</button>)}</div><label className="group-highlight">Group<select aria-label="Highlight change group" value={highlightedGroup} onChange={(event) => setHighlightedGroup(event.target.value)}><option value="">None</option>{graphGroups.map((group) => <option value={group.id} key={group.id}>{group.title}</option>)}</select></label><button className="secondary-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(MIN_GRAPH_ZOOM, value - 10))}>−</button><button className="secondary-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(160, value + 10))}>+</button><button className="secondary-button" onClick={fitToView}>Fit to view</button><button className="secondary-button" onClick={resetView}>Reset zoom</button><span className="zoom-status" role="status" aria-label="Zoom level">{zoom}%</span></div>
    <div className="flow-layout"><div className="flow-canvas" role="region" aria-label={`${tabLabels[flow.type]} graph`} onPointerDown={(event) => { if (event.target instanceof Element && event.target.closest('button,input,select')) return; drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { if (drag.current) setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }}>
      <div className="flow-grid" /><div className="flow-graph-surface" data-pan-x={pan.x} data-pan-y={pan.y} style={{ width: surfaceWidth, height: surfaceHeight, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transformOrigin: 'top left' }}>
        {!overview && <svg className="flow-edges" aria-hidden="true" style={{ width: surfaceWidth, height: surfaceHeight }} viewBox={`0 0 ${surfaceWidth} ${surfaceHeight}`} preserveAspectRatio="none"><defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#75a9a1" /></marker></defs>{flow.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => { const from = nodePosition(flow.nodes.findIndex((node) => node.id === edge.source)); const to = nodePosition(flow.nodes.findIndex((node) => node.id === edge.target)); return <g key={edge.id}><line x1={from.x + nodeWidth / 2} y1={from.y + nodeHeight / 2} x2={to.x + nodeWidth / 2} y2={to.y + nodeHeight / 2} markerEnd="url(#flow-arrow)" /><text x={(from.x + to.x + nodeWidth) / 2} y={(from.y + to.y + nodeHeight) / 2 - 7}>{edge.label}</text></g>; })}</svg>}
        {filteredNodes.map((node) => { const index = flow.nodes.findIndex((candidate) => candidate.id === node.id); const position = nodePosition(index); const groupMatch = !highlightedGroup || node.changeGroupIds.includes(highlightedGroup); return <button key={node.id} data-change-group-highlight={highlightedGroup && groupMatch ? 'true' : undefined} className={`flow-node ${overview ? 'overview-card' : ''} ${node.changed ? 'changed-node' : 'context-node'} ${highlightedGroup && !groupMatch ? 'group-muted' : ''} ${selected?.id === node.id || tourNodeId === node.id ? 'focused' : ''}`} style={{ left: position.x, top: position.y, width: nodeWidth, minHeight: nodeHeight }} onClick={() => setSelectedNode(node.id)} aria-label={`${node.label}: ${node.explanation}`}><span className="flow-node-index">{String(index + 1).padStart(2, '0')}</span>{overview ? <strong>{node.label}</strong> : node.label}{overview && <small>{node.explanation}</small>}</button>; })}
      </div><div className="flow-tour"><span>Step {Math.min(tourStep + 1, tour?.steps.length ?? 1)} / {tour?.steps.length ?? 1}</span><button className="secondary-button" aria-label="Previous tour" disabled={tourStep === 0} onClick={() => setTourStep((step) => Math.max(0, step - 1))}>Previous</button><button className="secondary-button" aria-label="Next tour" disabled={tourStep >= (tour?.steps.length ?? 1) - 1} onClick={() => setTourStep((step) => Math.min((tour?.steps.length ?? 1) - 1, step + 1))}>Next</button><button className="secondary-button" aria-label="Restart tour" onClick={() => setTourStep(0)}>Restart</button></div>
    </div><div className="flow-sidebar"><div className="eyebrow">{flow.type}</div><h4>{flow.title}</h4><p>{flow.description}</p>{selected && <div className="node-detail"><div className="eyebrow">Selected node</div><strong>Selected: {selected.label}</strong><p>{selected.explanation}</p>{referencedEvidence.length ? <div className="node-evidence">{referencedEvidence.map((item) => <button key={item.id} onClick={() => openEvidence(item.path, item.line)}><FileCode2 size={12} />{item.path}{item.line ? `:${item.line}` : ''}</button>)}</div> : <span className="muted">No evidence attached</span>}{associatedThreads.length > 0 && <div className="node-comments"><strong>Associated review comments</strong>{associatedThreads.map((thread) => <button key={thread.id} onClick={() => openEvidence(thread.file, thread.line || undefined)}><MessageSquare size={12} /><span><b>{thread.author}</b>{thread.body}</span></button>)}</div>}</div>}<div className="flow-legend"><span><i className="legend-dot changed" /> Changed boundary</span><span><i className="legend-dot context" /> Unchanged context</span></div><div className="flow-list-alt"><strong>Accessible list view</strong>{filteredNodes.map((node) => <button key={node.id} onClick={() => setSelectedNode(node.id)}><span>Node {node.label}</span><small>{node.explanation}</small></button>)}</div></div></div>
  </div>;
}

function FilesView({ pr, openEvidence }: { pr: PullRequest; openEvidence: (path: string, line?: number) => void }) { const files = [...new Set(pr.groups.flatMap((group) => group.files))]; return <div className="view-section"><SectionIntro eyebrow="Evidence surface" title="Changed files" description="The file list stays available, but it is organized under the behaviors above." /><div className="file-table"><div className="file-table-head"><span>Path</span><span>Group</span><span>Evidence</span></div>{files.map((file) => { const group = pr.groups.find((candidate) => candidate.files.includes(file)); const item = pr.evidence.find((candidate) => candidate.path === file); return <button className="file-table-row" key={file} onClick={() => openEvidence(file, item?.line)}><span className="file-path"><FileCode2 size={14} /><code>{file}</code></span><span>{group?.title ?? 'Context'}</span><span className="evidence-kind">{item?.kind ?? 'file'}</span></button>; })}</div></div>; }

function TestsView({ pr, openEvidence }: { pr: PullRequest; openEvidence: (path: string, line?: number) => void }) { return <div className="view-section"><SectionIntro eyebrow="Behavior coverage" title="Tests mapped to behavior" description="Generated interpretation is kept next to deterministic test paths." /><div className="test-list">{pr.tests.map((test) => <div className="test-row" key={test.id}><div className={`test-status ${test.status}`}><span>{test.status === 'covered' ? 'Covered' : test.status === 'partial' ? 'Partial' : 'Missing'}</span></div><div className="test-main"><strong>{test.test}</strong><p>{test.behavior}</p></div><button className="test-evidence" onClick={() => openEvidence(test.evidence)}><code>{test.evidence}</code><ExternalLink size={12} /></button></div>)}{pr.tests.length === 0 && <EmptyAnalysis />}</div></div>; }

function DetailsView({ pr, providerName, onReopen, onOpenRun, openEvidence }: { pr: PullRequest; providerName: string; onReopen: () => void; onOpenRun: (runId: string) => void; openEvidence: (path: string, line?: number) => void }) {
  const live = pr.source === 'github';
  const loadedProvider = pr.analysisProvenance && pr.analysisProvenance !== 'demo' ? providerLabel(pr.analysisProvenance) : providerName;
  const loadedModel = safeString(pr.walkthrough?.run?.model, pr.history.find((run) => run.status === 'completed')?.model ?? 'Tool default');
  return <div className="view-section"><SectionIntro eyebrow="Reproducibility" title="Analysis details" description={live ? `A transparent record of the validated ${loadedProvider} artifact and persisted run history.` : 'A transparent record of the deterministic local demo fixture.'} /><div className="details-grid"><div className="detail-panel"><SectionTitle label="Runtime" /><dl><dt>Mode</dt><dd>{live ? 'Electron + local artifact' : 'Deterministic local fixture'}</dd><dt>Provider</dt><dd>{live ? loadedProvider : 'Demo analysis'}</dd><dt>Model</dt><dd>{live ? loadedModel : 'Fixture model'}</dd><dt>Schema</dt><dd>{pr.walkthrough?.schemaVersion ?? pr.history.find((run) => run.schemaVersion)?.schemaVersion ?? (live ? 'walkthrough/1.0.0' : 'walkthrough/v1')}</dd><dt>Repository state</dt><dd><span className="status-inline ready" /> {live ? 'Validated revision' : 'Fixture snapshot'}</dd></dl></div><div className="detail-panel"><SectionTitle label="Evidence paths" /><div className="evidence-list">{pr.evidence.map((item) => <button className="evidence-row" key={item.id} onClick={() => openEvidence(item.path, item.line)}><FileCode2 size={14} /><code>{item.path}{item.line ? `:${item.line}` : ''}</code><span className="evidence-kind">{item.kind}</span></button>)}</div></div></div><div className="run-history"><SectionTitle label="Run history" action={pr.groups.length ? 'Reopen walkthrough' : undefined} onAction={pr.groups.length ? onReopen : undefined} /><div className="history-table"><div className="history-head"><span>Date</span><span>Duration</span><span>Provider</span><span>Model</span><span>Status</span></div>{pr.history.map((run) => {
    const provider = run.provider ? providerLabel(run.provider) : 'Demo runtime';
    const content = <><span><History size={13} />{run.date}</span><span>{run.duration}</span><span>{provider}</span><span>{run.model}</span><StateTag state={run.status === 'completed' ? 'resolved' : run.status === 'failed' || run.status === 'invalid' ? 'active' : 'outdated'} /></>;
    return live && run.status === 'completed' ? <button type="button" className="history-row" key={run.id} aria-label={`Open historical run ${run.date} ${provider} ${run.model}`} onClick={() => onOpenRun(run.id)}>{content}</button> : <div className="history-row" key={run.id}>{content}</div>;
  })}</div></div></div>;
}

function EmptyAnalysis() { return <div className="empty-analysis"><Sparkles size={20} /><h4>Walkthrough not generated yet</h4><p>Start a local analysis to map this pull request into reviewable behavior.</p></div>; }
function Metric({ icon: Icon, label, value, hint }: { icon: typeof LayoutList; label: string; value: string; hint: string }) { return <div className="metric"><Icon size={16} /><div><strong>{value}</strong><span>{label}</span><small>{hint}</small></div></div>; }
function SectionTitle({ label, action, onAction }: { label: string; action?: string; onAction?: () => void }) { return <div className="section-title"><h4>{label}</h4>{action && <button onClick={onAction}>{action} <ArrowUp size={12} /></button>}</div>; }
function SectionIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div className="section-intro"><div className="eyebrow">{eyebrow}</div><h3>{title}</h3><p>{description}</p></div>; }
function AttentionTag({ level }: { level: ChangeGroup['attention'] }) { return <span className={`attention ${level}`}><span />{level} attention</span>; }
function StateTag({ state }: { state: ReviewState }) { return <span className={`state-tag ${state}`}>{state}</span>; }
function InsightRow({ insight }: { insight: ReviewInsight }) { return <div className="pulse-row"><div className={`pulse-icon ${insight.state}`}><AlertCircle size={14} /></div><div><strong>{insight.title}</strong><span>{insight.provenance} · {insight.state}</span></div><span className="pulse-count">{insight.count}</span></div>; }
function EvidenceStrip({ pr }: { pr: PullRequest }) { return <div className="evidence-strip"><div><div className="eyebrow">Evidence first</div><strong>Every interpretation points back to repository facts.</strong><p>Files, symbols, tests, and threads stay one click away throughout the walkthrough.</p></div><div className="evidence-strip-items">{pr.evidence.slice(0, 3).map((item) => <span key={item.id}><FileCode2 size={13} />{item.label}</span>)}</div></div>; }

export default App;
