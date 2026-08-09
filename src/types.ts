import type { AgentProvider, AnalysisRunSummary, Graph as ContractGraph, GraphNode as ContractGraphNode, GraphEdge as ContractGraphEdge, ReviewDocument } from '../shared/contracts';

export type ReviewRelationship = 'primary' | 'supporting' | 'adjacent' | 'independent';
export interface ReviewStory {
  id: string;
  title: string;
  summary: string;
  relationshipToPrimary: ReviewRelationship;
  relationshipRationale: string;
  reviewReason: string;
  changeGroupIds: string[];
  dependsOnStoryIds: string[];
}

export type PRStatus = 'ready' | 'outdated' | 'processing' | 'unprocessed' | 'failed' | 'cancelled';
export type ReviewState = 'active' | 'open' | 'resolved' | 'outdated' | 'disputed' | 'dismissed' | 'informational' | 'unknown';

export interface Repository {
  source: 'fixture' | 'github';
  id: string;
  name: string;
  owner: string;
  fullName?: string;
  host: string;
  openPRs: number;
  private: boolean;
  defaultBranch?: string;
  updatedAt?: string;
  url?: string;
}

export interface PullRequest {
  source: 'fixture' | 'github';
  id: string;
  number: number;
  repositoryId: string;
  title: string;
  author: string;
  initials: string;
  branch: string;
  base: string;
  baseSha: string;
  headSha: string;
  repositoryFullName?: string;
  url?: string;
  draft?: boolean;
  reviewDecision?: string | null;
  reviewRequested?: boolean;
  authoredByViewer?: boolean;
  reviewedByViewer?: boolean;
  updated: string;
  additions: number;
  deletions: number;
  files: number;
  status: PRStatus;
  labels: string[];
  summary: string;
  changedAreas: string[];
  groups: ChangeGroup[];
  insights: ReviewInsight[];
  flows: Flow[];
  tests: TestMapping[];
  threads: ReviewThread[];
  evidence: Evidence[];
  history: RunHistory[];
  analyzedSha?: string;
  evidenceHeadSha?: string;
  analysisDiagnostic?: string;
  analysisProvenance?: 'demo' | AgentProvider;
  walkthrough?: ReviewDocument;
  stories?: ReviewStory[];
  primaryStoryId?: string;
  reviewPlan?: string[];
}

export interface ChangeGroup {
  id: string;
  title: string;
  description: string;
  attention: 'high' | 'medium' | 'low';
  files: string[];
  before: string;
  after: string;
  rationale: string;
  reviewed: boolean;
  evidenceIds?: string[];
}

export interface ReviewInsight {
  id: string;
  title: string;
  detail: string;
  provenance: 'human' | 'automated';
  state: ReviewState;
  location: string;
  count: number;
}

export interface Flow {
  id: string;
  type: 'system-overview' | 'data-flow' | 'code-dependency' | 'user-action';
  title: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  guidedTours: FlowTour[];
}

export interface FlowNode {
  id: string;
  label: string;
  explanation: string;
  changed: boolean;
  evidenceIds: string[];
  changeGroupIds: string[];
  testIds: string[];
  reviewThreadIds: string[];
  reviewInsightIds: string[];
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  evidenceIds: string[];
  changeGroupIds: string[];
  reviewThreadIds: string[];
}

export interface FlowTour {
  id: string;
  title: string;
  steps: { nodeId: string; title?: string; explanation?: string }[];
}

export interface TestMapping {
  id: string;
  test: string;
  behavior: string;
  status: 'covered' | 'partial' | 'missing';
  evidence: string;
  evidenceIds?: string[];
  changeGroupIds?: string[];
}

export interface ReviewThread {
  id: string;
  author: string;
  initials: string;
  body: string;
  state: ReviewState;
  provenance: string;
  evidenceIds?: string[];
  authorAssociation: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  resolvedBy: string | null;
  path: string | null;
  file: string;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  startLine: number | null;
  originalStartLine: number | null;
  commitSha: string | null;
  originalCommitSha: string | null;
  replies: ReviewReply[];
  replyCount: number;
  changeGroupIds: string[];
  graphNodeIds: string[];
  reviewInsightIds: string[];
  source: 'human' | 'bot';
}

export interface ReviewReply {
  id: string;
  author: string;
  initials: string;
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
}

export interface Evidence {
  id: string;
  label: string;
  path: string;
  kind: 'file' | 'symbol' | 'commit' | 'spec';
  line?: number;
  url?: string;
}

export interface RunHistory {
  id: string;
  date: string;
  duration: string;
  status: 'completed' | 'failed' | 'cancelled' | 'invalid';
  provider?: AgentProvider | 'demo';
  model: string;
  schemaVersion?: string;
  statusLabel?: string;
}

export interface AnalysisStage {
  label: string;
  detail: string;
}

export type ContractAnalysisRunSummary = AnalysisRunSummary;
export type ContractGraphDocument = ContractGraph;
export type ContractGraphNodeDocument = ContractGraphNode;
export type ContractGraphEdgeDocument = ContractGraphEdge;
