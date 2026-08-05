export type GithubSource = 'github';

export interface GithubAccountDTO {
  source: GithubSource;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface RepositoryDTO {
  source: GithubSource;
  id: string;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  url: string;
}

export interface PullRequestDTO {
  source: GithubSource;
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: 'open';
  author: string | null;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  reviewDecision: string | null;
  reviewRequested: boolean;
  authoredByViewer?: boolean;
  reviewedByViewer?: boolean;
}

export interface BootstrapResult {
  account: GithubAccountDTO | null;
  repositories: RepositoryDTO[];
  warnings: string[];
}

/** Providers supported by the local analysis orchestration boundary. */
export type AgentProvider = 'claude' | 'codex' | 'cursor';
/** Stable discovery/default priority requested by the product contract. */
export const AGENT_PROVIDER_PRIORITY: readonly AgentProvider[] = ['codex', 'cursor', 'claude'];

export interface AgentCapabilities {
  structuredOutput: boolean;
  streaming: boolean;
  sessionContinuation: boolean;
  readOnly: boolean;
  toolAllowlist: boolean;
  modelSelection: boolean;
  authenticationState: boolean;
}

export interface AgentInstallationStatus {
  provider: AgentProvider;
  displayName: string;
  executable: string;
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  capabilities: AgentCapabilities;
  /** Model choices reported by the installed provider tool. Never hard-coded by PR Atlas. */
  models?: AgentModelOption[];
  /** Sanitized diagnostic text; provider stderr and command errors never cross IPC. */
  error?: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface AnalysisRequest {
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  provider: AgentProvider;
  /** Optional provider-reported model id. */
  model?: string;
  /** Supplemental evidence-collection focus; the fixed output contract remains authoritative. */
  customPrompt?: string;
}

export type AnalysisStage = 'preparing' | 'collecting' | 'inspecting' | 'generating' | 'validating' | 'complete';

export interface AnalysisProgressEvent {
  runId: string;
  stage: AnalysisStage;
  message: string;
  timestamp: string;
}

export interface AgentAnalysisResult {
  status: AnalysisRunStatus;
  document?: WalkthroughDocument;
  rawOutput: string;
  logs: string[];
  model?: string;
  errors?: string[];
}

/** Provider-neutral process boundary used by the main-process orchestration. */
export interface AgentAdapter {
  readonly id: AgentProvider;
  readonly displayName: string;
  detect(): Promise<AgentInstallationStatus>;
  listModels?(): Promise<AgentModelOption[]>;
  getCapabilities(): AgentCapabilities;
  analyze(
    request: AnalysisRequest,
    worktree: string,
    inputDirectory: string,
    signal: AbortSignal | undefined,
    progress: (stage: AnalysisStage, message: string) => void,
  ): Promise<AgentAnalysisResult>;
}

export interface GraphNode { id: string; label: string; explanation: string; changed: boolean; changeGroupIds: string[]; testIds: string[]; reviewThreadIds: string[]; reviewInsightIds: string[]; evidenceIds: string[]; state?: 'changed' | 'context'; type?: string; confidence?: number; [key: string]: unknown; }
export interface GraphEdge { id: string; source: string; target: string; label: string; evidenceIds: string[]; changeGroupIds: string[]; reviewThreadIds: string[]; [key: string]: unknown; }
export interface GraphTour { id: string; title: string; steps: Array<{ nodeId: string; title: string; explanation: string; evidenceIds?: string[]; [key: string]: unknown }>; [key: string]: unknown; }
export interface Graph { id: 'system-overview' | 'data-flow' | 'code-dependency' | 'user-action'; description: string; nodes: GraphNode[]; edges: GraphEdge[]; guidedTours: GraphTour[]; }
export interface EvidenceItem { id: string; kind: string; title: string; path: string; line: number | null; url: string | null; [key: string]: unknown; }
export interface ChangeGroup { id: string; title: string; summary: string; motivation: string; previousBehavior: string; newBehavior: string; attention: 'high' | 'medium' | 'low'; evidenceIds: string[]; [key: string]: unknown; }
export interface WalkthroughStep { id: string; title: string; changeGroupId: string; evidenceIds: string[]; [key: string]: unknown; }
export interface TestMapping { id: string; title: string; behavior: string; status: 'covered' | 'partial' | 'missing'; evidenceIds: string[]; changeGroupIds: string[]; [key: string]: unknown; }
export interface ReviewReply { id: string; author: string; body: string; authorAssociation: string | null; createdAt: string | null; updatedAt: string | null; url: string | null; path: string | null; line: number | null; originalLine: number | null; side: string | null; commitSha: string | null; originalCommitSha: string | null; [key: string]: unknown; }
export interface ReviewThread { id: string; status: 'active' | 'open' | 'resolved' | 'outdated' | 'disputed' | 'dismissed' | 'informational' | 'unknown'; provenance: string; evidenceIds: string[]; author: string; body: string; replies: ReviewReply[]; replyCount: number; url: string | null; resolvedBy: string | null; authorAssociation: string | null; path: string | null; line: number | null; originalLine: number | null; side: string | null; startLine: number | null; originalStartLine: number | null; commitSha: string | null; originalCommitSha: string | null; createdAt: string | null; updatedAt: string | null; changeGroupIds: string[]; graphNodeIds: string[]; reviewInsightIds: string[]; [key: string]: unknown; }
export interface ReviewInsight { id: string; title: string; detail: string; status: ReviewThread['status']; provenance: string; evidenceIds: string[]; changeGroupIds: string[]; reviewThreadIds: string[]; graphNodeIds: string[]; [key: string]: unknown; }
export interface WalkthroughDocument {
  schemaVersion: '1.0.0';
  run: { id: string; createdAt: string; provider: string; model: string; skillVersion: string; [key: string]: unknown };
  pullRequest: { host: 'github.com'; repository: string; number: number; baseSha: string; headSha: string; [key: string]: unknown };
  summary: { intent: string; behavioralChanges: unknown[]; architecturalImpact: unknown[]; limitations: unknown[]; [key: string]: unknown };
  changeGroups: ChangeGroup[];
  walkthrough: WalkthroughStep[];
  graphs: { systemOverview: Graph; dataFlow: Graph; codeDependency: Graph; userAction: Graph; [key: string]: unknown };
  tests: TestMapping[];
  reviewThreads: ReviewThread[];
  reviewInsights: ReviewInsight[];
  evidence: EvidenceItem[];
  [key: string]: unknown;
}

export interface AnalysisManifest {
  runId: string;
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  provider: AgentProvider;
  status: AnalysisRunStatus;
  createdAt: string;
  completedAt?: string;
  schemaVersion?: string;
  model?: string;
  skillContractVersion?: string;
  skillReferenceUrl?: string;
  error?: SafeDiagnostic;
}

export type AnalysisRunStatus = 'ready' | 'failed' | 'invalid' | 'cancelled';
export interface SafeDiagnostic { code: string; message: string; details?: string[]; }
export interface AnalysisRunResult {
  runId: string;
  status: AnalysisRunStatus;
  document?: WalkthroughDocument;
  error?: SafeDiagnostic;
  manifest: AnalysisManifest;
  artifactDirectory: string;
}

export interface AnalysisRunSummary extends AnalysisManifest { artifactDirectory: string; outdated?: boolean; }

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  releaseUrl?: string;
  /** Canonical, validated GitHub release asset selected for this runtime. */
  downloadUrl?: string;
  /** Safe basename of the selected installer asset. */
  artifactName?: string;
  /** Exact GitHub-provided SHA-256 digest for the selected installer asset. */
  digest?: string;
  checkedAt: string;
  /** Always generic; response bodies and network diagnostics never cross IPC. */
  error?: string;
}

export interface PrAtlasApi {
  bootstrap(): Promise<BootstrapResult>;
  /** Optional for source-compatible browser fixtures from the single-provider MVP. */
  listProviders?: () => Promise<AgentInstallationStatus[]>;
  listPullRequests(repository: string): Promise<PullRequestDTO[]>;
  startAnalysis(request: AnalysisRequest): Promise<AnalysisRunResult>;
  cancelAnalysis(runId: string): Promise<boolean>;
  listAnalysisRuns(repository: string, pullNumber: number, currentHeadSha?: string): Promise<AnalysisRunSummary[]>;
  loadAnalysisRun(repository: string, pullNumber: number, runId: string): Promise<AnalysisRunResult | null>;
  openExternal(url: string): Promise<boolean>;
  openEvidence?: (repository: string, headSha: string, path: string, line?: number) => Promise<boolean>;
  /** Optional for source-compatible browser fixtures. Electron always supplies it. */
  checkForUpdate?: () => Promise<UpdateCheckResult>;
  /** Downloads the most recently validated update; renderer supplies no URL or path. */
  downloadUpdate?: () => Promise<UpdateDownloadResult>;
  /** Opens only the artifact successfully downloaded by the main process. */
  openDownloadedUpdate?: () => Promise<boolean>;
  subscribeAnalysisProgress(listener: (event: AnalysisProgressEvent) => void): () => void;
}

export interface UpdateDownloadResult {
  success: boolean;
  artifactName?: string;
  path?: string;
  digest?: string;
  /** Always generic; implementation diagnostics never cross IPC. */
  error?: string;
}
