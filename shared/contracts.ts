export type GithubSource = "github";

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
  state: "open";
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
export type AgentProvider = "claude" | "codex" | "cursor";
/** Stable discovery/default priority requested by the product contract. */
export const AGENT_PROVIDER_PRIORITY: readonly AgentProvider[] = [
  "codex",
  "cursor",
  "claude",
];

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
  /** Bounded analysis controls persisted with the run for reproducibility. */
  config?: AnalysisRunConfig;
}

export interface AnalysisRunConfig {
  depth: "quick" | "standard" | "deep";
  includeReviewComments: boolean;
  maxGraphNodes: number;
  timeoutMinutes: number;
}

export const DEFAULT_ANALYSIS_RUN_CONFIG: AnalysisRunConfig = {
  depth: "standard",
  includeReviewComments: true,
  maxGraphNodes: 80,
  timeoutMinutes: 20,
};

export interface RunRetentionSettings {
  analysisDays: number;
  worktreeDays: number;
}

export const DEFAULT_RETENTION_SETTINGS: RunRetentionSettings = {
  analysisDays: 30,
  worktreeDays: 14,
};

export type AnalysisStage =
  | "preparing"
  | "collecting"
  | "inspecting"
  | "generating"
  | "validating"
  | "complete";

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
  /** Validated, provider-neutral intermediate result for a batched map task. */
  mapOutput?: { taskId: string; observations: Array<{ path: string; segment: number; summary: string; evidence: Array<{ path: string; line: number | null }>; changeGroups: string[]; tests: string[]; flows: string[]; limitations: string[] }> };
}

export interface ProviderAnalysisTask {
  kind: "map" | "reduce";
  id: string;
  total: number;
  /** Trusted, platform-specific command for the bundled Electron Node runtime. */
  validatorCommand?: string;
  /** Trusted bundled Electron executable injected only into the provider child environment. */
  validatorRuntime?: string;
  assignedPaths?: string[];
  assignedUnits?: Array<{ path: string; segment: number }>;
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
    model?: string,
    task?: ProviderAnalysisTask,
  ): Promise<AgentAnalysisResult>;
}

export interface GraphNode {
  id: string;
  label: string;
  explanation: string;
  changed: boolean;
  changeGroupIds: string[];
  testIds: string[];
  reviewThreadIds: string[];
  reviewInsightIds: string[];
  evidenceIds: string[];
  state?: "changed" | "context";
  type?: string;
  confidence?: number;
  [key: string]: unknown;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  evidenceIds: string[];
  changeGroupIds: string[];
  reviewThreadIds: string[];
  [key: string]: unknown;
}
export interface GraphTour {
  id: string;
  title: string;
  steps: Array<{
    nodeId: string;
    title: string;
    explanation: string;
    evidenceIds?: string[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}
export interface Graph {
  id: "system-overview" | "data-flow" | "code-dependency" | "user-action";
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  guidedTours: GraphTour[];
}
export interface EvidenceItem {
  id: string;
  kind: string;
  title: string;
  path: string;
  line: number | null;
  url: string | null;
  [key: string]: unknown;
}
export interface ChangeGroup {
  id: string;
  title: string;
  summary: string;
  motivation: string;
  previousBehavior: string;
  newBehavior: string;
  attention: "high" | "medium" | "low";
  evidenceIds: string[];
  [key: string]: unknown;
}
export interface WalkthroughStep {
  id: string;
  title: string;
  changeGroupId: string;
  evidenceIds: string[];
  reason: string;
  summary: string;
  limitations: string[];
  dependsOnStepIds: string[];
  flowNodeIds: string[];
  testIds: string[];
  reviewInsightIds: string[];
  [key: string]: unknown;
}
export interface TestMapping {
  id: string;
  title: string;
  behavior: string;
  status: "covered" | "partial" | "missing";
  evidenceIds: string[];
  changeGroupIds: string[];
  [key: string]: unknown;
}
export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  authorAssociation: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  commitSha: string | null;
  originalCommitSha: string | null;
  [key: string]: unknown;
}
export interface ReviewThread {
  id: string;
  status:
    | "active"
    | "open"
    | "resolved"
    | "outdated"
    | "disputed"
    | "dismissed"
    | "informational"
    | "unknown";
  provenance: string;
  evidenceIds: string[];
  author: string;
  body: string;
  replies: ReviewReply[];
  replyCount: number;
  url: string | null;
  resolvedBy: string | null;
  authorAssociation: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  startLine: number | null;
  originalStartLine: number | null;
  commitSha: string | null;
  originalCommitSha: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  changeGroupIds: string[];
  graphNodeIds: string[];
  reviewInsightIds: string[];
  [key: string]: unknown;
}
export interface ReviewInsight {
  id: string;
  title: string;
  detail: string;
  status: ReviewThread["status"];
  provenance: string;
  evidenceIds: string[];
  changeGroupIds: string[];
  reviewThreadIds: string[];
  graphNodeIds: string[];
  [key: string]: unknown;
}
export interface WalkthroughDocument {
  schemaVersion: "1.1.0";
  run: {
    id: string;
    createdAt: string;
    provider: string;
    model: string;
    skillVersion: string;
    [key: string]: unknown;
  };
  pullRequest: {
    host: "github.com";
    repository: string;
    number: number;
    baseSha: string;
    headSha: string;
    [key: string]: unknown;
  };
  summary: {
    intent: string;
    behavioralChanges: unknown[];
    architecturalImpact: unknown[];
    limitations: unknown[];
    [key: string]: unknown;
  };
  changeGroups: ChangeGroup[];
  walkthrough: WalkthroughStep[];
  graphs: {
    systemOverview: Graph;
    dataFlow: Graph;
    codeDependency: Graph;
    userAction: Graph;
    [key: string]: unknown;
  };
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
  runtimeVersion?: string;
  lastProgress?: AnalysisProgressEvent;
  skillContractVersion?: string;
  skillReferenceUrl?: string;
  config?: AnalysisRunConfig;
  preferred?: boolean;
  error?: SafeDiagnostic;
}

export type AnalysisRunStatus = "ready" | "failed" | "invalid" | "cancelled";
export interface SafeDiagnostic {
  code: string;
  message: string;
  details?: string[];
}
export interface AnalysisRunResult {
  runId: string;
  status: AnalysisRunStatus;
  document?: WalkthroughDocument;
  error?: SafeDiagnostic;
  manifest: AnalysisManifest;
  artifactDirectory: string;
}

export interface AnalysisRunSummary extends AnalysisManifest {
  artifactDirectory: string;
  outdated?: boolean;
}
export interface AnalysisDiagnostics {
  manifest: AnalysisManifest;
  error?: SafeDiagnostic;
  logExcerpt: string[];
}

export type ReviewProgressStatus =
  "pending" | "reviewed" | "follow-up" | "skipped";
export interface ReviewProgress {
  runId: string;
  stepId: string;
  status: ReviewProgressStatus;
  note: string;
  updatedAt: string;
}

export interface EvidenceDetail {
  path: string;
  line: number | null;
  source: "worktree" | "analysis-input";
  content: string;
  hunks: Array<{ header: string; content: string }>;
}

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
  listAnalysisRuns(
    repository: string,
    pullNumber: number,
    currentHeadSha?: string,
  ): Promise<AnalysisRunSummary[]>;
  loadAnalysisRun(
    repository: string,
    pullNumber: number,
    runId: string,
  ): Promise<AnalysisRunResult | null>;
  loadAnalysisDiagnostics?: (
    repository: string,
    pullNumber: number,
    runId: string,
  ) => Promise<AnalysisDiagnostics | null>;
  getReviewProgress?: (
    repository: string,
    pullNumber: number,
    runId: string,
  ) => Promise<ReviewProgress[]>;
  setReviewProgress?: (
    repository: string,
    pullNumber: number,
    progress: ReviewProgress,
  ) => Promise<ReviewProgress | null>;
  getEvidenceDetail?: (
    repository: string,
    headSha: string,
    path: string,
    line?: number,
  ) => Promise<EvidenceDetail | null>;
  deleteAnalysisRun?: (
    repository: string,
    pullNumber: number,
    runId: string,
  ) => Promise<boolean>;
  setPreferredAnalysisRun?: (
    repository: string,
    pullNumber: number,
    runId: string,
  ) => Promise<boolean>;
  getRetentionSettings?: () => Promise<RunRetentionSettings>;
  setRetentionSettings?: (
    settings: RunRetentionSettings,
  ) => Promise<RunRetentionSettings | null>;
  openExternal(url: string): Promise<boolean>;
  openEvidence?: (
    repository: string,
    headSha: string,
    path: string,
    line?: number,
  ) => Promise<boolean>;
  /** Optional for source-compatible browser fixtures. Electron always supplies it. */
  checkForUpdate?: () => Promise<UpdateCheckResult>;
  /** Downloads the most recently validated update; renderer supplies no URL or path. */
  downloadUpdate?: () => Promise<UpdateDownloadResult>;
  /** Optional for source-compatible browser fixtures. Electron always supplies it. */
  subscribeUpdateDownloadProgress?: (
    listener: (event: UpdateDownloadProgress) => void,
  ) => () => void;
  /** Opens only the artifact successfully downloaded by the main process. */
  openDownloadedUpdate?: () => Promise<boolean>;
  subscribeAnalysisProgress(
    listener: (event: AnalysisProgressEvent) => void,
  ): () => void;
}

export interface UpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface UpdateDownloadResult {
  success: boolean;
  artifactName?: string;
  path?: string;
  digest?: string;
  /** Always generic; implementation diagnostics never cross IPC. */
  error?: string;
}
