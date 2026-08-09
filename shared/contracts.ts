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

export interface PullRequestComment {
  id: number;
  nodeId: string;
  body: string;
  author: string;
  authorAvatarUrl: string | null;
  authorAssociation: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  viewerDidAuthor: boolean;
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
/** A bounded per-run thinking budget understood by the supported provider adapters. */
export type AnalysisEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  /** Optional bounded thinking level for this analysis run. */
  effort?: AnalysisEffort;
  /** Supplemental evidence-collection focus; the fixed output contract remains authoritative. */
  customPrompt?: string;
  /** Bounded analysis controls persisted with the run for reproducibility. */
  config?: AnalysisRunConfig;
}

export interface AnalysisRunConfig {
  depth: "quick" | "standard" | "deep";
  /** Coordinator is the current architecture; legacy preserves the established map/reduce flow. */
  scanMode: "coordinator" | "legacy";
  includeReviewComments: boolean;
  maxGraphNodes: number;
  timeoutMinutes: number;
}

export const DEFAULT_ANALYSIS_RUN_CONFIG: AnalysisRunConfig = {
  depth: "standard",
  scanMode: "coordinator",
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
  | "anchoring"
  | "walkthrough"
  | "tests-risks"
  | "flows"
  | "assembling"
  | "validating"
  | "complete";

export interface AnalysisProgressEvent {
  runId: string;
  stage: AnalysisStage;
  message: string;
  timestamp: string;
  taskState?: "pending" | "running" | "complete" | "failed";
}

export interface AgentAnalysisResult {
  status: AnalysisRunStatus;
  document?: WalkthroughDocument;
  rawOutput: string;
  logs: string[];
  /** Redacted provider lifecycle telemetry; never includes model reasoning. */
  diagnosticEvents?: AnalysisDiagnosticEvent[];
  model?: string;
  errors?: string[];
  /** Validated, provider-neutral intermediate result for anchored large-PR work. */
  taskOutput?: AnchoredTaskOutput;
  /** Legacy map-stage result. Kept so the selectable compatibility engine remains executable. */
  mapOutput?: { taskId: string; observations: Array<{ path: string; segment: number; summary: string; evidence: ProviderEvidenceReference[]; changeGroups: string[]; tests: string[]; flows: string[]; limitations: string[] }> };
}

export type AnchoredTaskKind = "anchor" | "walkthrough" | "tests-risks" | "flows";
export type LegacyBatchTaskKind = "map" | "reduce";
export type AnchorDomainId = "production-path" | "experimental-pocs" | "migration-rollback" | "updater-installer" | "runtime-packaging" | "reviewer-workflow";
export type AnchorDomainStatus = "changed" | "unchanged-relevant" | "not-evidenced";
export interface ProviderEvidenceReference { path: string; line: number | null; role?: "changed" | "unchanged-context"; }
/** Coordinator evidence is always line-specific and declares why the line is usable. */
export interface CoordinatorEvidenceReference { path: string; line: number; role: "changed" | "unchanged-context"; }
export interface SemanticAnchorGroup {
  id: string; title: string; summary: string; motivation: string;
  previousBehavior: string; newBehavior: string; attention: "low" | "medium" | "high";
  evidence: CoordinatorEvidenceReference[];
}
export interface SemanticAnchorDomain {
  id: AnchorDomainId; status: AnchorDomainStatus; rationale: string;
  evidence: CoordinatorEvidenceReference[]; changeGroupIds: string[];
}
export interface SemanticAnchor { taskId: string; domains: SemanticAnchorDomain[]; changeGroups: SemanticAnchorGroup[]; }
export interface SpecialistCoverage { domainId: AnchorDomainId; status: "covered" | "not-applicable"; rationale: string; }
export interface AnchoredSpecialistOutput {
  taskId: string; coverage: SpecialistCoverage[];
  /** Task-specific payload. It is deliberately not a WalkthroughDocument. */
  content: Record<string, unknown>;
}
export type AnchoredTaskOutput = SemanticAnchor | AnchoredSpecialistOutput;

export interface ProviderAnalysisTask {
  kind: AnchoredTaskKind | LegacyBatchTaskKind;
  id: string;
  total: number;
  /** The accepted semantic source of truth supplied verbatim to every specialist. */
  anchor?: SemanticAnchor;
  /** Trusted task-local validator command/runtime for the retained legacy engine only. */
  validatorCommand?: string;
  validatorRuntime?: string;
  assignedPaths?: string[];
  assignedUnits?: Array<{ path: string; segment: number }>;
  /** Host-owned MCP bootstrap for the coordinator lane; never contains repository input. */
  coordinator?: { url: string; token: string; shimPath: string; submitted: () => AnchoredTaskOutput | null; submitForHarness?: (key: string, result: AnchoredTaskOutput) => Promise<unknown> };
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
  activity?: AnalysisProgressEvent[];
  effort?: AnalysisEffort;
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
  /** Redacted lifecycle events from this run for immediate UI inspection. */
  diagnosticEvents?: AnalysisDiagnosticEvent[];
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
  rawOutputExcerpt: string;
  /** Structured operational events, bounded and redacted before crossing IPC. */
  events?: AnalysisDiagnosticEvent[];
}
export type AnalysisDiagnosticLevel = "debug" | "info" | "warn" | "error";
export interface AnalysisDiagnosticEvent {
  timestamp: string;
  level: AnalysisDiagnosticLevel;
  event: string;
  message: string;
  runId?: string;
  provider?: AgentProvider;
  stage?: AnalysisStage;
  taskId?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}
export interface DiagnosticExportResult {
  saved: boolean;
  filePath?: string;
  error?: string;
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
  listPullRequestComments(
    repository: string,
    pullNumber: number,
  ): Promise<PullRequestComment[]>;
  createPullRequestComment(
    repository: string,
    pullNumber: number,
    body: string,
  ): Promise<PullRequestComment>;
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
  exportAnalysisDiagnostics?: (
    repository: string,
    pullNumber: number,
    runId: string,
  ) => Promise<DiagnosticExportResult>;
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
