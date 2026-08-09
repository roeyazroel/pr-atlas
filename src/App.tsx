import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CircleHelp,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  Files,
  GitPullRequest,
  GitPullRequestArrow,
  History,
  LayoutList,
  ListFilter,
  Loader2,
  MessageSquare,
  Network,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  TestTube2,
  UserRound,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { analysisStages, pullRequests, repositories } from "./data/demo";
import {
  AnalysisStage,
  ChangeGroup,
  Evidence,
  Flow,
  FlowEdge,
  FlowNode,
  PullRequest,
  PRStatus,
  Repository,
  ReviewInsight,
  ReviewReply,
  ReviewState,
  ReviewThread,
  TestMapping,
} from "./types";
import RichThreadsView from "./components/ThreadsView";
import SelectMenu from "./components/SelectMenu";
import {
  AGENT_PROVIDER_PRIORITY,
  DEFAULT_ANALYSIS_RUN_CONFIG,
  DEFAULT_RETENTION_SETTINGS,
  type AgentInstallationStatus,
  type AgentProvider,
  type AnalysisEffort,
  type AnalysisProgressEvent,
  type AnalysisDiagnostics,
  type AnalysisRunConfig,
  type AnalysisRunResult,
  type AnalysisRunSummary,
  type BootstrapResult,
  type EvidenceDetail,
  type Graph as ContractGraph,
  type GraphEdge,
  type GraphNode,
  type PullRequestComment,
  type PullRequestDTO,
  type RepositoryDTO,
  type ReviewProgress,
  type ReviewProgressStatus,
  type RunRetentionSettings,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type WalkthroughDocument,
} from "../shared/contracts";

type View =
  | "overview"
  | "walkthrough"
  | "groups"
  | "insights"
  | "flows"
  | "files"
  | "tests"
  | "threads"
  | "details";
export type Filter = "all" | PRStatus | "mine" | "review" | "reviewed";
type UpdateDownloadState = "idle" | "downloading" | "downloaded" | "failed";
type AccountState = {
  label: string;
  detail: string;
  live: boolean;
  initials: string;
  avatarLabel: string;
};
type CommentResource = {
  status: "idle" | "loading" | "ready" | "error";
  comments: PullRequestComment[];
  error: string | null;
  posting: boolean;
  postError: string | null;
  successMessage: string | null;
};
const emptyCommentResource = (): CommentResource => ({
  status: "idle",
  comments: [],
  error: null,
  posting: false,
  postError: null,
  successMessage: null,
});
const reviewKey = (prId: string, groupId: string) => `${prId}:${groupId}`;
const MIN_GRAPH_ZOOM = 25;
const LARGE_PR_FILE_THRESHOLD = 20;
const LARGE_PR_CHANGE_THRESHOLD = 1_000;
const COORDINATOR_EXCLUSIVE_PROGRESS_STAGES = new Set<AnalysisProgressEvent["stage"]>([
  "anchoring",
  "walkthrough",
  "tests-risks",
  "flows",
  "assembling",
]);

export type EvidenceCodeLineKind =
  | "context"
  | "addition"
  | "deletion"
  | "source";

export type EvidenceCodeLine = {
  kind: EvidenceCodeLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

const isDiffMetadataLine = (line: string): boolean => {
  return [
    "diff --",
    "index ",
    "new file mode ",
    "deleted file mode ",
    "old mode ",
    "new mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "GIT binary patch",
    "Binary files ",
    "--- ",
    "+++ ",
    "\\ No newline at end of file",
  ].some((prefix) => line.startsWith(prefix));
};

/** Convert bounded source/diff text into rows that can share a unified-diff renderer. */
export function buildEvidenceCodeLines(
  content: string,
  source: "worktree" | "analysis-input",
  hunkHeader?: string,
): EvidenceCodeLine[] {
  const rawLines = content.split(/\r?\n/);
  const firstHunkIndex = rawLines.findIndex((line) => line.startsWith("@@"));
  const lines = rawLines.filter((line, index) => {
    if (source !== "analysis-input") return true;
    if (line.startsWith("@@")) return false;
    if (line.startsWith("\\ No newline at end of file")) return false;
    const metadataBeforeHunk =
      firstHunkIndex >= 0 ? index < firstHunkIndex : !hunkHeader;
    return !metadataBeforeHunk || !isDiffMetadataLine(line);
  });
  const hunk = hunkHeader?.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  let oldLine = hunk ? Number(hunk[1]) : null;
  let newLine = hunk ? Number(hunk[2]) : null;
  return lines
    .filter((line, index) => line.length > 0 || index < lines.length - 1)
    .map((line): EvidenceCodeLine => {
      if (!hunkHeader) {
        const numbered = line.match(/^\s*(\d+)\s+\|\s?(.*)$/);
        if (numbered)
          return {
            kind: source === "worktree" ? "source" : "context",
            oldLine: null,
            newLine: Number(numbered[1]),
            text: numbered[2],
          };
      }
      if (hunkHeader && line.startsWith("+")) {
        const row = {
          kind: "addition" as const,
          oldLine: null,
          newLine,
          text: line.slice(1),
        };
        if (newLine !== null) newLine += 1;
        return row;
      }
      if (hunkHeader && line.startsWith("-")) {
        const row = {
          kind: "deletion" as const,
          oldLine,
          newLine: null,
          text: line.slice(1),
        };
        if (oldLine !== null) oldLine += 1;
        return row;
      }
      const text = hunkHeader && line.startsWith(" ") ? line.slice(1) : line;
      const row = {
        kind: "context" as const,
        oldLine,
        newLine,
        text,
      };
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      return row;
    });
}

type GraphBox = { x: number; y: number; width: number; height: number };
type GraphPoint = { x: number; y: number };
type GraphEdgeObstacle = {
  from: GraphPoint;
  to: GraphPoint;
  pathControl?: GraphPoint;
};
type GroupEvidenceItem = { id: string; path: string; line?: number };

export function mergeGroupEvidenceItems(
  linked: GroupEvidenceItem[],
  files: string[],
): GroupEvidenceItem[] {
  const representedLegacy = new Set<string>();
  const legacy = files.flatMap((file) => {
    const parsed = file.match(/^(.*?):(\d+)$/);
    return [
      {
        id: file,
        path: parsed?.[1] ?? file,
        line: parsed ? Number(parsed[2]) : undefined,
      },
    ];
  }).filter((item) => {
    const exactMatch = linked.some(
      (candidate) =>
        candidate.path === item.path && candidate.line === item.line,
    );
    const pathMatch =
      item.line === undefined &&
      linked.some((candidate) => candidate.path === item.path);
    if (exactMatch || pathMatch) return false;
    const key = `${item.path}:${item.line ?? ""}`;
    if (representedLegacy.has(key)) return false;
    representedLegacy.add(key);
    return true;
  });
  return [...linked, ...legacy];
}

/** Convert an anchored graph node position into the box painted by `.flow-node`. */
export function positionedGraphNodeBox(
  position: GraphPoint,
  dimensions: Pick<GraphBox, "width" | "height">,
  translated = true,
): GraphBox {
  return {
    x: position.x - (translated ? dimensions.width * 0.1 : 0),
    y: position.y - (translated ? dimensions.height * 0.5 : 0),
    width: dimensions.width,
    height: dimensions.height,
  };
}

/** Route an edge from rectangle boundaries and place its label in a clear perpendicular lane. */
export function routeGraphEdge(
  from: GraphBox,
  to: GraphBox,
  laneIndex = 0,
  laneCount = 1,
  obstacles: GraphBox[] = [],
  edgeObstacles: GraphEdgeObstacle[] = [],
  bounds?: GraphBox,
): {
  from: GraphPoint;
  to: GraphPoint;
  label: GraphPoint;
  path?: string;
  pathControl?: GraphPoint;
} {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const length = Math.hypot(dx, dy);
  const laneDelta = laneIndex - (laneCount - 1) / 2;
  const labelHalfWidth = 60;
  const labelHalfHeight = 12;
  const overlapsNode = (point: GraphPoint, box: GraphBox) =>
    point.x - labelHalfWidth < box.x + box.width &&
    point.x + labelHalfWidth > box.x &&
    point.y - labelHalfHeight < box.y + box.height &&
    point.y + labelHalfHeight > box.y;
  const overlapsEdge = (point: GraphPoint, edge: GraphEdgeObstacle) => {
    const points = [edge.from, edge.to, edge.pathControl].filter(
      (candidate): candidate is GraphPoint => Boolean(candidate),
    );
    const minX = Math.min(...points.map((candidate) => candidate.x));
    const maxX = Math.max(...points.map((candidate) => candidate.x));
    const minY = Math.min(...points.map((candidate) => candidate.y));
    const maxY = Math.max(...points.map((candidate) => candidate.y));
    const gap = 6;
    return (
      point.x - labelHalfWidth < maxX + gap &&
      point.x + labelHalfWidth > minX - gap &&
      point.y - labelHalfHeight < maxY + gap &&
      point.y + labelHalfHeight > minY - gap
    );
  };
  const clearObstacles = (point: GraphPoint) =>
    !overlapsNode(point, from) &&
    !overlapsNode(point, to) &&
    obstacles.every((obstacle) => !overlapsNode(point, obstacle)) &&
    edgeObstacles.every((edge) => !overlapsEdge(point, edge));
  const withinBounds = (point: GraphPoint) =>
    !bounds ||
    (point.x - labelHalfWidth >= bounds.x &&
      point.x + labelHalfWidth <= bounds.x + bounds.width &&
      point.y - labelHalfHeight >= bounds.y &&
      point.y + labelHalfHeight <= bounds.y + bounds.height);
  if (length < 0.001) {
    const outward = 30 + Math.abs(laneDelta) * 16;
    const start = { x: from.x + from.width, y: fromCenter.y };
    const preferredDirection =
      laneDelta < 0 || laneCount === 1 ? -1 : 1;
    const controlX = from.x + from.width + outward;
    const labelForDirection = (direction: number) => ({
      x: controlX,
      y: fromCenter.y + direction * (from.height / 2 + outward + 24),
    });
    const preferredLabel = labelForDirection(preferredDirection);
    const alternateDirection = preferredDirection * -1;
    const direction =
      bounds && !withinBounds(preferredLabel) && withinBounds(labelForDirection(alternateDirection))
        ? alternateDirection
        : preferredDirection;
    const end = {
      x: from.x + from.width / 2,
      y: fromCenter.y + direction * (from.height / 2),
    };
    const controlY =
      fromCenter.y + direction * (from.height / 2 + outward);
    const baseLabel = labelForDirection(direction);
    let label = baseLabel;
    const selfClear = (point: GraphPoint) =>
      Math.hypot(point.x - controlX, point.y - controlY) >= 18 &&
      withinBounds(point) &&
      clearObstacles(point);
    let found = selfClear(label);
    for (let distance = 1; distance <= 24 && !found; distance += 1) {
      const offsets = [
        { x: 0, y: direction * distance * 20 },
        { x: -distance * 20, y: 0 },
        { x: distance * 20, y: 0 },
        { x: 0, y: -direction * distance * 20 },
      ];
      for (const offset of offsets) {
        const candidate = {
          x: baseLabel.x + offset.x,
          y: baseLabel.y + offset.y,
        };
        if (selfClear(candidate)) {
          label = candidate;
          found = true;
          break;
        }
      }
    }
    return {
      from: start,
      to: end,
      label,
      path: `M ${start.x} ${start.y} C ${controlX} ${start.y}, ${controlX} ${controlY}, ${end.x} ${end.y}`,
      pathControl: { x: controlX, y: controlY },
    };
  }
  const fromScale =
    1 / Math.max(Math.abs(dx) / (from.width / 2), Math.abs(dy) / (from.height / 2), 1e-6);
  const toScale =
    1 / Math.max(Math.abs(dx) / (to.width / 2), Math.abs(dy) / (to.height / 2), 1e-6);
  const fromPoint = {
    x: fromCenter.x + dx * fromScale,
    y: fromCenter.y + dy * fromScale,
  };
  const toPoint = {
    x: toCenter.x - dx * toScale,
    y: toCenter.y - dy * toScale,
  };
  const normal = { x: -dy / length, y: dx / length };
  const tangent = { x: dx / length, y: dy / length };
  const midpoint = {
    x: (fromPoint.x + toPoint.x) / 2,
    y: (fromPoint.y + toPoint.y) / 2,
  };
  const pathOffset = laneCount > 1 ? laneDelta * 20 : 0;
  const initialLabelOffset =
    laneCount > 1
      ? laneDelta * 96 + (Math.abs(laneDelta) < 0.001 ? 48 : 0)
      : 48;
  const labelDirection = initialLabelOffset < 0 ? -1 : 1;
  const pathHalfExtent =
    labelHalfWidth * Math.abs(normal.x) +
    labelHalfHeight * Math.abs(normal.y);
  const minimumPathClearance = pathHalfExtent + 6;
  const startingMagnitude = Math.max(
    Math.abs(initialLabelOffset),
    Math.abs(pathOffset) + minimumPathClearance,
  );
  const tangentOffsets = [0];
  for (let step = 1; step <= 24; step += 1) {
    tangentOffsets.push(-step * 20, step * 20);
  }
  let label = {
    x: midpoint.x + normal.x * labelDirection * startingMagnitude,
    y: midpoint.y + normal.y * labelDirection * startingMagnitude,
  };
  let labelFound = false;
  for (let step = 0; step <= 24 && !labelFound; step += 1) {
    const magnitude = startingMagnitude + step * 20;
    for (const direction of [labelDirection, -labelDirection]) {
      const labelOffset = direction * magnitude;
      if (Math.abs(labelOffset - pathOffset) < minimumPathClearance)
        continue;
      for (const tangentOffset of tangentOffsets) {
        const candidate = {
          x:
            midpoint.x +
            normal.x * labelOffset +
            tangent.x * tangentOffset,
          y:
            midpoint.y +
            normal.y * labelOffset +
            tangent.y * tangentOffset,
        };
        if (
          withinBounds(candidate) &&
          !overlapsNode(candidate, from) &&
          !overlapsNode(candidate, to) &&
          clearObstacles(candidate)
        ) {
          label = candidate;
          labelFound = true;
          break;
        }
      }
      if (labelFound) break;
    }
  }
  return {
    from: fromPoint,
    to: toPoint,
    label,
    ...(laneCount > 1
      ? {
          path: `M ${fromPoint.x} ${fromPoint.y} Q ${midpoint.x + normal.x * pathOffset} ${midpoint.y + normal.y * pathOffset} ${toPoint.x} ${toPoint.y}`,
          pathControl: {
            x: midpoint.x + normal.x * pathOffset,
            y: midpoint.y + normal.y * pathOffset,
          },
        }
      : {}),
  };
}

function analysisDurationNotice(
  pr: Pick<PullRequest, "files" | "additions" | "deletions">,
): string | null {
  const changedLines = pr.additions + pr.deletions;
  if (
    pr.files < LARGE_PR_FILE_THRESHOLD &&
    changedLines < LARGE_PR_CHANGE_THRESHOLD
  )
    return null;
  return `Large PR: ${pr.files} files and ${changedLines.toLocaleString()} changed lines. Analysis may take several minutes.`;
}

const statusMeta: Record<PRStatus, { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "ready" },
  outdated: { label: "Outdated", tone: "outdated" },
  processing: { label: "Processing", tone: "processing" },
  unprocessed: { label: "Unprocessed", tone: "unprocessed" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "failed" },
};

const viewItems: { id: View; label: string; icon: typeof LayoutList }[] = [
  { id: "overview", label: "Overview", icon: LayoutList },
  { id: "walkthrough", label: "Walkthrough", icon: Sparkles },
  { id: "groups", label: "Change groups", icon: GitPullRequestArrow },
  { id: "insights", label: "Insights", icon: AlertCircle },
  { id: "flows", label: "Flows", icon: Network },
  { id: "files", label: "Files", icon: Files },
  { id: "tests", label: "Tests", icon: TestTube2 },
  { id: "threads", label: "Comments", icon: MessageSquare },
  { id: "details", label: "Analysis details", icon: Code2 },
];

const liveApi = () =>
  typeof window !== "undefined" ? window.prAtlas : undefined;
const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value : fallback;
const safeArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const shortSha = (sha: string) => (sha ? sha.slice(0, 7) : "unknown");
const orderPullRequestComments = (
  comments: PullRequestComment[],
): PullRequestComment[] =>
  [...comments].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id - right.id,
  );
const initialsFor = (name: string | null) =>
  safeString(name, "GitHub")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const accountFromBootstrap = (
  result: Pick<BootstrapResult, "account" | "warnings">,
): AccountState =>
  result.account
    ? {
        label: `@${result.account.login}`,
        detail: result.warnings.join(" ") || "Authenticated GitHub CLI session",
        live: true,
        initials: initialsFor(result.account.name ?? result.account.login),
        avatarLabel: `GitHub account ${result.account.name ?? result.account.login}`,
      }
    : {
        label: "GitHub CLI offline",
        detail:
          result.warnings.join(" ") ||
          "GitHub CLI is unavailable. Retry discovery after authentication.",
        live: false,
        initials: "GH",
        avatarLabel: "GitHub CLI offline",
      };
const relativeDate = (iso: string) => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso || "unknown";
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  return minutes < 60
    ? `${minutes} min ago`
    : minutes < 1440
      ? `${Math.round(minutes / 60)} hr ago`
      : `${Math.round(minutes / 1440)} days ago`;
};
const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const formatBytes = (bytes: number): string => {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = safeBytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = Exclude<ThemeMode, "system">;
const THEME_STORAGE_KEY = "atlas:theme";
const PROVIDER_STORAGE_KEY = "atlas:provider";
const MODEL_STORAGE_KEY = "atlas:provider-models";
const EFFORT_STORAGE_KEY = "atlas:provider-efforts";
const ANALYSIS_CONFIG_STORAGE_KEY = "atlas:analysis-config";
const providerDefaults: Record<AgentProvider, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent",
};
const themeModes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const providerEfforts: Record<AgentProvider, readonly AnalysisEffort[]> = {
  codex: ["low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};
const effortLabels: Record<AnalysisEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};
const DEFAULT_ANALYSIS_EFFORT: AnalysisEffort = "medium";

function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return "system";
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* accept legacy unquoted values */
    }
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readProviderPreference(): AgentProvider | null {
  try {
    const raw = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!raw) return null;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* accept legacy unquoted values */
    }
    return value === "claude" || value === "codex" || value === "cursor"
      ? value
      : null;
  } catch {
    return null;
  }
}

function readEffortPreferences(): Partial<
  Record<AgentProvider, AnalysisEffort>
> {
  const raw = readStored<unknown>(EFFORT_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const stored = raw as Record<string, unknown>;
  return AGENT_PROVIDER_PRIORITY.reduce<
    Partial<Record<AgentProvider, AnalysisEffort>>
  >((preferences, provider) => {
    const effort = stored[provider];
    if (
      typeof effort === "string" &&
      providerEfforts[provider].includes(effort as AnalysisEffort)
    )
      preferences[provider] = effort as AnalysisEffort;
    return preferences;
  }, {});
}

function providerLabel(provider: string | undefined): string {
  return provider && provider in providerDefaults
    ? providerDefaults[provider as AgentProvider]
    : provider || "Unknown provider";
}

function providerStatusLabel(status: AgentInstallationStatus): string {
  return status.installed
    ? `Installed${status.version ? ` · ${status.version}` : ""}`
    : "Unavailable";
}

function emptyLivePR(dto: PullRequestDTO, repository: Repository): PullRequest {
  return {
    source: "github",
    id: dto.id,
    number: dto.number,
    repositoryId: repository.id,
    repositoryFullName: dto.repository,
    title: dto.title,
    author: dto.author ?? "Unknown author",
    initials: initialsFor(dto.author),
    branch: dto.headRef,
    base: dto.baseRef,
    baseSha: dto.baseSha,
    headSha: dto.headSha,
    url: dto.url,
    updated: relativeDate(dto.updatedAt),
    additions: dto.additions,
    deletions: dto.deletions,
    files: dto.changedFiles,
    status: "unprocessed",
    labels: dto.labels,
    summary: "No walkthrough generated for this GitHub pull request yet.",
    changedAreas: dto.labels.length ? dto.labels : ["Repository changes"],
    groups: [],
    insights: [],
    flows: [],
    tests: [],
    threads: [],
    evidence: [],
    history: [],
    draft: dto.isDraft,
    reviewDecision: dto.reviewDecision,
    reviewRequested: dto.reviewRequested,
    authoredByViewer: dto.authoredByViewer === true,
    reviewedByViewer: dto.reviewedByViewer === true,
  };
}

function mapRepository(dto: RepositoryDTO): Repository {
  return {
    source: "github",
    id: dto.fullName,
    name: dto.name,
    owner: dto.owner,
    fullName: dto.fullName,
    host: "github.com",
    openPRs: 0,
    private: dto.private,
    defaultBranch: dto.defaultBranch,
    updatedAt: dto.updatedAt,
    url: dto.url,
  };
}

function mapGraph(contract: ContractGraph | undefined, fallback: Flow): Flow {
  if (!contract) return fallback;
  const ids = (value: unknown) =>
    safeArray(value).filter((id): id is string => typeof id === "string");
  const nodes = safeArray(contract.nodes).map((raw, index) => {
    const node = objectValue(raw);
    const id = safeString(node.id, `${contract.id}-${index + 1}`);
    return {
      id,
      label: safeString(node.label ?? node.title, id),
      explanation: safeString(
        node.explanation,
        "No additional explanation provided.",
      ),
      changed: node.changed === true,
      evidenceIds: ids(node.evidenceIds),
      changeGroupIds: ids(node.changeGroupIds),
      testIds: ids(node.testIds),
      reviewThreadIds: ids(node.reviewThreadIds),
      reviewInsightIds: ids(node.reviewInsightIds),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges =
    contract.id === "system-overview"
      ? []
      : safeArray(contract.edges).flatMap((raw, index) => {
          const edge = objectValue(raw) as Partial<GraphEdge>;
          return typeof edge.source === "string" &&
            typeof edge.target === "string" &&
            nodeIds.has(edge.source) &&
            nodeIds.has(edge.target)
            ? [
                {
                  id: safeString(edge.id, `${contract.id}-edge-${index + 1}`),
                  source: edge.source,
                  target: edge.target,
                  label: safeString(edge.label, "connects"),
                  evidenceIds: ids(edge.evidenceIds),
                  changeGroupIds: ids(edge.changeGroupIds),
                  reviewThreadIds: ids(edge.reviewThreadIds),
                },
              ]
            : [];
        });
  const guidedTours = safeArray(contract.guidedTours).map((raw, index) => {
    const tour = objectValue(raw);
    return {
      id: safeString(tour.id, `${contract.id}-tour-${index + 1}`),
      title: safeString(tour.title, `Review ${fallback.title}`),
      steps: safeArray(tour.steps)
        .map((step) => {
          const item = objectValue(step);
          return {
            nodeId: safeString(item.nodeId),
            title: safeString(item.title),
            explanation: safeString(item.explanation),
          };
        })
        .filter((step) => nodeIds.has(step.nodeId)),
    };
  });
  return {
    id: contract.id,
    type: contract.id,
    title: fallback.title,
    description: safeString(
      (contract as unknown as Record<string, unknown>).description,
      fallback.description,
    ),
    nodes,
    edges,
    guidedTours: guidedTours.length ? guidedTours : fallback.guidedTours,
  };
}

export function mapWalkthroughDocument(
  document: WalkthroughDocument,
  pr: PullRequest,
  provider?: string,
): PullRequest {
  const evidence = safeArray(document.evidence).map((raw, index) => {
    const item = objectValue(raw);
    return {
      id: safeString(item.id, `evidence-${index + 1}`),
      label: safeString(item.title ?? item.label, `Evidence ${index + 1}`),
      path: safeString(
        item.path ?? item.location,
        safeString(item.id, "Unknown evidence"),
      ),
      kind: safeString(item.kind, "file") as Evidence["kind"],
      ...(Number.isInteger(item.line) && Number(item.line) > 0
        ? { line: Number(item.line) }
        : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    };
  });
  const evidenceById = new Map(
    safeArray(document.evidence).map((raw) => {
      const item = objectValue(raw);
      return [safeString(item.id), item];
    }),
  );
  const evidenceLocation = (id: unknown, fallback: string) => {
    const item = typeof id === "string" ? evidenceById.get(id) : undefined;
    if (!item) return fallback;
    const path = safeString(item.path ?? item.location, fallback);
    return Number.isInteger(item.line) && Number(item.line) > 0
      ? `${path}:${Number(item.line)}`
      : path;
  };
  const rawGroups = safeArray(document.changeGroups).map((raw, index) => {
    const item = objectValue(raw);
    const ids = safeArray(item.evidenceIds).filter(
      (id): id is string => typeof id === "string",
    );
    const files = ids
      .map((id) => evidenceById.get(id))
      .map((item) => item && safeString(item.path ?? item.location))
      .filter((path): path is string => Boolean(path));
    const attention = safeString(item.attention, "medium");
    return {
      id: safeString(item.id, `change-${index + 1}`),
      title: safeString(item.title, `Change group ${index + 1}`),
      description: safeString(
        item.summary ?? item.description,
        "No group summary provided.",
      ),
      attention: (attention === "high" || attention === "low"
        ? attention
        : "medium") as ChangeGroup["attention"],
      files,
      before: safeString(
        item.previousBehavior ?? item.before,
        "Previous behavior is not specified.",
      ),
      after: safeString(
        item.newBehavior ?? item.after,
        "New behavior is not specified.",
      ),
      rationale: safeString(
        item.motivation ?? item.rationale,
        "The walkthrough did not provide a motivation.",
      ),
      reviewed: false,
      evidenceIds: ids,
    };
  });
  const order = new Map(
    safeArray(document.walkthrough).map((raw, index) => {
      const item = objectValue(raw);
      return [safeString(item.changeGroupId), index];
    }),
  );
  rawGroups.sort(
    (a, b) =>
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const graphs = document.graphs ?? {};
  const flows = (
    ["systemOverview", "dataFlow", "codeDependency", "userAction"] as const
  ).map((key) => {
    const graph = objectValue(graphs)[key] as ContractGraph | undefined;
    const fallbackId =
      key === "systemOverview"
        ? "system-overview"
        : key === "dataFlow"
          ? "data-flow"
          : key === "codeDependency"
            ? "code-dependency"
            : "user-action";
    const neutralFallback: Flow = {
      id: fallbackId,
      type: fallbackId,
      title:
        key === "systemOverview"
          ? "System overview"
          : key === "dataFlow"
            ? "Data flow"
            : key === "codeDependency"
              ? "Code dependency"
              : "User action",
      description: "No graph details were provided by this walkthrough.",
      nodes: [],
      edges: [],
      guidedTours: [],
    };
    return mapGraph(graph, neutralFallback);
  });
  const tests = safeArray(document.tests).map((raw, index) => {
    const item = objectValue(raw);
    return {
      id: safeString(item.id, `test-${index + 1}`),
      test: safeString(item.title ?? item.name, `Test ${index + 1}`),
      behavior: safeString(
        item.behavior ?? item.description,
        "Behavior mapping not specified.",
      ),
      status: (safeString(item.status, "missing") === "covered"
        ? "covered"
        : safeString(item.status, "") === "partial"
          ? "partial"
          : "missing") as TestMapping["status"],
      evidenceIds: safeArray(item.evidenceIds).filter(
        (id): id is string => typeof id === "string",
      ),
      changeGroupIds: safeArray(item.changeGroupIds).filter(
        (id): id is string => typeof id === "string",
      ),
      evidence: evidenceLocation(
        safeArray(item.evidenceIds)[0],
        "No evidence linked",
      ),
    };
  });
  const nullableString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null;
  const nullableLine = (value: unknown) =>
    Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
  const threads = safeArray(document.reviewThreads).flatMap((raw, index) => {
    const item = objectValue(raw);
    const status = safeString(item.status, "active").toLowerCase();
    if (status === "absent" || status === "none") return [];
    const evidenceId = safeArray(item.evidenceIds)[0];
    const evidenceItem =
      typeof evidenceId === "string" ? evidenceById.get(evidenceId) : undefined;
    const path =
      nullableString(item.path) ??
      (evidenceItem
        ? nullableString(evidenceItem.path ?? evidenceItem.location)
        : null);
    const author = safeString(item.author ?? item.user, "Review participant");
    const provenance = safeString(item.provenance, "human");
    const state = (
      [
        "active",
        "open",
        "resolved",
        "outdated",
        "disputed",
        "dismissed",
        "informational",
        "unknown",
      ].includes(status)
        ? status
        : "active"
    ) as ReviewState;
    const replies = safeArray(item.replies).map(
      (rawReply, replyIndex): ReviewReply => {
        const reply = objectValue(rawReply);
        const replyAuthor = safeString(
          reply.author ?? reply.user,
          "Review participant",
        );
        return {
          id: safeString(
            reply.id,
            `thread-${index + 1}-reply-${replyIndex + 1}`,
          ),
          author: replyAuthor,
          initials: initialsFor(replyAuthor),
          body: safeString(reply.body, "Reply content is not specified."),
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
      },
    );
    const replyCount =
      Number.isInteger(item.replyCount) && Number(item.replyCount) >= 0
        ? Number(item.replyCount)
        : replies.length;
    return [
      {
        id: safeString(item.id, `thread-${index + 1}`),
        author,
        initials: initialsFor(author),
        body: safeString(
          item.body ?? item.summary,
          "Review thread content is not specified.",
        ),
        state,
        provenance,
        evidenceIds: safeArray(item.evidenceIds).filter(
          (id): id is string => typeof id === "string",
        ),
        authorAssociation: nullableString(item.authorAssociation),
        createdAt: nullableString(item.createdAt),
        updatedAt: nullableString(item.updatedAt),
        url: nullableString(item.url),
        resolvedBy: nullableString(item.resolvedBy),
        path,
        file: path ?? "Repository evidence",
        line:
          nullableLine(item.line) ??
          (evidenceItem ? nullableLine(evidenceItem.line) : null),
        originalLine: nullableLine(item.originalLine),
        side: nullableString(item.side),
        startLine: nullableLine(item.startLine),
        originalStartLine: nullableLine(item.originalStartLine),
        commitSha: nullableString(item.commitSha),
        originalCommitSha: nullableString(item.originalCommitSha),
        replies,
        replyCount,
        changeGroupIds: safeArray(item.changeGroupIds).filter(
          (id): id is string => typeof id === "string",
        ),
        graphNodeIds: safeArray(item.graphNodeIds).filter(
          (id): id is string => typeof id === "string",
        ),
        reviewInsightIds: safeArray(item.reviewInsightIds).filter(
          (id): id is string => typeof id === "string",
        ),
        source: (provenance === "automated"
          ? "bot"
          : "human") as ReviewThread["source"],
      },
    ];
  });
  const insights = safeArray(document.reviewInsights).map((raw, index) => {
    const item = objectValue(raw);
    const status = safeString(item.status, "active");
    return {
      id: safeString(item.id, `insight-${index + 1}`),
      title: safeString(item.title, `Review insight ${index + 1}`),
      detail: safeString(
        item.detail ?? item.summary,
        "No additional review insight detail provided.",
      ),
      provenance:
        safeString(item.provenance, "automated") === "human"
          ? "human"
          : "automated",
      state: (["resolved", "outdated", "disputed"].includes(status)
        ? status
        : "active") as ReviewState,
      location: evidenceLocation(
        safeArray(item.evidenceIds)[0],
        "Repository evidence",
      ),
      count: Math.max(1, safeArray(item.reviewThreadIds).length),
    } as ReviewInsight;
  });
  const runProvider = safeString(document.run?.provider).toLowerCase();
  const analysisProvenance: PullRequest["analysisProvenance"] =
    provider === "claude" || provider === "codex" || provider === "cursor"
      ? provider
      : runProvider === "claude" ||
          runProvider === "codex" ||
          runProvider === "cursor"
        ? runProvider
        : "claude";
  return {
    ...pr,
    groups: rawGroups,
    insights,
    flows,
    tests,
    evidence,
    threads,
    summary: safeString(
      document.summary?.intent,
      "Walkthrough loaded from the validated provider artifact.",
    ),
    analysisProvenance,
    walkthrough: document,
  };
}

export function matchesRelationshipFilter(
  pr: PullRequest,
  filter: Filter,
): boolean {
  if (filter === "mine") return pr.authoredByViewer === true;
  if (filter === "review") return pr.reviewRequested === true;
  if (filter === "reviewed") return pr.reviewedByViewer === true;
  return true;
}

export function calculateFitZoom(
  surfaceWidth: number,
  surfaceHeight: number,
  viewportWidth = 700,
  viewportHeight = 360,
): number {
  return Math.max(
    MIN_GRAPH_ZOOM,
    Math.min(
      120,
      Math.floor(
        Math.min(
          viewportWidth / Math.max(1, surfaceWidth),
          viewportHeight / Math.max(1, surfaceHeight),
        ) * 100,
      ),
    ),
  );
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function readAnalysisConfig(): AnalysisRunConfig {
  const saved = readStored<Partial<AnalysisRunConfig>>(ANALYSIS_CONFIG_STORAGE_KEY, {});
  return {
    ...DEFAULT_ANALYSIS_RUN_CONFIG,
    ...saved,
    scanMode: saved.scanMode === "legacy" ? "legacy" : "coordinator",
  };
}

function StatusPill({ status }: { status: PRStatus }) {
  const meta = statusMeta[status];
  return (
    <span className={`status-pill ${meta.tone}`}>
      <span className="status-dot" />
      {meta.label}
    </span>
  );
}

function Avatar({
  initials,
  className = "",
  label,
}: {
  initials: string;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={`avatar ${className}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    >
      {initials}
    </span>
  );
}

function UpdateProgressIndicator({
  version,
  progress,
}: {
  version: string;
  progress: UpdateDownloadProgress | null;
}) {
  const downloadedBytes =
    Number.isFinite(progress?.downloadedBytes) &&
    Number(progress?.downloadedBytes) >= 0
      ? Math.floor(Number(progress?.downloadedBytes))
      : 0;
  const totalBytes =
    Number.isFinite(progress?.totalBytes) && Number(progress?.totalBytes) > 0
      ? Math.floor(Number(progress?.totalBytes))
      : undefined;
  const calculatedPercent = totalBytes
    ? Math.floor((downloadedBytes / totalBytes) * 100)
    : undefined;
  const percent = totalBytes
    ? Math.max(
        0,
        Math.min(
          100,
          Number.isFinite(progress?.percent)
            ? Math.floor(Number(progress?.percent))
            : (calculatedPercent ?? 0),
        ),
      )
    : undefined;
  const byteLabel = totalBytes
    ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`
    : `${formatBytes(downloadedBytes)} downloaded`;
  const valueText =
    percent === undefined ? byteLabel : `${percent}% · ${byteLabel}`;
  return (
    <div
      className="update-progress"
      role="progressbar"
      aria-label={`Downloading update ${version}`}
      aria-valuemin={percent === undefined ? undefined : 0}
      aria-valuemax={percent === undefined ? undefined : 100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
    >
      <div className="update-progress-meta">
        <strong>{percent === undefined ? "Downloading" : `${percent}%`}</strong>
        <span>{byteLabel}</span>
      </div>
      <div
        className={`update-progress-track ${percent === undefined ? "indeterminate" : ""}`}
        aria-hidden="true"
      >
        <span
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function App() {
  const api = liveApi();
  const electronMode = Boolean(api);
  const [hasStoredRepositorySelection] = useState(
    () => localStorage.getItem("atlas:selected-repo") !== null,
  );
  const [selectedRepo, setSelectedRepo] = useState(() =>
    readStored("atlas:selected-repo", "atlas"),
  );
  const [filter, setFilter] = useState<Filter>(() =>
    readStored("atlas:filter", "all"),
  );
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(() =>
    readStored("atlas:selected-pr", "atlas-482"),
  );
  const [view, setView] = useState<View>("overview");
  const [flowType, setFlowType] = useState<Flow["type"]>("system-overview");
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(
    null,
  );
  const [reviewed, setReviewed] = useState<Record<string, boolean>>(() =>
    readStored("atlas:reviewed", {}),
  );
  const [analysis, setAnalysis] = useState<{
    id: string;
    runId?: string;
    stage: number;
    running: boolean;
    startedAt: number;
    live?: boolean;
    provider?: AgentProvider;
    scanMode?: AnalysisRunConfig["scanMode"];
    activity: AnalysisProgressEvent[];
  } | null>(null);
  const [analysisDone, setAnalysisDone] = useState<Record<string, boolean>>({});
  const [account, setAccount] = useState<AccountState>({
    label: "Local fixture",
    detail: "GitHub CLI not connected in browser preview",
    live: false,
    initials: "PA",
    avatarLabel: "PR Atlas demo account",
  });
  const [liveRepositories, setLiveRepositories] = useState<Repository[]>([]);
  const [livePRs, setLivePRs] = useState<Record<string, PullRequest[]>>({});
  const [liveRuns, setLiveRuns] = useState<
    Record<string, AnalysisRunSummary[]>
  >({});
  const [liveDocuments, setLiveDocuments] = useState<
    Record<string, WalkthroughDocument>
  >({});
  const [commentResources, setCommentResources] = useState<
    Record<string, CommentResource>
  >({});
  const [commentReloads, setCommentReloads] = useState<Record<string, number>>(
    {},
  );
  const commentWriteVersionsRef = useRef<Record<string, number>>({});
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [confirmLiveAnalysis, setConfirmLiveAnalysis] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState<PRStatus | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [systemTheme, setSystemTheme] =
    useState<ResolvedTheme>(readSystemTheme);
  const resolvedTheme: ResolvedTheme =
    themeMode === "system" ? systemTheme : themeMode;
  const [providers, setProviders] = useState<AgentInstallationStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const providerStatusesRef = useRef<AgentInstallationStatus[]>([]);
  const providerLoadRef = useRef<Promise<AgentInstallationStatus[]> | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateDownloadState, setUpdateDownloadState] =
    useState<UpdateDownloadState>("idle");
  const updateDownloadStateRef = useRef<UpdateDownloadState>("idle");
  const updateCheckSequenceRef = useRef(0);
  const [updateDownloadError, setUpdateDownloadError] = useState("");
  const [updateDownloadProgress, setUpdateDownloadProgress] =
    useState<UpdateDownloadProgress | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(
    () => readProviderPreference() ?? AGENT_PROVIDER_PRIORITY[0],
  );
  const [selectedModels, setSelectedModels] = useState<
    Partial<Record<AgentProvider, string>>
  >(() => readStored(MODEL_STORAGE_KEY, {}));
  const [selectedEfforts, setSelectedEfforts] = useState<
    Partial<Record<AgentProvider, AnalysisEffort>>
  >(readEffortPreferences);
  const [customPrompt, setCustomPrompt] = useState("");
  const [analysisConfig, setAnalysisConfig] = useState<AnalysisRunConfig>(readAnalysisConfig);
  const [retentionSettings, setRetentionSettings] =
    useState<RunRetentionSettings>(DEFAULT_RETENTION_SETTINGS);
  const [stepProgress, setStepProgress] = useState<
    Record<string, ReviewProgress>
  >({});
  const [evidenceDetail, setEvidenceDetail] = useState<EvidenceDetail | null>(
    null,
  );
  const evidenceDrawerRef = useRef<HTMLElement>(null);
  const [analysisDiagnostics, setAnalysisDiagnostics] =
    useState<AnalysisDiagnostics | null>(null);
  const [diagnosticExportMessage, setDiagnosticExportMessage] = useState("");
  const selectedProviderStatus = providers.find(
    (status) => status.provider === selectedProvider,
  );
  const providerIsActive =
    !electronMode || Boolean(selectedProviderStatus?.installed);
  const activeProviderName = !electronMode
    ? "Demo runtime"
    : selectedProviderStatus?.installed
      ? selectedProviderStatus.displayName
      : "No provider available";
  const providerIndicatorLabel = providerIsActive
    ? activeProviderName
    : providersLoading
      ? "Detecting providers…"
      : providerError
        ? "Provider detection failed"
        : "No provider available";
  const providerIndicatorAria = providerIsActive
    ? `Active provider: ${activeProviderName}`
    : `Provider status: ${providerIndicatorLabel}`;

  useEffect(() => {
    localStorage.setItem("atlas:selected-repo", JSON.stringify(selectedRepo));
  }, [selectedRepo]);
  useEffect(() => {
    localStorage.setItem("atlas:filter", JSON.stringify(filter));
  }, [filter]);
  useEffect(() => {
    localStorage.setItem("atlas:selected-pr", JSON.stringify(selectedId));
  }, [selectedId]);
  useEffect(() => {
    localStorage.setItem("atlas:reviewed", JSON.stringify(reviewed));
  }, [reviewed]);
  useEffect(() => {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selectedModels));
  }, [selectedModels]);
  useEffect(() => {
    localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify(selectedEfforts));
  }, [selectedEfforts]);
  useEffect(() => {
    localStorage.setItem(
      ANALYSIS_CONFIG_STORAGE_KEY,
      JSON.stringify(analysisConfig),
    );
  }, [analysisConfig]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        evidenceDetail &&
        evidenceDrawerRef.current &&
        !evidenceDrawerRef.current.contains(target)
      )
        setEvidenceDetail(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmLiveAnalysis) setConfirmLiveAnalysis(false);
      setEvidenceDetail(null);
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmLiveAnalysis, evidenceDetail, settingsOpen]);
  useEffect(() => {
    if (!api?.getRetentionSettings) return;
    void api
      .getRetentionSettings()
      .then(setRetentionSettings)
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    if (
      themeMode !== "system" ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) =>
      setSystemTheme(event.matches ? "dark" : "light");
    setSystemTheme(media.matches ? "dark" : "light");
    if (typeof media.addEventListener === "function")
      media.addEventListener("change", onChange);
    else media.addListener?.(onChange);
    return () => {
      if (typeof media.removeEventListener === "function")
        media.removeEventListener("change", onChange);
      else media.removeListener?.(onChange);
    };
  }, [themeMode]);

  const chooseTheme = (next: ThemeMode) => {
    setThemeMode(next);
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next));
  };
  const chooseProvider = (next: AgentProvider) => {
    if (
      electronMode &&
      !providers.find((status) => status.provider === next)?.installed
    )
      return;
    setSelectedProvider(next);
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next));
  };
  const applyProviderStatuses = (statuses: AgentInstallationStatus[]) => {
    const priority = new Map(
      AGENT_PROVIDER_PRIORITY.map((provider, index) => [provider, index]),
    );
    const previousByProvider = new Map(
      providerStatusesRef.current.map((status) => [status.provider, status]),
    );
    const orderedStatuses = statuses.map((status) => {
      const previous = previousByProvider.get(status.provider);
      // Model discovery is a convenience command exposed by external CLIs.
      // Keep a known-good list through a transient empty response while the
      // provider itself is still installed, instead of making the selector
      // disappear after it has already been usable.
      if (
        status.installed &&
        !status.models?.length &&
        previous?.installed &&
        previous.models?.length
      )
        return { ...status, models: previous.models };
      return status;
    }).sort(
      (left, right) =>
        (priority.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.provider) ?? Number.MAX_SAFE_INTEGER),
    );
    providerStatusesRef.current = orderedStatuses;
    setProviders(orderedStatuses);
    setProviderError(null);
    setSelectedModels((current) => {
      const next = { ...current };
      for (const status of orderedStatuses) {
        const models = status.models ?? [];
        if (!models.length) {
          delete next[status.provider];
          continue;
        }
        if (!models.some((model) => model.id === next[status.provider]))
          next[status.provider] = (
            models.find((model) => model.isDefault) ?? models[0]
          ).id;
      }
      return next;
    });
    setSelectedProvider((current) => {
      if (
        orderedStatuses.some(
          (status) => status.provider === current && status.installed,
        )
      )
        return current;
      const fallback = orderedStatuses.find((status) => status.installed);
      return fallback?.provider ?? current;
    });
  };
  const loadProviders = () => {
    const currentApi = api;
    if (!currentApi || providerLoadRef.current) return;
    setProvidersLoading(true);
    const load = currentApi.listProviders!();
    providerLoadRef.current = load;
    void load
      .then(applyProviderStatuses)
      .catch((error: unknown) =>
        setProviderError(
          error instanceof Error
            ? error.message
            : "Could not detect analysis providers.",
        ),
      )
      .finally(() => {
        if (providerLoadRef.current !== load) return;
        providerLoadRef.current = null;
        setProvidersLoading(false);
      });
  };
  useEffect(() => {
    if (!api) return;
    loadProviders();
    setLiveLoading(true);
    void api
      .bootstrap()
      .then((result: BootstrapResult) => {
        setAccount(accountFromBootstrap(result));
        const discoveredRepositories = result.repositories.map(mapRepository);
        setLiveRepositories(discoveredRepositories);
        setSelectedRepo((current) =>
          hasStoredRepositorySelection &&
          discoveredRepositories.some((repo) => repo.id === current)
            ? current
            : (discoveredRepositories[0]?.id ?? ""),
        );
        setLiveError(result.warnings.length ? result.warnings.join(" ") : null);
      })
      .catch((error: unknown) => {
        setAccount({
          label: "GitHub CLI offline",
          detail:
            "Could not load GitHub discovery. Retry after checking GitHub CLI authentication.",
          live: false,
          initials: "GH",
          avatarLabel: "GitHub CLI offline",
        });
        setLiveError(
          error instanceof Error
            ? error.message
            : "Could not load GitHub discovery.",
        );
      })
      .finally(() => setLiveLoading(false));
  }, [api, hasStoredRepositorySelection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api?.checkForUpdate) return;
    let cancelled = false;
    const sequence = ++updateCheckSequenceRef.current;
    void api
      .checkForUpdate()
      .then((result) => {
        if (
          !cancelled &&
          sequence === updateCheckSequenceRef.current &&
          updateDownloadStateRef.current !== "downloading"
        ) {
          setUpdateInfo(result);
          updateDownloadStateRef.current = "idle";
          setUpdateDownloadState("idle");
          setUpdateDownloadError("");
          setUpdateDownloadProgress(null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api?.subscribeUpdateDownloadProgress) return;
    return api.subscribeUpdateDownloadProgress((progress) =>
      setUpdateDownloadProgress(progress),
    );
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeAnalysisProgress((event: AnalysisProgressEvent) => {
      setAnalysisMessage(event.message);
      setAnalysis((current) =>
        current &&
        (current.runId === event.runId ||
          (current.live && current.id === selectedId))
          ? {
              ...current,
              runId: event.runId,
              stage:
                event.stage === "complete"
                  ? analysisStages.length - 1
                  : ["anchoring", "walkthrough", "tests-risks", "flows"].includes(event.stage)
                    ? 3
                    : event.stage === "assembling"
                      ? 4
                  : Math.max(
                      0,
                      [
                        "preparing",
                        "collecting",
                        "inspecting",
                        "generating",
                        "validating",
                        "complete",
                      ].indexOf(event.stage),
                    ),
              message: event.message,
              activity: current.activity.some(
                (item) =>
                  item.timestamp === event.timestamp &&
                  item.message === event.message,
              )
                ? current.activity
                : [...current.activity, event].slice(-30),
            }
          : current,
      );
    });
  }, [api, selectedId]);

  const allRepositories = useMemo(
    () => (electronMode ? liveRepositories : repositories),
    [electronMode, liveRepositories],
  );
  const visibleRepositories = useMemo(() => {
    const needle = repositoryQuery.trim().toLowerCase();
    return allRepositories.filter(
      (repo) =>
        !needle ||
        repo.id === selectedRepo ||
        `${repo.owner}/${repo.name} ${repo.fullName ?? ""}`
          .toLowerCase()
          .includes(needle),
    );
  }, [allRepositories, repositoryQuery, selectedRepo]);
  const selectedRepository =
    allRepositories.find((repo) => repo.id === selectedRepo) ??
    (electronMode ? undefined : repositories[0]);
  const isLiveRepository = selectedRepository?.source === "github";
  const repoPRs = useMemo(
    () =>
      !selectedRepository
        ? []
        : isLiveRepository
          ? (livePRs[selectedRepository.id] ?? [])
          : pullRequests.filter((pr) => pr.repositoryId === selectedRepo),
    [isLiveRepository, livePRs, selectedRepository, selectedRepo],
  );

  useEffect(() => {
    if (
      !api ||
      !selectedRepository ||
      !isLiveRepository ||
      !selectedRepository.fullName ||
      livePRs[selectedRepository.id]
    )
      return;
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    void api
      .listPullRequests(selectedRepository.fullName)
      .then(async (dtos) => {
        if (cancelled) return;
        const mapped = dtos.map((dto) => emptyLivePR(dto, selectedRepository));
        setLivePRs((current) => ({
          ...current,
          [selectedRepository.id]: mapped,
        }));
        await Promise.all(
          mapped.map(async (pr) => {
            try {
              const runs = await api.listAnalysisRuns(
                selectedRepository.fullName!,
                pr.number,
                pr.headSha,
              );
              if (cancelled) return;
              setLiveRuns((current) => ({ ...current, [pr.id]: runs }));
              const currentReady = runs.find(
                (run) => run.status === "ready" && !run.outdated,
              );
              const latest = runs[0];
              let next: PullRequest = {
                ...pr,
                status:
                  latest?.status === "failed" || latest?.status === "invalid"
                    ? "failed"
                    : latest?.status === "cancelled"
                      ? "cancelled"
                      : latest?.outdated
                        ? "outdated"
                        : "unprocessed",
                analyzedSha: latest?.headSha,
                analysisDiagnostic: latest?.error?.message,
                history: runs.map((run) => ({
                  id: run.runId,
                  date: relativeDate(run.createdAt),
                  duration: "—",
                  status: run.status === "ready" ? "completed" : run.status,
                  provider: run.provider,
                  model: run.model ?? "Tool default",
                  schemaVersion: run.schemaVersion,
                  skillVersion: run.skillContractVersion,
                  statusLabel: run.error?.message,
                })) as PullRequest["history"],
              };
              if (currentReady) {
                const result = await api.loadAnalysisRun(
                  selectedRepository.fullName!,
                  pr.number,
                  currentReady.runId,
                );
                if (result?.status === "ready" && result.document) {
                  setLiveDocuments((current) => ({
                    ...current,
                    [pr.id]: result.document!,
                  }));
                  next = {
                    ...mapWalkthroughDocument(
                      result.document,
                      next,
                      currentReady?.provider,
                    ),
                    status: "ready",
                    evidenceHeadSha: currentReady.headSha,
                  };
                } else
                  next = {
                    ...next,
                    status: "failed",
                    analysisDiagnostic:
                      "Saved walkthrough failed strict validation. Run analysis again.",
                  };
              }
              setLivePRs((current) => ({
                ...current,
                [selectedRepository.id]: (
                  current[selectedRepository.id] ?? []
                ).map((item) => (item.id === pr.id ? next : item)),
              }));
            } catch (error) {
              if (!cancelled)
                setLiveError(
                  error instanceof Error
                    ? error.message
                    : "Could not load analysis history.",
                );
            }
          }),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLiveError(
            error instanceof Error
              ? error.message
              : "Could not load pull requests.",
          );
      })
      .finally(() => {
        if (!cancelled) setLiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, isLiveRepository, selectedRepository]);

  useEffect(() => {
    if (repoPRs.length && !repoPRs.some((pr) => pr.id === selectedId))
      setSelectedId(repoPRs[0].id);
  }, [repoPRs, selectedId]);
  const visiblePRs = useMemo(
    () =>
      repoPRs.filter((pr) => {
        const matchesStatus =
          filter === "all" ||
          ((
            [
              "ready",
              "processing",
              "unprocessed",
              "outdated",
              "failed",
            ] as PRStatus[]
          ).includes(filter as PRStatus) &&
            pr.status === filter);
        const matchesRelationship = matchesRelationshipFilter(pr, filter);
        const haystack =
          `${pr.title} ${pr.number} ${pr.author} ${pr.branch}`.toLowerCase();
        return (
          matchesStatus &&
          matchesRelationship &&
          haystack.includes(query.toLowerCase())
        );
      }),
    [repoPRs, filter, query, reviewed],
  );
  const baseSelectedPR =
    repoPRs.find((pr) => pr.id === selectedId) ??
    repoPRs[0] ??
    (electronMode || isLiveRepository ? null : pullRequests[0]);
  const fixtureReadyPR =
    pullRequests.find((pr) => pr.status === "ready" && pr.groups.length > 0) ??
    pullRequests[0];
  const liveDocument =
    baseSelectedPR?.source === "github"
      ? liveDocuments[baseSelectedPR.id]
      : undefined;
  const selectedPR = !baseSelectedPR
    ? null
    : liveDocument
      ? mapWalkthroughDocument(
          liveDocument,
          baseSelectedPR,
          baseSelectedPR.analysisProvenance,
        )
      : baseSelectedPR.source === "fixture" &&
          analysisDone[baseSelectedPR.id] &&
          (baseSelectedPR.groups.length === 0 ||
            baseSelectedPR.status === "outdated")
        ? {
            ...baseSelectedPR,
            status: "ready" as const,
            groups: fixtureReadyPR.groups,
            insights: fixtureReadyPR.insights,
            flows: fixtureReadyPR.flows,
            tests: fixtureReadyPR.tests,
            threads: fixtureReadyPR.threads,
            evidence: fixtureReadyPR.evidence,
            history: [
              ...baseSelectedPR.history,
              {
                id: `${baseSelectedPR.id}-local`,
                date: "Just now",
                duration: "3m 12s",
                status: "completed" as const,
                model: "Codex local",
              },
            ],
          }
        : baseSelectedPR;
  const largePRNotice = selectedPR
    ? analysisDurationNotice(selectedPR)
    : null;
  const selectedCommentResource = selectedPR
    ? (commentResources[selectedPR.id] ?? emptyCommentResource())
    : emptyCommentResource();
  const selectedCommentReload = selectedPR
    ? (commentReloads[selectedPR.id] ?? 0)
    : 0;

  useEffect(() => {
    if (
      !api ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName
    )
      return;
    const key = selectedPR.id;
    const repository = selectedPR.repositoryFullName;
    const pullNumber = selectedPR.number;
    const writeVersion = commentWriteVersionsRef.current[key] ?? 0;
    let cancelled = false;
    setCommentResources((current) => {
      const previous = current[key] ?? emptyCommentResource();
      return {
        ...current,
        [key]: { ...previous, status: "loading", error: null },
      };
    });
    void api
      .listPullRequestComments(repository, pullNumber)
      .then((comments) => {
        if (
          cancelled ||
          (commentWriteVersionsRef.current[key] ?? 0) !== writeVersion
        )
          return;
        setCommentResources((current) => {
          const previous = current[key] ?? emptyCommentResource();
          return {
            ...current,
            [key]: {
              ...previous,
              status: "ready",
              comments: orderPullRequestComments(comments),
              error: null,
            },
          };
        });
      })
      .catch(() => {
        if (
          cancelled ||
          (commentWriteVersionsRef.current[key] ?? 0) !== writeVersion
        )
          return;
        setCommentResources((current) => {
          const previous = current[key] ?? emptyCommentResource();
          return {
            ...current,
            [key]: {
              ...previous,
              status: "error",
              error: "Could not load pull request comments. Try again.",
            },
          };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    selectedPR?.id,
    selectedPR?.repositoryFullName,
    selectedPR?.number,
    selectedCommentReload,
  ]);

  const refreshSelectedComments = () => {
    if (!selectedPR || selectedPR.source !== "github") return;
    setCommentReloads((current) => ({
      ...current,
      [selectedPR.id]: (current[selectedPR.id] ?? 0) + 1,
    }));
  };

  const postSelectedComment = async (body: string): Promise<boolean> => {
    if (
      !api ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName
    )
      return false;
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 65_536) return false;
    const key = selectedPR.id;
    const repository = selectedPR.repositoryFullName;
    const pullNumber = selectedPR.number;
    setCommentResources((current) => {
      const previous = current[key] ?? emptyCommentResource();
      return {
        ...current,
        [key]: {
          ...previous,
          posting: true,
          postError: null,
          successMessage: null,
        },
      };
    });
    try {
      const comment = await api.createPullRequestComment(
        repository,
        pullNumber,
        trimmed,
      );
      commentWriteVersionsRef.current[key] =
        (commentWriteVersionsRef.current[key] ?? 0) + 1;
      setCommentResources((current) => {
        const previous = current[key] ?? emptyCommentResource();
        const comments = previous.comments.some(
          (candidate) => candidate.id === comment.id,
        )
          ? previous.comments.map((candidate) =>
              candidate.id === comment.id ? comment : candidate,
            )
          : [...previous.comments, comment];
        return {
          ...current,
          [key]: {
            ...previous,
            status: "ready",
            comments: orderPullRequestComments(comments),
            posting: false,
            postError: null,
            successMessage: "Comment published on GitHub.",
          },
        };
      });
      return true;
    } catch {
      setCommentResources((current) => {
        const previous = current[key] ?? emptyCommentResource();
        return {
          ...current,
          [key]: {
            ...previous,
            posting: false,
            postError:
              "Could not publish this comment. Check your GitHub access and try again.",
            successMessage: null,
          },
        };
      });
      return false;
    }
  };

  useEffect(() => {
    const runId = selectedPR?.walkthrough?.run.id;
    if (
      !api ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName ||
      !runId ||
      !api.getReviewProgress
    )
      return;
    let cancelled = false;
    void api
      .getReviewProgress(
        selectedPR.repositoryFullName,
        selectedPR.number,
        runId,
      )
      .then((items) => {
        if (!cancelled)
          setStepProgress((current) => ({
            ...current,
            ...Object.fromEntries(
              items.map((item) => [`${item.runId}:${item.stepId}`, item]),
            ),
          }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, selectedPR?.id, selectedPR?.walkthrough?.run.id]);

  useEffect(() => {
    const failedRun = (
      selectedPR && liveRuns[selectedPR.id] ? liveRuns[selectedPR.id] : []
    ).find((run) => run.status !== "ready");
    if (
      !api?.loadAnalysisDiagnostics ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName ||
      !failedRun
    ) {
      setAnalysisDiagnostics(null);
      return;
    }
    let cancelled = false;
    void api
      .loadAnalysisDiagnostics(
        selectedPR.repositoryFullName,
        selectedPR.number,
        failedRun.runId,
      )
      .then((diagnostics) => {
        if (!cancelled) {
          setAnalysisDiagnostics(diagnostics);
          setDiagnosticExportMessage("");
        }
      })
      .catch(() => {
        if (!cancelled) setAnalysisDiagnostics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    selectedPR?.id,
    selectedPR?.repositoryFullName,
    selectedPR?.number,
    liveRuns,
  ]);

  useEffect(() => {
    if (selectedPR && selectedPR.repositoryId !== selectedRepo)
      setSelectedId(repoPRs[0]?.id ?? pullRequests[0].id);
  }, [selectedRepo]); // eslint-disable-line react-hooks/exhaustive-deps

  const runLiveAnalysis = async () => {
    const provider = selectedProviderStatus?.provider;
    if (
      !api ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName ||
      analysis?.running
    )
      return;
    if (!provider || !selectedProviderStatus?.installed) {
      setConfirmLiveAnalysis(false);
      setSettingsOpen(true);
      setAnalysisMessage(
        "Select an installed analysis provider before starting.",
      );
      return;
    }
    setConfirmLiveAnalysis(false);
    setView("walkthrough");
    setAnalysisMessage(
      `Preparing ${selectedProviderStatus.displayName} analysis…`,
    );
    setAnalysisStatus("processing");
    setAnalysis({
      id: selectedPR.id,
      stage: 0,
      running: true,
      startedAt: Date.now(),
      live: true,
      provider,
      scanMode: analysisConfig.scanMode,
      activity: [],
    });
    let result: AnalysisRunResult;
    try {
      const model = selectedModels[provider];
      const effort = selectedEfforts[provider] ?? DEFAULT_ANALYSIS_EFFORT;
      const supplemental = customPrompt.trim();
      result = await api.startAnalysis({
        repository: selectedPR.repositoryFullName,
        pullNumber: selectedPR.number,
        baseSha: selectedPR.baseSha,
        headSha: selectedPR.headSha,
        provider,
        config: analysisConfig,
        ...(model ? { model } : {}),
        effort,
        ...(supplemental ? { customPrompt: supplemental } : {}),
      });
    } catch (error) {
      setAnalysisStatus("failed");
      setAnalysisMessage(
        error instanceof Error ? error.message : "Analysis request failed.",
      );
      setAnalysis((current) =>
        current ? { ...current, running: false } : current,
      );
      return;
    }
    setAnalysis((current) =>
      current
        ? {
            ...current,
            runId: result.runId,
            running: false,
            stage: analysisStages.length - 1,
            provider,
          }
        : current,
    );
    if (result.status === "ready" && result.document) {
      setLiveDocuments((current) => ({
        ...current,
        [selectedPR.id]: result.document!,
      }));
      setAnalysisStatus("ready");
      setAnalysisMessage("Walkthrough is ready.");
      setLiveRuns((current) => ({
        ...current,
        [selectedPR.id]: [
          { ...result.manifest, artifactDirectory: result.artifactDirectory },
          ...(current[selectedPR.id] ?? []).filter(
            (run) => run.runId !== result.runId,
          ),
        ],
      }));
      setLivePRs((current) => ({
        ...current,
        [selectedPR.repositoryId]: (current[selectedPR.repositoryId] ?? []).map(
          (pr) =>
            pr.id === selectedPR.id
              ? {
                  ...mapWalkthroughDocument(
                    result.document!,
                    pr,
                    result.manifest.provider,
                  ),
                  status: "ready",
                  analysisProvenance: result.manifest.provider,
                  analyzedSha: result.manifest.headSha,
                  evidenceHeadSha: result.manifest.headSha,
                  history: [
                    {
                      id: result.runId,
                      date: "Just now",
                      duration: "—",
                      status: "completed" as const,
                      provider: result.manifest.provider,
                      model:
                        result.manifest.model ??
                        result.document!.run.model ??
                        "Tool default",
                      schemaVersion: result.manifest.schemaVersion,
                      skillVersion: result.manifest.skillContractVersion,
                    },
                    ...pr.history,
                  ],
                }
              : pr,
        ),
      }));
    } else {
      const status: PRStatus =
        result.status === "cancelled" ? "cancelled" : "failed";
      const historyStatus =
        result.status === "ready" ? "invalid" : result.status;
      setAnalysisStatus(status);
      setAnalysisMessage(result.error?.message ?? `Analysis ${result.status}.`);
      setLiveRuns((current) => ({
        ...current,
        [selectedPR.id]: [
          { ...result.manifest, artifactDirectory: result.artifactDirectory },
          ...(current[selectedPR.id] ?? []).filter(
            (run) => run.runId !== result.runId,
          ),
        ],
      }));
      setLivePRs((current) => ({
        ...current,
        [selectedPR.repositoryId]: (current[selectedPR.repositoryId] ?? []).map(
          (pr) =>
            pr.id === selectedPR.id
              ? {
                  ...pr,
                  status,
                  analysisDiagnostic: result.error?.message,
                  history: [
                    {
                      id: result.runId,
                      date: "Just now",
                      duration: "—",
                      status: historyStatus,
                      provider: result.manifest.provider,
                      model: result.manifest.model ?? "Tool default",
                      schemaVersion: result.manifest.schemaVersion,
                      skillVersion: result.manifest.skillContractVersion,
                      statusLabel: result.error?.message,
                    },
                    ...pr.history.filter((run) => run.id !== result.runId),
                  ],
                }
              : pr,
        ),
      }));
    }
  };

  const startAnalysis = () => {
    if (!selectedPR || analysis?.running) return;
    if (selectedPR.source === "github") {
      if (providersLoading || !providers.length) {
        setSettingsOpen(true);
        setAnalysisMessage("Detecting installed analysis providers…");
        return;
      }
      if (!selectedProviderStatus?.installed) {
        setSettingsOpen(true);
        setAnalysisMessage(
          "Select an installed analysis provider before starting.",
        );
        return;
      }
      setConfirmLiveAnalysis(true);
      return;
    }
    setView("walkthrough");
    setAnalysis({
      id: selectedPR.id,
      stage: 0,
      running: true,
      live: false,
      startedAt: Date.now(),
      activity: [],
    });
  };

  const selectPullRequest = (pr: PullRequest) => {
    setSelectedId(pr.id);
    setView("overview");
    if (pr.source === "github" && pr.status === "unprocessed") {
      if (providersLoading || !selectedProviderStatus?.installed) {
        setSettingsOpen(true);
        setAnalysisMessage(
          providersLoading
            ? "Detecting installed analysis providers…"
            : "Select an installed analysis provider before starting.",
        );
      } else setConfirmLiveAnalysis(true);
    }
  };

  const cancelAnalysis = async () => {
    if (analysis?.live && analysis.runId && api && selectedPR) {
      await api.cancelAnalysis(analysis.runId);
      setAnalysisStatus("cancelled");
      setAnalysisMessage("Analysis cancelled.");
      setLivePRs((current) => ({
        ...current,
        [selectedPR.repositoryId]: (current[selectedPR.repositoryId] ?? []).map(
          (pr) =>
            pr.id === selectedPR.id ? { ...pr, status: "cancelled" } : pr,
        ),
      }));
    }
    setAnalysis(null);
  };

  const refreshLive = () => {
    if (!api) return;
    refreshSelectedComments();
    loadProviders();
    if (updateDownloadState !== "downloading" && api.checkForUpdate) {
      const sequence = ++updateCheckSequenceRef.current;
      void api
        .checkForUpdate()
        .then((result) => {
          if (
            sequence === updateCheckSequenceRef.current &&
            updateDownloadStateRef.current !== "downloading"
          ) {
            setUpdateInfo(result);
            updateDownloadStateRef.current = "idle";
            setUpdateDownloadState("idle");
            setUpdateDownloadError("");
            setUpdateDownloadProgress(null);
          }
        })
        .catch(() => undefined);
    }
    if (isLiveRepository && selectedRepository)
      setLivePRs((current) => {
        const next = { ...current };
        delete next[selectedRepository.id];
        return next;
      });
    else {
      setLiveLoading(true);
      void api
        .bootstrap()
        .then((result) => {
          setAccount(accountFromBootstrap(result));
          const discoveredRepositories = result.repositories.map(mapRepository);
          setLiveRepositories(discoveredRepositories);
          setSelectedRepo((current) =>
            discoveredRepositories.some((repo) => repo.id === current)
              ? current
              : (discoveredRepositories[0]?.id ?? ""),
          );
          setLiveError(
            result.warnings.length ? result.warnings.join(" ") : null,
          );
        })
        .catch(() => setLiveError("Could not refresh GitHub discovery."))
        .finally(() => setLiveLoading(false));
    }
  };

  const downloadAvailableUpdate = async () => {
    if (!api?.downloadUpdate || updateDownloadState === "downloading") return;
    updateCheckSequenceRef.current += 1;
    updateDownloadStateRef.current = "downloading";
    setUpdateDownloadState("downloading");
    setUpdateDownloadError("");
    setUpdateDownloadProgress(null);
    try {
      const result = await api.downloadUpdate();
      if (result.success) {
        updateDownloadStateRef.current = "downloaded";
        setUpdateDownloadState("downloaded");
      } else {
        updateDownloadStateRef.current = "failed";
        setUpdateDownloadState("failed");
        setUpdateDownloadError(
          result.error ?? "Could not download the update.",
        );
      }
    } catch {
      updateDownloadStateRef.current = "failed";
      setUpdateDownloadState("failed");
      setUpdateDownloadError("Could not download the update.");
    }
  };

  const openDownloadedUpdate = async () => {
    if (!api?.openDownloadedUpdate) return;
    try {
      if (!(await api.openDownloadedUpdate()))
        setUpdateDownloadError(
          "Could not open the installer. It remains in Downloads.",
        );
    } catch {
      setUpdateDownloadError(
        "Could not open the installer. It remains in Downloads.",
      );
    }
  };

  const openHistoricalRun = async (runId: string) => {
    if (
      !api ||
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName
    )
      return;
    const summary = (liveRuns[selectedPR.id] ?? []).find(
      (run) => run.runId === runId && run.status === "ready",
    );
    if (!summary) return;
    const result = await api.loadAnalysisRun(
      selectedPR.repositoryFullName,
      selectedPR.number,
      runId,
    );
    if (result?.status !== "ready" || !result.document) {
      setLiveError(
        "The selected historical walkthrough could not be loaded safely.",
      );
      return;
    }
    setLiveDocuments((current) => ({
      ...current,
      [selectedPR.id]: result.document!,
    }));
    setLivePRs((current) => ({
      ...current,
      [selectedPR.repositoryId]: (current[selectedPR.repositoryId] ?? []).map(
        (pr) =>
          pr.id === selectedPR.id
            ? {
                ...mapWalkthroughDocument(
                  result.document!,
                  pr,
                  summary.provider,
                ),
                status: summary.outdated ? "outdated" : "ready",
                analyzedSha: summary.headSha,
                evidenceHeadSha: summary.headSha,
                analysisProvenance: summary.provider,
              }
            : pr,
      ),
    }));
    setView("overview");
  };
  const deleteHistoricalRun = async (runId: string) => {
    if (
      !api?.deleteAnalysisRun ||
      !selectedPR?.repositoryFullName ||
      !window.confirm("Delete this local analysis run?")
    )
      return;
    if (
      await api.deleteAnalysisRun(
        selectedPR.repositoryFullName,
        selectedPR.number,
        runId,
      )
    ) {
      setLiveRuns((current) => ({
        ...current,
        [selectedPR.id]: (current[selectedPR.id] ?? []).filter(
          (run) => run.runId !== runId,
        ),
      }));
      setLivePRs((current) => ({
        ...current,
        [selectedPR.repositoryId]: (current[selectedPR.repositoryId] ?? []).map(
          (pr) =>
            pr.id === selectedPR.id
              ? {
                  ...pr,
                  history: pr.history.filter((run) => run.id !== runId),
                }
              : pr,
        ),
      }));
    }
  };
  const preferHistoricalRun = async (runId: string) => {
    if (!api?.setPreferredAnalysisRun || !selectedPR?.repositoryFullName)
      return;
    if (
      await api.setPreferredAnalysisRun(
        selectedPR.repositoryFullName,
        selectedPR.number,
        runId,
      )
    )
      setLiveRuns((current) => ({
        ...current,
        [selectedPR.id]: (current[selectedPR.id] ?? []).map((run) => ({
          ...run,
          preferred: run.runId === runId,
        })),
      }));
  };
  const regenerateHistoricalRun = (runId: string) => {
    const run = liveRuns[selectedPR?.id ?? ""]?.find(
      (item) => item.runId === runId,
    );
    if (run?.config) setAnalysisConfig(run.config);
    startAnalysis();
  };
  const retryAnalysisWithProvider = (provider: AgentProvider) => {
    setSelectedProvider(provider);
    setConfirmLiveAnalysis(true);
  };
  const exportAnalysisDiagnostics = async () => {
    if (
      !api?.exportAnalysisDiagnostics ||
      !selectedPR?.repositoryFullName ||
      !analysisDiagnostics
    )
      return;
    const result = await api.exportAnalysisDiagnostics(
      selectedPR.repositoryFullName,
      selectedPR.number,
      analysisDiagnostics.manifest.runId,
    );
    setDiagnosticExportMessage(
      result.saved
        ? "Diagnostic report saved and revealed in your file manager."
        : (result.error ?? ""),
    );
  };

  const openSelectedPr = () => {
    if (selectedPR?.source === "github" && selectedPR.url && api)
      void api.openExternal(selectedPR.url);
  };
  const openEvidence = (path: string, line?: number) => {
    if (
      !selectedPR ||
      selectedPR.source !== "github" ||
      !selectedPR.repositoryFullName ||
      !api
    )
      return;
    const parsed = path.match(/^(.*?):(\d+)$/);
    const evidencePath = parsed ? parsed[1] : path;
    const evidenceLine = line ?? (parsed ? Number(parsed[2]) : undefined);
    if (api.getEvidenceDetail)
      void api
        .getEvidenceDetail(
          selectedPR.repositoryFullName,
          selectedPR.evidenceHeadSha ?? selectedPR.headSha,
          evidencePath,
          evidenceLine,
        )
        .then((detail) => {
          if (detail) setEvidenceDetail(detail);
        });
    else
      void api.openEvidence?.(
        selectedPR.repositoryFullName,
        selectedPR.evidenceHeadSha ?? selectedPR.headSha,
        evidencePath,
        evidenceLine,
      );
  };
  const updateStepProgress = (
    stepId: string,
    status: ReviewProgressStatus,
    note: string,
  ) => {
    const runId = selectedPR?.walkthrough?.run.id;
    if (!selectedPR || !runId) return;
    const progress: ReviewProgress = {
      runId,
      stepId,
      status,
      note,
      updatedAt: new Date().toISOString(),
    };
    setStepProgress((current) => ({
      ...current,
      [`${runId}:${stepId}`]: progress,
    }));
    if (
      api?.setReviewProgress &&
      selectedPR.source === "github" &&
      selectedPR.repositoryFullName
    )
      void api
        .setReviewProgress(
          selectedPR.repositoryFullName,
          selectedPR.number,
          progress,
        )
        .then((saved) => {
          if (saved)
            setStepProgress((current) => ({
              ...current,
              [`${saved.runId}:${saved.stepId}`]: saved,
            }));
        });
  };
  useEffect(() => {
    if (!analysis?.running || analysis.live) return;
    const timer = window.setInterval(
      () =>
        setAnalysis((current) => {
          if (!current) return current;
          if (current.stage >= analysisStages.length - 1) {
            setAnalysisDone((done) => ({ ...done, [current.id]: true }));
            return { ...current, running: false };
          }
          return { ...current, stage: current.stage + 1 };
        }),
      900,
    );
    return () => window.clearInterval(timer);
  }, [analysis?.running]);

  const activeAnalysis = analysis?.id === selectedPR?.id ? analysis : null;
  const activeAnalysisProviderName = activeAnalysis?.provider
    ? (providers.find((status) => status.provider === activeAnalysis.provider)
        ?.displayName ?? providerLabel(activeAnalysis.provider))
    : activeProviderName;
  const canStartSelectedAnalysis =
    selectedPR !== null &&
    ((selectedPR.source === "github" && selectedPR.status === "ready") ||
      selectedPR.status === "unprocessed" ||
      selectedPR.status === "failed" ||
      selectedPR.status === "outdated" ||
      selectedPR.status === "cancelled");
  const markGroup = (group: ChangeGroup) =>
    setReviewed((current) => {
      if (!selectedPR) return current;
      const key = reviewKey(selectedPR.id, group.id);
      return { ...current, [key]: !current[key] };
    });

  return (
    <div className="app-shell" data-theme={resolvedTheme}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="./favicon.png" alt="" />
          </div>
          <span>PR Atlas</span>
        </div>
        <div className="topbar-context">
          <span
            className={`context-dot ${account.live ? "live" : "fixture"}`}
          />{" "}
          <span>github.com</span>
          <span className="context-separator">/</span>
          <strong>{selectedRepository?.owner ?? "—"}</strong>
          <span className="auth-state" title={account.detail}>
            {account.label}
          </span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
            onClick={refreshLive}
            disabled={liveLoading}
          >
            <RefreshCw size={16} className={liveLoading ? "spin" : ""} />
          </button>
          <div
            className={`agent-status ${providerIsActive ? "active" : "unavailable"}`}
            aria-label={providerIndicatorAria}
          >
            <span className="agent-pulse" />
            <Bot size={15} /> {providerIndicatorLabel}
          </div>
          <Avatar initials={account.initials} label={account.avatarLabel} />
        </div>
      </header>

      {confirmLiveAnalysis && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmLiveAnalysis(false);
          }}
        >
          <section
            className="confirm-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-analysis-title"
          >
            <div className="eyebrow">{activeProviderName} analysis</div>
            <h3 id="confirm-analysis-title">
              Send repository context to {activeProviderName}?
            </h3>
            <p>
              PR Atlas will collect the selected pull request and local
              repository context and send it to {activeProviderName}’s
              configured model service. The validated walkthrough stays in local
              artifacts.
            </p>
            {largePRNotice && (
              <p className="analysis-message" role="status">
                {largePRNotice}
              </p>
            )}
            {selectedModels[selectedProvider] && (
              <p className="confirm-detail">
                Model: <code>{selectedModels[selectedProvider]}</code>
              </p>
            )}
            <p className="confirm-detail">
              Thinking effort: {" "}
              <code>
                {effortLabels[
                  selectedEfforts[selectedProvider] ?? DEFAULT_ANALYSIS_EFFORT
                ]}
              </code>
            </p>
            <p className="confirm-detail">
              {analysisConfig.depth} depth ·{" "}
              {analysisConfig.scanMode === "coordinator" ? "coordinator engine" : "legacy batching engine"} ·{" "}
              {analysisConfig.includeReviewComments
                ? "review comments included"
                : "review comments excluded"}{" "}
              · up to {analysisConfig.maxGraphNodes} graph nodes ·{" "}
              {analysisConfig.timeoutMinutes} minute timeout
            </p>
            {customPrompt.trim() && (
              <p className="confirm-detail">
                Supplemental focus: {customPrompt.trim()}
              </p>
            )}
            <div className="confirm-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirmLiveAnalysis(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void runLiveAnalysis()}
              >
                Continue
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="workspace">
        <aside className="sidebar">
          <div className="repo-picker">
            <div className="eyebrow">Repository</div>
            <div className="search-box repo-search">
              <Search size={14} />
              <input
                type="search"
                aria-label="Search repositories"
                value={repositoryQuery}
                onChange={(event) => setRepositoryQuery(event.target.value)}
                placeholder="Search repositories"
              />
            </div>
            <div className="select-wrap">
              <span className="repo-icon">
                {selectedRepository?.name.slice(0, 1).toUpperCase() ?? "—"}
              </span>
              <SelectMenu
                ariaLabel="Select repository"
                className="repo-select-menu"
                value={selectedRepo}
                options={visibleRepositories.map((repo) => ({
                  value: repo.id,
                  label: repo.fullName ?? `${repo.owner}/${repo.name}`,
                }))}
                onChange={setSelectedRepo}
                placeholder="Choose repository"
              />
            </div>
            <div className="repo-meta">
              {selectedRepository ? (
                <>
                  <span>
                    {selectedRepository.source === "github"
                      ? "Live GitHub repository"
                      : selectedRepository.private
                        ? "Private demo repository"
                        : "Public demo repository"}
                  </span>
                  <span>
                    {selectedRepository.openPRs ||
                      (isLiveRepository
                        ? (livePRs[selectedRepository.id]?.length ?? "—")
                        : 0)}{" "}
                    open
                  </span>
                </>
              ) : (
                <>
                  <span>GitHub repositories</span>
                  <span>—</span>
                </>
              )}
            </div>
          </div>
          <div className="sidebar-section filter-section">
            <div className="section-heading">
              <span>Pull requests</span>
              <span className="count-badge">{repoPRs.length}</span>
            </div>
            <div className="search-box">
              <Search size={14} />
              <input
                aria-label="Search pull requests"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search PRs"
              />
              <kbd>/</kbd>
            </div>
            <div
              className="filter-list"
              role="tablist"
              aria-label="Pull request filters"
            >
              {(
                [
                  "all",
                  "mine",
                  "review",
                  "reviewed",
                  "ready",
                  "processing",
                  "unprocessed",
                  "outdated",
                  "failed",
                ] as Filter[]
              ).map((value) => {
                const label =
                  value === "all"
                    ? "All pull requests"
                    : value === "mine"
                      ? "Authored by me"
                      : value === "review"
                        ? "Review requested"
                        : value === "reviewed"
                          ? "Reviewed by me"
                          : statusMeta[value as PRStatus].label;
                const count =
                  value === "all"
                    ? repoPRs.length
                    : value === "mine" ||
                        value === "review" ||
                        value === "reviewed"
                      ? repoPRs.filter((pr) =>
                          matchesRelationshipFilter(pr, value),
                        ).length
                      : repoPRs.filter((pr) => pr.status === value).length;
                return (
                  <button
                    key={value}
                    role="tab"
                    aria-label={label}
                    aria-selected={filter === value}
                    className={`filter-item ${filter === value ? "active" : ""}`}
                    onClick={() => setFilter(value)}
                  >
                    <span>{label}</span>
                    <span className="filter-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="sidebar-footer">
            {updateInfo?.available && updateInfo.releaseUrl && (
              <div
                className="update-notice"
                role="status"
                aria-label={`New version available ${updateInfo.latestVersion}`}
              >
                <div className="update-summary">
                  <ArrowUp size={14} />
                  <span>
                    <strong>New version available</strong>
                    <b>v{updateInfo.latestVersion}</b>
                    <small>Current version {updateInfo.currentVersion}</small>
                  </span>
                </div>
                {updateDownloadState === "downloading" && (
                  <UpdateProgressIndicator
                    version={updateInfo.latestVersion ?? "update"}
                    progress={updateDownloadProgress}
                  />
                )}
                <div className="update-actions">
                  {updateInfo.downloadUrl &&
                    updateInfo.artifactName &&
                    api?.downloadUpdate &&
                    (updateDownloadState === "downloaded" ? (
                      <button
                        aria-label={`Open downloaded update ${updateInfo.latestVersion}`}
                        onClick={() => void openDownloadedUpdate()}
                      >
                        <ExternalLink size={11} />
                        Open installer
                      </button>
                    ) : (
                      <button
                        aria-label={`${updateDownloadState === "failed" ? "Retry" : "Download"} update ${updateInfo.latestVersion}`}
                        disabled={updateDownloadState === "downloading"}
                        onClick={() => void downloadAvailableUpdate()}
                      >
                        <ArrowDown size={11} />
                        {updateDownloadState === "downloading"
                          ? "Downloading…"
                          : updateDownloadState === "failed"
                            ? "Retry"
                            : "Download"}
                      </button>
                    ))}
                  <button
                    className="update-release-link"
                    aria-label={`View release ${updateInfo.latestVersion}`}
                    onClick={() =>
                      void api?.openExternal(updateInfo.releaseUrl!)
                    }
                  >
                    View release
                  </button>
                </div>
                {updateDownloadState === "downloaded" &&
                  !updateDownloadError && (
                    <small className="update-message">
                      Saved to Downloads.
                    </small>
                  )}
                {updateDownloadError && (
                  <small className="update-message error">
                    {updateDownloadError}
                  </small>
                )}
              </div>
            )}
            <div className="sidebar-utilities" aria-label="Workspace utilities">
              <button className="sidebar-utility-button help-button">
                <CircleHelp size={14} /> Keyboard shortcuts
              </button>
              <button
                className={`sidebar-utility-button workspace-settings-link ${settingsOpen ? "active" : ""}`}
                aria-label="Open settings"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings size={14} /> Workspace settings
              </button>
            </div>
          </div>
        </aside>

        {settingsOpen ? <main className="settings-page" aria-labelledby="workspace-settings-title">
          <header className="settings-page-header">
            <div className="settings-page-intro">
              <div className="eyebrow">Workspace</div>
              <h1 id="workspace-settings-title">Workspace settings</h1>
              <p>Choose the provider, model, and thinking budget for every analysis run. Changes save locally and apply to the next scan.</p>
            </div>
            <div className="settings-page-actions">
              <button className="secondary-button" aria-label="Back to pull requests" onClick={() => setSettingsOpen(false)}><ArrowLeft size={14} /> Back to pull requests</button>
            </div>
          </header>
          <div className="settings-workbench">
            <nav className="settings-rail" aria-label="Settings sections">
              <div className="eyebrow">Configuration</div>
              <a href="#appearance-settings">Appearance</a>
              <a href="#provider-settings">Provider</a>
              <a href="#analysis-settings">Next analysis</a>
              <a href="#retention-settings">Retention</a>
              <a href="#guidance-settings">Guidance</a>
            </nav>
            <div className="settings-content">
            <section id="appearance-settings" className="settings-panel interface-settings"><div className="settings-panel-heading"><div><div className="eyebrow">Appearance</div><h2>Interface</h2></div></div><fieldset className="theme-fieldset"><legend>Theme</legend><div className="theme-options">{themeModes.map(({ value, label }) => <label className="theme-option" key={value}><input type="radio" name="theme-mode" value={value} checked={themeMode === value} onChange={() => chooseTheme(value)} /><span>{label}</span></label>)}</div><p id="theme-description" className="theme-description">System follows your operating-system appearance.</p></fieldset></section>
            <section id="provider-settings" className="settings-panel provider-settings"><div className="settings-panel-heading"><div><div className="eyebrow">Analysis</div><h2>Provider</h2></div><span className={`provider-health ${providerIsActive ? 'ready' : ''}`}>{providerIndicatorLabel}</span></div>{electronMode ? <fieldset className="provider-fieldset"><legend>Choose an installed provider</legend>{providersLoading && <p className="provider-note">Detecting Claude Code, Codex CLI, and Cursor Agent…</p>}{providerError && <p className="provider-note provider-error">{providerError}</p>}{!providersLoading && !providers.length && !providerError && <p className="provider-note">No provider detection result yet.</p>}{providers.map((status) => <label className={`provider-option ${status.installed ? '' : 'unavailable'}`} key={status.provider}><input type="radio" name="analysis-provider" value={status.provider} checked={selectedProvider === status.provider} disabled={!status.installed} onChange={() => chooseProvider(status.provider)} /><span className="provider-option-main"><strong>{status.displayName}</strong><small>{status.executable}</small></span><span className="provider-option-status">{providerStatusLabel(status)}</span></label>)}</fieldset> : <p className="provider-note">Browser demo runtime only; installed provider detection is available in Electron.</p>}</section>
            <section id="analysis-settings" className="settings-panel run-settings">
              <div className="settings-panel-heading">
                <div>
                  <div className="eyebrow">Next analysis</div>
                  <h2>
                    {selectedProviderStatus?.installed
                      ? selectedProviderStatus.displayName
                      : "Provider configuration"}
                  </h2>
                </div>
              </div>
              {electronMode && selectedProviderStatus?.installed ? (
                <>
                  <label className="model-setting">
                    <span>Model</span>
                    {selectedProviderStatus.models?.length ? (
                      <SelectMenu
                        ariaLabel={`Model for ${selectedProviderStatus.displayName}`}
                        className="model-select-menu"
                        value={
                          selectedModels[selectedProvider] ??
                          selectedProviderStatus.models[0]?.id ??
                          ""
                        }
                        options={selectedProviderStatus.models.map((model) => ({
                          value: model.id,
                          label: model.label,
                        }))}
                        searchable={selectedProviderStatus.models.length > 12}
                        onChange={(value) =>
                          setSelectedModels((current) => ({
                            ...current,
                            [selectedProvider]: value,
                          }))
                        }
                      />
                    ) : (
                      <small>
                        The installed tool did not report selectable models; its
                        configured default will be used.
                      </small>
                    )}
                  </label>
                  <label className="model-setting">
                    <span>Thinking effort</span>
                    <SelectMenu
                      ariaLabel={`Thinking effort for ${selectedProviderStatus.displayName}`}
                      className="model-select-menu"
                      value={
                        selectedEfforts[selectedProvider] ??
                        DEFAULT_ANALYSIS_EFFORT
                      }
                      options={providerEfforts[selectedProvider].map((effort) => ({
                        value: effort,
                        label: effortLabels[effort],
                      }))}
                      onChange={(value) =>
                        setSelectedEfforts((current) => ({
                          ...current,
                          [selectedProvider]: value as AnalysisEffort,
                        }))
                      }
                    />
                    <small>
                      Medium balances coverage and cost. Lower effort is faster
                      and generally less expensive; higher effort may produce a
                      more thorough scan.
                    </small>
                  </label>
                </>
              ) : (
                <p className="provider-note">
                  Select an installed provider to configure its model and
                  thinking budget.
                </p>
              )}
              <fieldset className="provider-fieldset">
                <legend>Analysis scope</legend>
                <label className="model-setting">
                  <span>Scan engine</span>
                  <SelectMenu
                    ariaLabel="Scan engine"
                    value={analysisConfig.scanMode}
                    options={[
                      { value: "coordinator", label: "Coordinator (recommended)" },
                      { value: "legacy", label: "Legacy batching" },
                    ]}
                    onChange={(value) =>
                      setAnalysisConfig((current) => ({
                        ...current,
                        scanMode: value as AnalysisRunConfig["scanMode"],
                      }))
                    }
                  />
                  <small>Coordinator anchors the PR before parallel specialists. Legacy keeps the established map/reduce batching flow.</small>
                </label>
                <label className="model-setting">
                  <span>Depth</span>
                  <SelectMenu
                    ariaLabel="Analysis depth"
                    value={analysisConfig.depth}
                    options={[
                      { value: "quick", label: "Quick" },
                      { value: "standard", label: "Standard" },
                      { value: "deep", label: "Deep" },
                    ]}
                    onChange={(value) =>
                      setAnalysisConfig((current) => ({
                        ...current,
                        depth: value as AnalysisRunConfig["depth"],
                      }))
                    }
                  />
                </label>
                <label className="theme-option">
                  <input
                    aria-label="Include review comments"
                    type="checkbox"
                    checked={analysisConfig.includeReviewComments}
                    onChange={(event) =>
                      setAnalysisConfig((current) => ({
                        ...current,
                        includeReviewComments: event.target.checked,
                      }))
                    }
                  />
                  <span>Include review comments</span>
                </label>
                <label className="model-setting">
                  <span>Maximum graph nodes</span>
                  <input
                    aria-label="Maximum graph nodes"
                    type="number"
                    min="20"
                    max="200"
                    value={analysisConfig.maxGraphNodes}
                    onChange={(event) =>
                      setAnalysisConfig((current) => ({
                        ...current,
                        maxGraphNodes: Math.max(
                          20,
                          Math.min(200, Number(event.target.value) || 20),
                        ),
                      }))
                    }
                  />
                </label>
                <label className="model-setting">
                  <span>Timeout minutes</span>
                  <input
                    aria-label="Analysis timeout minutes"
                    type="number"
                    min="1"
                    max="60"
                    value={analysisConfig.timeoutMinutes}
                    onChange={(event) =>
                      setAnalysisConfig((current) => ({
                        ...current,
                        timeoutMinutes: Math.max(
                          1,
                          Math.min(60, Number(event.target.value) || 1),
                        ),
                      }))
                    }
                  />
                </label>
              </fieldset>
            </section>
            <section id="retention-settings" className="settings-panel retention-settings">
              <div className="settings-panel-heading">
                <div>
                  <div className="eyebrow">Storage</div>
                  <h2>Retention</h2>
                </div>
              </div>
              <label className="model-setting">
                <span>Analysis days</span>
                <input
                  aria-label="Analysis retention days"
                  type="number"
                  min="1"
                  max="3650"
                  value={retentionSettings.analysisDays}
                  onChange={(event) => {
                    const next = {
                      ...retentionSettings,
                      analysisDays: Math.max(
                        1,
                        Math.min(3650, Number(event.target.value) || 1),
                      ),
                    };
                    setRetentionSettings(next);
                    void api?.setRetentionSettings?.(next);
                  }}
                />
              </label>
              <label className="model-setting">
                <span>Worktree days</span>
                <input
                  aria-label="Worktree retention days"
                  type="number"
                  min="1"
                  max="3650"
                  value={retentionSettings.worktreeDays}
                  onChange={(event) => {
                    const next = {
                      ...retentionSettings,
                      worktreeDays: Math.max(
                        1,
                        Math.min(3650, Number(event.target.value) || 1),
                      ),
                    };
                    setRetentionSettings(next);
                    void api?.setRetentionSettings?.(next);
                  }}
                />
              </label>
            </section>
            <section id="guidance-settings" className="settings-panel guidance-settings"><div className="settings-panel-heading"><div><div className="eyebrow">Collection</div><h2>Supplemental guidance</h2></div></div><label className="prompt-setting"><span>Focus the next walkthrough</span><textarea aria-label="Supplemental collection guidance" value={customPrompt} maxLength={4000} rows={5} placeholder="Example: collect more migration, rollback, or test evidence" onChange={(event) => setCustomPrompt(event.target.value)} /><small>This may guide additional evidence collection, but cannot change the required walkthrough structure.</small></label></section>
              <section className="settings-boundary"><ShieldCheck size={18} /><div><strong>Repository context stays local until you approve an analysis.</strong><p>{selectedProviderStatus?.installed ? <>The next run will use {activeProviderName} with {effortLabels[selectedEfforts[selectedProvider] ?? DEFAULT_ANALYSIS_EFFORT].toLowerCase()} thinking effort. Repository context is sent only to that provider’s configured model service.</> : 'Select an installed provider to enable analysis.'}</p></div><dl><div><dt>Data source</dt><dd>{electronMode ? account.live ? 'GitHub CLI + local artifacts' : 'GitHub CLI unavailable' : 'Demo fixture'}</dd></div><div><dt>Unprocessed PRs</dt><dd>Ask before analysis</dd></div></dl></section>
            </div>
          </div>
        </main> : <>
        <section className="pr-list-pane" aria-label="Pull request list">
          <div className="pane-header">
            <div>
              <div className="eyebrow">
                {selectedRepository
                  ? `${selectedRepository.owner}/${selectedRepository.name}`
                  : "GitHub discovery"}
              </div>
              <h1>Pull requests</h1>
            </div>
          </div>
          <div className="pr-list" role="list" aria-label="Pull request list">
            {!selectedRepository && liveLoading && (
              <div className="empty-state">
                <Loader2 size={20} className="spin" />
                <p>Loading GitHub repositories…</p>
              </div>
            )}
            {!selectedRepository && !liveLoading && liveError && (
              <div className="empty-state error-state">
                <AlertCircle size={20} />
                <p>{liveError}</p>
                <button onClick={refreshLive}>Retry</button>
              </div>
            )}
            {!selectedRepository && !liveLoading && !liveError && (
              <div className="empty-state">
                <GitPullRequest size={20} />
                <p>No GitHub repositories found.</p>
                <button onClick={refreshLive}>Refresh</button>
              </div>
            )}
            {liveLoading && isLiveRepository && visiblePRs.length === 0 && (
              <div className="empty-state">
                <Loader2 size={20} className="spin" />
                <p>Loading GitHub pull requests…</p>
              </div>
            )}
            {visiblePRs.map((pr) => (
              <button
                aria-label={`#${pr.number} ${pr.title}`}
                className={`pr-row ${selectedPR?.id === pr.id ? "selected" : ""}`}
                key={pr.id}
                onClick={() => selectPullRequest(pr)}
                role="listitem"
              >
                <div className="pr-row-top">
                  <span className="pr-number">#{pr.number}</span>
                  <StatusPill status={pr.status} />
                </div>
                <div className="pr-title">{pr.title}</div>
                <div className="pr-row-meta">
                  <Avatar initials={pr.initials} className="small" />
                  <span>{pr.author}</span>
                  <span className="meta-divider">·</span>
                  <span>{pr.updated}</span>
                </div>
                <div className="pr-row-bottom">
                  <span className="branch">
                    <GitPullRequest size={12} /> {pr.branch}
                  </span>
                  <span>{pr.files} files</span>
                </div>
              </button>
            ))}
            {selectedRepository &&
              !liveLoading &&
              liveError &&
              isLiveRepository &&
              visiblePRs.length === 0 && (
                <div className="empty-state error-state">
                  <AlertCircle size={20} />
                  <p>{liveError}</p>
                  <button onClick={refreshLive}>Retry</button>
                </div>
              )}
            {selectedRepository &&
              !liveLoading &&
              !liveError &&
              visiblePRs.length === 0 &&
              (repoPRs.length === 0 ? (
                <div className="empty-state">
                  <GitPullRequest size={20} />
                  <p>No open pull requests.</p>
                  <button onClick={refreshLive}>Refresh</button>
                </div>
              ) : (
                <div className="empty-state">
                  <Search size={20} />
                  <p>No pull requests match these filters.</p>
                  <button
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              ))}
          </div>
        </section>

        <main className="content-pane">
          {selectedPR ? (
            <>
              <div className="pr-header">
                <div className="breadcrumb">
                  <span>
                    {selectedPR.repositoryFullName ?? selectedPR.repositoryId}
                  </span>
                  <span>/</span>
                  <span>pull request</span>
                  <span>/</span>
                  <strong>#{selectedPR.number}</strong>
                  <span className="source-label">
                    {selectedPR.source === "github" ? "GitHub" : "Demo PR"}
                  </span>
                </div>
                {selectedPR.status === "outdated" && (
                  <div className="stale-banner">
                    <AlertCircle size={14} />
                    <strong>This walkthrough is outdated.</strong>
                    <span>
                      Analyzed SHA{" "}
                      <code>
                        {shortSha(selectedPR.analyzedSha ?? "unknown")}
                      </code>{" "}
                      · current SHA <code>{shortSha(selectedPR.headSha)}</code>
                    </span>
                    <button onClick={startAnalysis}>Update walkthrough</button>
                    <span className="stale-note">
                      New commits may change the evidence below.
                    </span>
                  </div>
                )}
                <div className="pr-heading-row">
                  <div>
                    <div className="title-line">
                      <h2>{selectedPR.title}</h2>
                      <StatusPill status={selectedPR.status} />
                    </div>
                    <div className="pr-subtitle">
                      <Avatar
                        initials={selectedPR.initials}
                        className="small"
                      />
                      <span>{selectedPR.author}</span>
                      <span>wants to merge</span>
                      <code>{selectedPR.branch}</code>
                      <span>into</span>
                      <code>{selectedPR.base}</code>
                    </div>
                  </div>
                  <div className="heading-actions">
                    <button
                      className="secondary-button"
                      aria-label="Open pull request on GitHub"
                      onClick={openSelectedPr}
                      disabled={selectedPR.source !== "github"}
                    >
                      <ExternalLink size={14} />{" "}
                      {selectedPR.source === "github"
                        ? "View on GitHub"
                        : "Demo PR · GitHub link disabled"}
                    </button>
                    {canStartSelectedAnalysis && (
                      <button
                        className="primary-button"
                        onClick={startAnalysis}
                        disabled={activeAnalysis?.running}
                      >
                        <Play size={14} />{" "}
                        {activeAnalysis?.running
                          ? "Analyzing…"
                          : selectedPR.status === "failed"
                            ? "Retry analysis"
                            : selectedPR.status === "ready"
                              ? "Analyze again"
                              : "Analyze"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="pr-stats">
                  <span>
                    <ArrowUp size={13} className="additions" />{" "}
                    {selectedPR.additions} additions
                  </span>
                  <span>
                    <ArrowDown size={13} className="deletions" />{" "}
                    {selectedPR.deletions} deletions
                  </span>
                  <span>
                    <Files size={13} /> {selectedPR.files} files
                  </span>
                  <span>
                    <GitPullRequest size={13} />{" "}
                    {selectedPR.changedAreas.join(" · ")}
                  </span>
                  <span className="stats-spacer" />
                  <span>Updated {selectedPR.updated}</span>
                </div>
              </div>
              <nav className="view-nav" aria-label="Pull request sections">
                {viewItems.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className={view === id ? "active" : ""}
                    onClick={() => setView(id)}
                  >
                    <Icon size={14} /> {label}
                    {id === "insights" && selectedPR.insights.length > 0 && (
                      <span className="nav-count">
                        {selectedPR.insights.length}
                      </span>
                    )}
                    {id === "threads" &&
                      selectedCommentResource.comments.length > 0 && (
                        <span className="nav-count">
                          {selectedCommentResource.comments.length}
                        </span>
                      )}
                  </button>
                ))}
              </nav>
              <div className="content-scroll">
                <ViewContent
                  view={view}
                  pr={selectedPR}
                  flowType={flowType}
                  setFlowType={setFlowType}
                  selectedFlowNodeId={selectedFlowNodeId}
                  activeAnalysis={activeAnalysis}
                  providerName={activeAnalysisProviderName}
                  analysisMessage={analysisMessage}
                  commentResource={selectedCommentResource}
                  commentsLive={selectedPR.source === "github" && Boolean(api)}
                  commentViewer={{ label: account.label, initials: account.initials }}
                  onPostComment={postSelectedComment}
                  onRefreshComments={refreshSelectedComments}
                  markGroup={markGroup}
                  reviewed={reviewed}
                  stepProgress={stepProgress}
                  updateStepProgress={updateStepProgress}
                  cancelAnalysis={() => void cancelAnalysis()}
                  reopenWalkthrough={() => setView("walkthrough")}
                  openHistoricalRun={(runId) => void openHistoricalRun(runId)}
                  openEvidence={openEvidence}
                  onDeleteRun={(runId) => void deleteHistoricalRun(runId)}
                  onPreferRun={(runId) => void preferHistoricalRun(runId)}
                  onRegenerateRun={regenerateHistoricalRun}
                  diagnostics={analysisDiagnostics}
                  diagnosticExportMessage={diagnosticExportMessage}
                  onExportDiagnostics={() => void exportAnalysisDiagnostics()}
                  openAnalysisDetails={() => setView("details")}
                  retryProviders={providers.filter(
                    (provider) => provider.installed,
                  )}
                  onRetryWithProvider={retryAnalysisWithProvider}
                  openFlow={(type, nodeId) => {
                    setFlowType(type);
                    setSelectedFlowNodeId(nodeId);
                    setView("flows");
                  }}
                />
              </div>
              {evidenceDetail && (
                <aside
                  className="evidence-drawer"
                  ref={evidenceDrawerRef}
                  role="dialog"
                  aria-label="Evidence details"
                >
                  <button
                    className="icon-button"
                    aria-label="Close evidence details"
                    onClick={() => setEvidenceDetail(null)}
                  >
                    <X size={15} />
                  </button>
                  <div className="eyebrow">
                    {evidenceDetail.source === "worktree"
                      ? "Repository source"
                      : "Deterministic input"}
                  </div>
                  <h4>
                    {evidenceDetail.path}
                    {evidenceDetail.line ? `:${evidenceDetail.line}` : ""}
                  </h4>
                  {(() => {
                    const item = selectedPR.evidence.find(
                      (candidate) =>
                        candidate.path === evidenceDetail.path &&
                        (evidenceDetail.line == null ||
                          candidate.line === evidenceDetail.line),
                    );
                    const evidenceId = item?.id;
                    const groups = evidenceId
                      ? selectedPR.groups.filter((group) =>
                          group.evidenceIds?.includes(evidenceId),
                        )
                      : [];
                    const tests = evidenceId
                      ? selectedPR.tests.filter((test) =>
                          test.evidenceIds?.includes(evidenceId),
                        )
                      : [];
                    const threads = evidenceId
                      ? selectedPR.threads.filter((thread) =>
                          thread.evidenceIds?.includes(evidenceId),
                        )
                      : [];
                    return (
                      <div className="evidence-associations">
                        <strong>Related evidence</strong>
                        {groups.length > 0 && (
                          <p>
                            Groups:{" "}
                            {groups.map((group) => group.title).join(" · ")}
                          </p>
                        )}
                        {tests.length > 0 && (
                          <p>
                            Tests: {tests.map((test) => test.test).join(" · ")}
                          </p>
                        )}
                        {threads.length > 0 && (
                          <p>
                            Review threads:{" "}
                            {threads.map((thread) => thread.author).join(" · ")}
                          </p>
                        )}
                        {item?.url && (
                          <button
                            className="secondary-button"
                            onClick={() => void api?.openExternal(item.url!)}
                          >
                            View on GitHub
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <EvidenceCodeView detail={evidenceDetail} />
                  <button
                    className="secondary-button"
                    onClick={() => {
                      const parsed = evidenceDetail.path.match(/^(.*?):(\d+)$/);
                      void api?.openEvidence?.(
                        selectedPR.repositoryFullName!,
                        selectedPR.evidenceHeadSha ?? selectedPR.headSha,
                        parsed?.[1] ?? evidenceDetail.path,
                        evidenceDetail.line ??
                          (parsed ? Number(parsed[2]) : undefined),
                      );
                    }}
                  >
                    Open locally
                  </button>
                </aside>
              )}
            </>
          ) : (
            <section
              className="empty-detail"
              aria-labelledby="empty-detail-title"
            >
              <div className="empty-detail-content">
                <div className="empty-detail-mark" aria-hidden="true">
                  <img src="./favicon.png" alt="" />
                </div>
                <div className="eyebrow">
                  {selectedRepository ? "Repository ready" : "GitHub discovery"}
                </div>
                <h2 id="empty-detail-title">
                  {!selectedRepository
                    ? liveLoading
                      ? "Loading GitHub repositories"
                      : liveError
                        ? "GitHub repositories unavailable"
                        : "No GitHub repositories found"
                    : liveLoading
                      ? "Loading pull requests"
                      : liveError
                        ? "Pull requests are unavailable"
                        : "No open pull requests"}
                </h2>
                <p>
                  {!selectedRepository ? (
                    liveLoading ? (
                      "Finding repositories available to the authenticated GitHub CLI account…"
                    ) : liveError ? (
                      liveError
                    ) : (
                      "GitHub CLI did not return any repositories for this account."
                    )
                  ) : liveLoading ? (
                    <>
                      Checking GitHub for open work in{" "}
                      <strong>
                        {selectedRepository.fullName ??
                          `${selectedRepository.owner}/${selectedRepository.name}`}
                      </strong>
                      …
                    </>
                  ) : liveError ? (
                    "Refresh the repository to try the GitHub request again."
                  ) : (
                    <>
                      <strong>
                        {selectedRepository.fullName ??
                          `${selectedRepository.owner}/${selectedRepository.name}`}
                      </strong>{" "}
                      is all clear. New pull requests will appear here with
                      their walkthrough status and review evidence.
                    </>
                  )}
                </p>
                {!liveLoading && (
                  <div className="empty-detail-actions">
                    <button
                      className="primary-button"
                      aria-label={
                        !selectedRepository
                          ? "Retry GitHub discovery"
                          : "Refresh pull requests"
                      }
                      onClick={refreshLive}
                    >
                      <RefreshCw size={14} />{" "}
                      {!selectedRepository
                        ? "Retry GitHub discovery"
                        : "Refresh pull requests"}
                    </button>
                  </div>
                )}
                <div className="empty-detail-meta">
                  <ShieldCheck size={14} />
                  <span>Authenticated GitHub data</span>
                  <span aria-hidden="true">·</span>
                  <span>Local analysis artifacts</span>
                </div>
              </div>
            </section>
          )}
        </main>
        </>}
      </div>
    </div>
  );
}

function ViewContent({
  view,
  pr,
  flowType,
  setFlowType,
  selectedFlowNodeId,
  activeAnalysis,
  providerName,
  analysisMessage,
  commentResource,
  commentsLive,
  commentViewer,
  onPostComment,
  onRefreshComments,
  markGroup,
  reviewed,
  stepProgress,
  updateStepProgress,
  cancelAnalysis,
  reopenWalkthrough,
  openHistoricalRun,
  openEvidence,
  onDeleteRun,
  onPreferRun,
  onRegenerateRun,
  diagnostics,
  diagnosticExportMessage,
  onExportDiagnostics,
  openAnalysisDetails,
  retryProviders,
  onRetryWithProvider,
  openFlow,
}: {
  view: View;
  pr: PullRequest;
  flowType: Flow["type"];
  setFlowType: (type: Flow["type"]) => void;
  selectedFlowNodeId: string | null;
  activeAnalysis: {
    id: string;
    stage: number;
    running: boolean;
    startedAt: number;
    live?: boolean;
    provider?: AgentProvider;
    scanMode?: AnalysisRunConfig["scanMode"];
    activity: AnalysisProgressEvent[];
  } | null;
  providerName: string;
  analysisMessage?: string;
  commentResource: CommentResource;
  commentsLive: boolean;
  commentViewer: { label: string; initials: string };
  onPostComment: (body: string) => Promise<boolean>;
  onRefreshComments: () => void;
  markGroup: (group: ChangeGroup) => void;
  reviewed: Record<string, boolean>;
  stepProgress: Record<string, ReviewProgress>;
  updateStepProgress: (
    stepId: string,
    status: ReviewProgressStatus,
    note: string,
  ) => void;
  cancelAnalysis: () => void;
  reopenWalkthrough: () => void;
  openHistoricalRun: (runId: string) => void;
  openEvidence: (path: string, line?: number) => void;
  onDeleteRun: (runId: string) => void;
  onPreferRun: (runId: string) => void;
  onRegenerateRun: (runId: string) => void;
  diagnostics: AnalysisDiagnostics | null;
  diagnosticExportMessage: string;
  onExportDiagnostics: () => void;
  openAnalysisDetails: () => void;
  retryProviders: AgentInstallationStatus[];
  onRetryWithProvider: (provider: AgentProvider) => void;
  openFlow: (type: Flow["type"], nodeId: string) => void;
}) {
  if (
    activeAnalysis?.running &&
    view !== "threads" &&
    (view === "walkthrough" || pr.status === "unprocessed")
  )
    return (
      <AnalysisProgress
        pr={pr}
        analysis={activeAnalysis}
        providerName={providerName}
        message={analysisMessage}
        onCancel={cancelAnalysis}
      />
    );
  if (
    view === "walkthrough" &&
    (pr.status === "failed" || pr.status === "cancelled")
  )
    return (
      <AnalysisFailure
        pr={pr}
        diagnostics={diagnostics}
        exportMessage={diagnosticExportMessage}
        onExport={onExportDiagnostics}
        onOpenDetails={openAnalysisDetails}
        onRetry={
          diagnostics &&
          retryProviders.some(
            (provider) => provider.provider === diagnostics.manifest.provider,
          )
            ? () => onRetryWithProvider(diagnostics.manifest.provider)
            : undefined
        }
      />
    );
  if (view === "overview") return <OverviewFull pr={pr} />;
  if (view === "walkthrough")
    return (
      <WalkthroughRich
        pr={pr}
        markGroup={markGroup}
        reviewed={reviewed}
        progress={stepProgress}
        updateProgress={updateStepProgress}
        openEvidence={openEvidence}
        openFlow={openFlow}
      />
    );
  if (view === "groups")
    return (
      <GroupsRich
        pr={pr}
        markGroup={markGroup}
        reviewed={reviewed}
        progress={stepProgress}
        updateProgress={updateStepProgress}
        openEvidence={openEvidence}
      />
    );
  if (view === "insights")
    return <InsightsView insights={pr.insights} openEvidence={openEvidence} />;
  if (view === "flows")
    return (
      <FlowsView
        flows={pr.flows}
        flowType={flowType}
        setFlowType={setFlowType}
        selectedFlowNodeId={selectedFlowNodeId}
        evidence={pr.evidence}
        groups={pr.groups}
        threads={pr.threads}
        openEvidence={openEvidence}
      />
    );
  if (view === "files")
    return <FilesRich pr={pr} openEvidence={openEvidence} />;
  if (view === "tests")
    return <TestsView pr={pr} openEvidence={openEvidence} />;
  if (view === "threads")
    return (
      <RichThreadsView
        key={pr.id}
        pr={pr}
        openEvidence={openEvidence}
        live={commentsLive}
        viewer={commentViewer}
        comments={{
          status: commentResource.status,
          comments: commentResource.comments,
          error: commentResource.error,
        }}
        posting={commentResource.posting}
        postError={commentResource.postError}
        successMessage={commentResource.successMessage}
        onPost={onPostComment}
        onRefresh={onRefreshComments}
      />
    );
  return (
    <DetailsView
      pr={pr}
      providerName={providerName}
      onReopen={reopenWalkthrough}
      onOpenRun={openHistoricalRun}
      openEvidence={openEvidence}
      onDeleteRun={onDeleteRun}
      onPreferRun={onPreferRun}
      onRegenerateRun={onRegenerateRun}
      diagnostics={diagnostics}
      diagnosticExportMessage={diagnosticExportMessage}
      onExportDiagnostics={onExportDiagnostics}
      retryProviders={retryProviders}
      onRetryWithProvider={onRetryWithProvider}
    />
  );
}

function OverviewFull({ pr }: { pr: PullRequest }) {
  const provider =
    pr.analysisProvenance && pr.analysisProvenance !== "demo"
      ? providerLabel(pr.analysisProvenance)
      : null;
  const summary = pr.walkthrough?.summary;
  const list = (items: unknown[] | undefined, fallback: string) =>
    items?.length ? (
      <ul className="overview-note-list">
        {items.map((item, index) => (
          <li key={index}>{safeString(item, fallback)}</li>
        ))}
      </ul>
    ) : (
      <p className="overview-note-empty">{fallback}</p>
    );
  const activeThreads = pr.threads.filter(
    (thread) => thread.state === "active" || thread.state === "open",
  ).length;
  const coverage = {
    covered: pr.tests.filter((test) => test.status === "covered").length,
    partial: pr.tests.filter((test) => test.status === "partial").length,
    missing: pr.tests.filter((test) => test.status === "missing").length,
  };
  return (
    <div className="overview view-section">
      <div className="overview-intro">
        <div>
          <div className="eyebrow">
            {pr.source === "github" && provider
              ? `Validated ${provider} walkthrough`
              : "What this pull request does"}
          </div>
          <h3>{pr.summary}</h3>
          <p>
            Validated relationships connect the behavioral story, evidence,
            tests, and existing review activity.
          </p>
        </div>
      </div>
      <div className="summary-grid">
        <Metric
          icon={GitPullRequestArrow}
          label="Logical changes"
          value={String(pr.groups.length)}
          hint="review units"
        />
        <Metric
          icon={AlertCircle}
          label="Open threads"
          value={String(activeThreads)}
          hint={`${pr.threads.length} total review threads`}
        />
        <Metric
          icon={Workflow}
          label="Behavior flows"
          value={String(pr.flows.length)}
          hint="four system views"
        />
        <Metric
          icon={TestTube2}
          label="Tests mapped"
          value={`${coverage.covered} covered`}
          hint={`${coverage.partial} partial · ${coverage.missing} missing`}
        />
      </div>
      <div className="overview-columns">
        <section className="overview-notes" aria-label="Walkthrough summary">
          <section className="overview-note-block">
            <SectionTitle label="Behavioral changes" />
            {list(
              summary?.behavioralChanges,
              "No user-visible changes were specified.",
            )}
          </section>
          <section className="overview-note-block">
            <SectionTitle label="Architectural impact" />
            {list(
              summary?.architecturalImpact,
              "No architectural impact was specified.",
            )}
          </section>
          <section className="overview-note-block">
            <SectionTitle label="Known limitations" />
            {list(summary?.limitations, "No analysis limitations were recorded.")}
          </section>
        </section>
        <section>
          <SectionTitle label="Recommended review order" />
          {(safeArray(pr.walkthrough?.walkthrough).length
            ? safeArray(pr.walkthrough?.walkthrough).map(objectValue)
            : pr.groups.map((group) => ({
                ...group,
                changeGroupId: group.id,
                reason: group.description,
              }))
          ).map((entry, index) => {
            const group =
              pr.groups.find(
                (candidate) => candidate.id === entry.changeGroupId,
              ) ?? (entry as ChangeGroup);
            return (
              <div
                className="change-row"
                key={safeString(entry.id, `${group.id}-${index}`)}
              >
                <span className="change-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <strong>{safeString(entry.title, group.title)}</strong>
                  <p>{safeString(entry.reason, group.description)}</p>
                </div>
                <AttentionTag level={group.attention} />
              </div>
            );
          })}
          <SectionTitle label="Review activity" />
          {pr.insights.map((insight) => (
            <InsightRow key={insight.id} insight={insight} />
          ))}
        </section>
      </div>
      <EvidenceStrip pr={pr} />
    </div>
  );
}

function AnalysisFailure({
  pr,
  diagnostics,
  exportMessage,
  onExport,
  onOpenDetails,
  onRetry,
}: {
  pr: PullRequest;
  diagnostics: AnalysisDiagnostics | null;
  exportMessage: string;
  onExport: () => void;
  onOpenDetails: () => void;
  onRetry?: () => void;
}) {
  const cancelled = pr.status === "cancelled";
  const error = diagnostics?.error;
  const lastProgress = diagnostics?.manifest.lastProgress;
  return (
    <section className="analysis-failure" aria-label="Analysis failure">
      <div className="failure-icon" aria-hidden="true">
        <AlertCircle size={20} />
      </div>
      <div className="failure-copy">
        <span className="failure-kicker">
          {error?.code ?? diagnostics?.manifest.status ?? pr.status}
        </span>
        <h3>{cancelled ? "Analysis cancelled" : "Analysis failed"}</h3>
        <p>
          {error?.message ??
            pr.analysisDiagnostic ??
            "The run ended before PR Atlas could produce a validated walkthrough."}
        </p>
        {lastProgress && (
          <div className="failure-progress">
            <strong>Last completed activity</strong>
            <span>{lastProgress.message}</span>
          </div>
        )}
        {error?.details?.length ? (
          <ul className="failure-details">
            {error.details.slice(0, 3).map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
        <div className="failure-actions">
          {onRetry && (
            <button className="primary-button" onClick={onRetry}>
              <RefreshCw size={13} /> Retry analysis
            </button>
          )}
          {diagnostics && (
            <button className="secondary-button" onClick={onExport}>
              <Download size={13} /> Save diagnostic report
            </button>
          )}
          <button className="secondary-button" onClick={onOpenDetails}>
            <Code2 size={13} /> View analysis details
          </button>
        </div>
        <small className="failure-sharing-note">
          Diagnostic reports include bounded logs and provider output. Review
          the report before sharing it.
        </small>
        {exportMessage && (
          <p className="diagnostic-export-status" role="status">
            {exportMessage}
          </p>
        )}
      </div>
    </section>
  );
}

function AnalysisProgress({
  pr,
  analysis,
  providerName,
  onCancel,
  message,
}: {
  pr: Pick<PullRequest, "files" | "additions" | "deletions">;
  analysis: {
    stage: number;
    running: boolean;
    live?: boolean;
    scanMode?: AnalysisRunConfig["scanMode"];
    startedAt: number;
    activity: AnalysisProgressEvent[];
  };
  providerName: string;
  onCancel: () => void;
  message?: string;
}) {
  const largePRNotice = analysisDurationNotice(pr);
  const live = Boolean(analysis.live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!analysis.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [analysis.running]);
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - analysis.startedAt) / 1_000),
  );
  const coordinatorRows = [
    ["anchoring", "Anchor"],
    ["walkthrough", "Walkthrough"],
    ["tests-risks", "Tests & risks"],
    ["flows", "Flows"],
    ["assembling", "Assembly"],
    ["validating", "Validation"],
  ] as const;
  const coordinatorState = (stage: AnalysisProgressEvent["stage"]) => {
    const events = analysis.activity.filter((event) => event.stage === stage);
    const latest = events.at(-1);
    return latest?.taskState ?? (latest ? "running" : "pending");
  };
  const hasCoordinatorActivity = analysis.activity.some((event) =>
    COORDINATOR_EXCLUSIVE_PROGRESS_STAGES.has(event.stage),
  );
  return (
    <div className="analysis-screen">
      <div className="analysis-kicker">
        <span className="live-dot" />{" "}
        {live
          ? `${providerName} · live analysis`
          : "Demo analysis · deterministic fixture"}
      </div>
      <h3>Building your walkthrough</h3>
      <p className="analysis-lede">
        {live
          ? `${providerName} is processing repository context. Progress is streamed from the local Electron service; no result is installed until validation succeeds.`
          : "This demo analysis is a deterministic local fixture and is not an analysis of a real pull request."}
      </p>
      {largePRNotice && (
        <p className="analysis-message" role="status">
          {largePRNotice}
        </p>
      )}
      {message && (
        <div className="analysis-message" role="status">
          {message}
        </div>
      )}
      {live && (
        <section className="agent-activity">
          <div className="agent-activity-head">
            <div>
              <strong>Agent activity</strong>
              <span>Operational events from the local scan</span>
            </div>
            <Activity size={14} />
          </div>
          <div
            className="agent-activity-log"
            role="log"
            aria-label="Agent activity"
            aria-live="polite"
          >
            {analysis.activity.length ? (
              analysis.activity.map((event) => (
                <div
                  className="agent-activity-row"
                  key={`${event.timestamp}:${event.message}`}
                >
                  <time dateTime={event.timestamp}>
                    {new Date(event.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                  <span>{event.message}</span>
                </div>
              ))
            ) : (
              <p>Waiting for the first activity event…</p>
            )}
          </div>
          <small>
            Shows scan operations and validation milestones, not private model
            reasoning.
          </small>
        </section>
      )}
      {live && hasCoordinatorActivity && (
        <section className="agent-activity coordinator-task-state" aria-label="Coordinator task state">
          <div className="agent-activity-head"><div><strong>Coordinator task state</strong><span>Independent task receipts remain visible while parallel work continues.</span></div><Workflow size={14} /></div>
          <div role="list" aria-label="Coordinator tasks">
            {coordinatorRows.map(([stage, label]) => {
              const state = coordinatorState(stage);
              return <div className="agent-activity-row" role="listitem" aria-label={`${label}: ${state}`} key={stage}><strong>{label}</strong><span>{state}</span></div>;
            })}
          </div>
        </section>
      )}
      <div className="stage-list">
        {analysisStages.map((stage: AnalysisStage, index) => (
          <div
            className={`analysis-stage ${index < analysis.stage ? "complete" : index === analysis.stage ? "current" : ""}`}
            key={stage.label}
          >
            <div className="stage-icon">
              {index < analysis.stage ? (
                <Check size={14} />
              ) : index === analysis.stage ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <span>{index + 1}</span>
              )}
            </div>
            <div>
              <strong>{stage.label}</strong>
              <span>{stage.detail}</span>
            </div>
            {index < analysis.stage && <span className="stage-done">Done</span>}
          </div>
        ))}
      </div>
      <div className="analysis-footer">
        <span>
          Stage {Math.min(analysis.stage + 1, analysisStages.length)} of{" "}
          {analysisStages.length}
        </span>
        <span aria-label="Analysis elapsed time">
          Elapsed {Math.floor(elapsedSeconds / 60)}:
          {String(elapsedSeconds % 60).padStart(2, "0")}
        </span>
        <div
          className={`progress-track ${analysis.running ? "indeterminate" : ""}`}
        >
          <span
            style={{
              width: `${(Math.min(analysis.stage, analysisStages.length) / analysisStages.length) * 100}%`,
            }}
          />
        </div>
        <button className="secondary-button" onClick={onCancel}>
          <Square size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

export function WalkthroughRich({
  pr,
  markGroup,
  reviewed,
  progress,
  updateProgress,
  openEvidence,
  openFlow,
}: {
  pr: PullRequest;
  markGroup: (group: ChangeGroup) => void;
  reviewed: Record<string, boolean>;
  progress: Record<string, ReviewProgress>;
  updateProgress: (
    stepId: string,
    status: ReviewProgressStatus,
    note: string,
  ) => void;
  openEvidence: (path: string, line?: number) => void;
  openFlow: (type: Flow["type"], nodeId: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const documentSteps = safeArray(pr.walkthrough?.walkthrough).map(
    (value, index) => objectValue(value),
  );
  const steps = documentSteps.length
    ? documentSteps
    : pr.groups.map((group, index) => ({
        id: `group-${group.id}`,
        title: group.title,
        changeGroupId: group.id,
        summary: group.description,
        reason: group.rationale,
        limitations: [],
        dependsOnStepIds: [],
        evidenceIds: group.evidenceIds ?? [],
        flowNodeIds: [],
        testIds: [],
        reviewInsightIds: [],
        index,
      }));
  const step = steps[active] ?? steps[0];
  const group =
    pr.groups.find((item) => item.id === step?.changeGroupId) ??
    pr.groups[active] ??
    pr.groups[0];
  if (!step || !group) return <EmptyAnalysis />;
  const runId = pr.walkthrough?.run.id ?? pr.id;
  const itemProgress = progress[`${runId}:${String(step.id)}`];
  const noteKey = `${runId}:${String(step.id)}`;
  const note = noteDrafts[noteKey] ?? itemProgress?.note ?? "";
  const status =
    itemProgress?.status ??
    (reviewed[reviewKey(pr.id, group.id)] ? "reviewed" : "pending");
  const evidence = safeArray(step.evidenceIds).flatMap((id) =>
    pr.evidence.filter((item) => item.id === id),
  );
  const evidenceItems: Array<{ id: string; path: string; line?: number }> =
    evidence.length
      ? evidence
      : group.files.map((path) => ({ id: path, path }));
  const tests = pr.tests.filter((test) =>
    safeArray(step.testIds).includes(test.id),
  );
  const insights = pr.insights.filter((insight) =>
    safeArray(step.reviewInsightIds).includes(insight.id),
  );
  const flowNodes = safeArray(step.flowNodeIds).flatMap((nodeId) =>
    pr.flows.flatMap((flow) =>
      flow.nodes
        .filter((node) => node.id === nodeId)
        .map((node) => ({ flow, node })),
    ),
  );
  const coordinatorEntries = (key: string) =>
    safeArray(pr.walkthrough?.[key])
      .map((entry) => objectValue(entry))
      .filter((entry) => {
        const changeGroupIds = safeArray(entry.changeGroupIds);
        return changeGroupIds.length === 0 || changeGroupIds.includes(group.id);
      });
  const risks = coordinatorEntries("risks");
  const dependencies = coordinatorEntries("dependencies");
  const unchangedInteractions = coordinatorEntries("unchangedInteractions");
  const setStatus = (next: ReviewProgressStatus) => {
    updateProgress(String(step.id), next, note);
    setNoteDrafts((current) => ({ ...current, [noteKey]: note }));
    if (next === "reviewed") markGroup(group);
  };
  return (
    <div className="walkthrough view-section">
      <div className="walkthrough-head">
        <div>
          <div className="eyebrow">
            Guided review · Step {active + 1} of {steps.length}
          </div>
          <h3>{safeString(step.title, group.title)}</h3>
          <p>{safeString(step.summary, group.description)}</p>
        </div>
        <div className="walkthrough-actions">
          <span
            className={`state-tag ${status === "follow-up" ? "active" : status === "skipped" ? "outdated" : status === "reviewed" ? "resolved" : "unknown"}`}
          >
            {status}
          </span>
        </div>
      </div>
      <div className="walkthrough-layout">
        <div className="step-rail">
          {steps.map((item, index) => {
            const current =
              progress[`${runId}:${String(item.id)}`]?.status ?? "pending";
            return (
              <button
                key={String(item.id)}
                className={`step-item ${index === active ? "active" : ""} ${current === "reviewed" ? "done" : ""}`}
                aria-label={`Step ${index + 1}: ${safeString(item.title)}`}
                onClick={() => setActive(index)}
              >
                <span className="step-number">
                  {current === "reviewed" ? (
                    <Check size={12} />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
                <span>
                  <strong>{safeString(item.title)}</strong>
                  <small>{current}</small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="walkthrough-body">
          <div className="reason-callout">
            <Sparkles size={15} />
            <div>
              <strong>Why review this now</strong>
              <p>{safeString(step.reason, group.rationale)}</p>
            </div>
          </div>
          {safeArray(step.dependsOnStepIds).length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Depends on earlier steps" />
              <p>{safeArray(step.dependsOnStepIds).join(" · ")}</p>
            </section>
          )}
          {safeArray(step.limitations).length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Step limitations" />
              <p>{safeArray(step.limitations).join(" · ")}</p>
            </section>
          )}
          {risks.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Risks and watchpoints" />
              <div className="flow-context-list">
                {risks.map((risk, index) => (
                  <div className="walkthrough-context-item" key={safeString(risk.id, `risk-${index + 1}`)}>
                    <strong>{safeString(risk.title, `Risk ${index + 1}`)}</strong>
                    <span>{safeString(risk.detail, "No additional risk detail provided.")}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {dependencies.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Cross-change dependencies" />
              <div className="flow-context-list">
                {dependencies.map((dependency, index) => (
                  <div className="walkthrough-context-item" key={safeString(dependency.id, `dependency-${index + 1}`)}>
                    <strong>{safeString(dependency.title, `Dependency ${index + 1}`)}</strong>
                    <span>{safeString(dependency.detail, "No additional dependency detail provided.")}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {unchangedInteractions.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Unchanged integration context" />
              <div className="flow-context-list">
                {unchangedInteractions.map((interaction, index) => (
                  <div className="walkthrough-context-item" key={safeString(interaction.id, `unchanged-${index + 1}`)}>
                    <strong>{safeString(interaction.title, `Unchanged interaction ${index + 1}`)}</strong>
                    <span>{safeString(interaction.detail, "No additional integration detail provided.")}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="behavior-compare">
            <div className="compare-col before">
              <div className="compare-label">Before</div>
              <p>{group.before}</p>
            </div>
            <div className="compare-arrow">
              <ArrowDown size={14} />
            </div>
            <div className="compare-col after">
              <div className="compare-label">What changed</div>
              <p>{group.after}</p>
            </div>
          </div>
          <section className="evidence-section">
            <SectionTitle label="Evidence" />
            <div className="evidence-list">
              {evidenceItems.map((item) => (
                <button
                  key={item.id}
                  className="evidence-row"
                  onClick={() => openEvidence(item.path, item.line)}
                >
                  <FileCode2 size={14} />
                  <code>
                    {item.path}
                    {item.line ? `:${item.line}` : ""}
                  </code>
                  <ExternalLink size={13} />
                </button>
              ))}
            </div>
          </section>
          {tests.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Related tests" />
              <p>{tests.map((test) => test.test).join(" · ")}</p>
            </section>
          )}
          {insights.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Active insights" />
              <p>{insights.map((insight) => insight.title).join(" · ")}</p>
            </section>
          )}
          {flowNodes.length > 0 && (
            <section className="evidence-section">
              <SectionTitle label="Related flow context" />
              <div className="flow-context-list">
                {flowNodes.map(({ flow, node }) => (
                  <button
                    key={`${flow.id}:${node.id}`}
                    type="button"
                    onClick={() => openFlow(flow.type, node.id)}
                  >
                    <strong>
                      {flow.title}: {node.label}
                    </strong>
                    <span>{node.explanation}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <label className="prompt-setting">
            <span>Review note</span>
            <textarea
              aria-label="Review note"
              value={note}
              maxLength={4000}
              rows={2}
              onChange={(event) =>
                setNoteDrafts((current) => ({
                  ...current,
                  [noteKey]: event.target.value,
                }))
              }
              placeholder="Optional local note"
            />
          </label>
          <div
            className="walkthrough-actions"
            role="group"
            aria-label="Step review status"
          >
            <button
              className="secondary-button"
              onClick={() => setStatus("pending")}
            >
              Pending
            </button>
            <button
              className="secondary-button"
              onClick={() => setStatus("follow-up")}
            >
              Needs follow-up
            </button>
            <button
              className="secondary-button"
              onClick={() => setStatus("skipped")}
            >
              Skip
            </button>
            <button
              className="primary-button"
              onClick={() => setStatus("reviewed")}
            >
              <Check size={14} /> Mark reviewed
            </button>
          </div>
          <div className="pager">
            <button
              className="secondary-button"
              disabled={active === 0}
              onClick={() => setActive((index) => Math.max(0, index - 1))}
            >
              ← Previous
            </button>
            <button
              className="primary-button"
              disabled={active === steps.length - 1}
              onClick={() =>
                setActive((index) => Math.min(steps.length - 1, index + 1))
              }
            >
              Next step <ArrowUp size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupsRich({
  pr,
  markGroup,
  reviewed,
  progress,
  updateProgress,
  openEvidence,
}: {
  pr: PullRequest;
  markGroup: (group: ChangeGroup) => void;
  reviewed: Record<string, boolean>;
  progress: Record<string, ReviewProgress>;
  updateProgress: (
    stepId: string,
    status: ReviewProgressStatus,
    note: string,
  ) => void;
  openEvidence: (path: string, line?: number) => void;
}) {
  const runId = pr.walkthrough?.run.id ?? pr.id;
  const steps = safeArray(pr.walkthrough?.walkthrough).map(objectValue);
  const groupSteps = (group: ChangeGroup) =>
    steps.filter((step) => step.changeGroupId === group.id);
  const status = (group: ChangeGroup): ReviewProgressStatus => {
    const values = groupSteps(group).map(
      (step) => progress[`${runId}:${String(step.id)}`]?.status ?? "pending",
    );
    return values.includes("follow-up")
      ? "follow-up"
      : values.length > 0 && values.every((value) => value === "reviewed")
        ? "reviewed"
        : values.length > 0 && values.every((value) => value === "skipped")
          ? "skipped"
          : reviewed[reviewKey(pr.id, group.id)]
            ? "reviewed"
            : "pending";
  };
  const setGroup = (group: ChangeGroup, next: ReviewProgressStatus) => {
    const linked = groupSteps(group);
    if (linked.length)
      linked.forEach((step) => updateProgress(String(step.id), next, ""));
    else markGroup(group);
  };
  const groupEvidenceItems = (group: ChangeGroup) => {
    const linked = (group.evidenceIds ?? []).flatMap((id) => {
      const item = pr.evidence.find((candidate) => candidate.id === id);
      return item
        ? [{ id: item.id, path: item.path, line: item.line ?? undefined }]
        : [];
    });
    return mergeGroupEvidenceItems(linked, group.files);
  };
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Structure"
        title="Logical change groups"
        description="A live run derives group state from its persisted walkthrough steps."
      />
      <div className="group-table">
        {pr.groups.map((group, index) => (
          <div className="group-row" key={group.id}>
            <div className="group-order">
              {String(index + 1).padStart(2, "0")}
            </div>
            <div className="group-main">
              <div className="group-title-line">
                <h4>{group.title}</h4>
                <AttentionTag level={group.attention} />
              </div>
              <p>{group.description}</p>
              <div className="file-chips">
                {groupEvidenceItems(group).map(({ id, path, line }) => {
                  return (
                    <button
                      type="button"
                      className="file-chip"
                      aria-label={`Open evidence ${path}${line ? `:${line}` : ""}`}
                      key={id}
                      onClick={() => openEvidence(path, line)}
                    >
                      <FileCode2 size={12} />
                      {path.split("/").pop()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className="walkthrough-actions"
              role="group"
              aria-label={`${group.title} review status`}
            >
              <span className="state-tag">{status(group)}</span>
              <button
                className="secondary-button"
                onClick={() => setGroup(group, "follow-up")}
              >
                Follow-up
              </button>
              <button
                className="secondary-button"
                onClick={() => setGroup(group, "skipped")}
              >
                Skip
              </button>
              <button
                className="review-button compact"
                onClick={() => setGroup(group, "reviewed")}
              >
                Mark reviewed
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InsightsView({
  insights,
  openEvidence,
}: {
  insights: ReviewInsight[];
  openEvidence: (path: string, line?: number) => void;
}) {
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Signal, with provenance"
        title="Review insights"
        description="Clusters preserve who raised a concern and whether it is still actionable."
      />
      <div className="insights-list">
        {insights.map((insight) => (
          <div className="insight-card" key={insight.id}>
            <div className="insight-card-top">
              <div className="insight-icon">
                <AlertCircle size={16} />
              </div>
              <div className="insight-head">
                <h4>{insight.title}</h4>
                <div className="insight-meta">
                  <span className={`provenance ${insight.provenance}`}>
                    {insight.provenance === "human" ? (
                      <UserRound size={12} />
                    ) : (
                      <Bot size={12} />
                    )}
                    {insight.provenance === "human"
                      ? "Human signal"
                      : "Automated signal"}
                  </span>
                  <StateTag state={insight.state} />
                  <span>{insight.count} mentions</span>
                </div>
              </div>
            </div>
            <p>{insight.detail}</p>
            <button
              className="location-link"
              onClick={() => openEvidence(insight.location)}
            >
              <FileCode2 size={13} /> {insight.location}{" "}
              <ExternalLink size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowsView({
  flows,
  flowType,
  setFlowType,
  selectedFlowNodeId,
  evidence,
  groups,
  threads,
  openEvidence,
}: {
  flows: Flow[];
  flowType: Flow["type"];
  setFlowType: (type: Flow["type"]) => void;
  selectedFlowNodeId: string | null;
  evidence: Evidence[];
  groups: ChangeGroup[];
  threads: ReviewThread[];
  openEvidence: (path: string, line?: number) => void;
}) {
  const flow = flows.find((item) => item.type === flowType) ?? flows[0];
  const [search, setSearch] = useState("");
  const [nodeFilter, setNodeFilter] = useState<"all" | "changed" | "context">(
    "all",
  );
  const [highlightedGroup, setHighlightedGroup] = useState("");
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState(0);
  const [canvasViewport, setCanvasViewport] = useState({ width: 0, height: 0 });
  const flowCanvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  useEffect(() => {
    setTourStep(0);
    setSelectedNode(
      selectedFlowNodeId &&
        flow?.nodes.some((node) => node.id === selectedFlowNodeId)
        ? selectedFlowNodeId
        : null,
    );
    setSearch("");
    setNodeFilter("all");
    setHighlightedGroup("");
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, [flow?.id, selectedFlowNodeId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key >= "1" && event.key <= "4")
        setFlowType(
          (
            [
              "system-overview",
              "data-flow",
              "code-dependency",
              "user-action",
            ] as Flow["type"][]
          )[Number(event.key) - 1],
        );
      if (event.key === "n" || event.key === "ArrowRight")
        setTourStep((step) =>
          Math.min((flow?.guidedTours[0]?.steps.length ?? 1) - 1, step + 1),
        );
      if (event.key === "p" || event.key === "ArrowLeft")
        setTourStep((step) => Math.max(0, step - 1));
      if (event.key === "+") setZoom((value) => Math.min(160, value + 10));
      if (event.key === "-")
        setZoom((value) => Math.max(MIN_GRAPH_ZOOM, value - 10));
      if (event.key === "0") {
        setZoom(100);
        setPan({ x: 0, y: 0 });
      }
      if (event.key === "/") {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>('[aria-label="Search flow nodes"]')
          ?.focus();
      }
      if (event.key === "Escape") setSelectedNode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow?.guidedTours, setFlowType]);
  useEffect(() => {
    const canvas = flowCanvasRef.current;
    if (!canvas) return;
    const measure = () =>
      setCanvasViewport({ width: canvas.clientWidth, height: canvas.clientHeight });
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  if (!flow) return <EmptyAnalysis />;
  const filteredNodes = flow.nodes.filter((node) => {
    const matchesKind =
      nodeFilter === "all" ||
      (nodeFilter === "changed" ? node.changed : !node.changed);
    return (
      matchesKind &&
      `${node.label} ${node.explanation} ${node.evidenceIds.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  const visibleIds = new Set(filteredNodes.map((node) => node.id));
  const selected =
    filteredNodes.find((node) => node.id === selectedNode) ?? filteredNodes[0];
  const tour = flow.guidedTours[0];
  const tourNodeId = tour?.steps[tourStep]?.nodeId;
  const tabLabels: Record<Flow["type"], string> = {
    "system-overview": "System overview",
    "data-flow": "Data flow",
    "code-dependency": "Code dependency",
    "user-action": "User action",
  };
  const overview = flow.type === "system-overview";
  const nodePosition = (index: number) =>
    overview
      ? { x: 60 + (index % 2) * 280, y: 55 + Math.floor(index / 2) * 145 }
      : { x: 90 + (index % 3) * 190, y: 70 + Math.floor(index / 3) * 110 };
  const nodeWidth = overview ? 220 : 132;
  const nodeHeight = overview ? 92 : 44;
  const rows = Math.max(1, Math.ceil(flow.nodes.length / (overview ? 2 : 3)));
  const surfaceWidth = overview ? 620 : 700;
  const surfaceHeight = Math.max(360, 100 + rows * (overview ? 145 : 110));
  const viewportWidth = canvasViewport.width || 700;
  const viewportHeight = canvasViewport.height || 360;
  const graphBounds = {
    x: 0,
    y: 0,
    width: viewportWidth / (zoom / 100),
    height: viewportHeight / (zoom / 100),
  };
  const fitToView = () => {
    setZoom(
      calculateFitZoom(
        surfaceWidth,
        surfaceHeight,
        viewportWidth,
        viewportHeight,
      ),
    );
    setPan({ x: 0, y: 0 });
  };
  const resetView = () => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  };
  const referencedEvidence = (selected?.evidenceIds ?? []).flatMap((id) => {
    const item = evidence.find((candidate) => candidate.id === id);
    return item ? [item] : [];
  });
  const associatedThreads = (selected?.reviewThreadIds ?? []).flatMap((id) => {
    const thread = threads.find((candidate) => candidate.id === id);
    return thread ? [thread] : [];
  });
  const graphGroups = groups.filter((group) =>
    flow.nodes.some((node) => node.changeGroupIds.includes(group.id)),
  );
  const visibleEdges = flow.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  const visibleNodeBoxes = filteredNodes.map((node) =>
    positionedGraphNodeBox(
      nodePosition(flow.nodes.findIndex((candidate) => candidate.id === node.id)),
      { width: nodeWidth, height: nodeHeight },
      !overview,
    ),
  );
  const edgeLaneCounts = new Map<string, number>();
  visibleEdges.forEach((edge) => {
    const key = `${edge.source}->${edge.target}`;
    edgeLaneCounts.set(key, (edgeLaneCounts.get(key) ?? 0) + 1);
  });
  const routeVisibleEdge = (
    edge: FlowEdge,
    edgeObstacles: GraphEdgeObstacle[] = [],
  ) => {
    const from = nodePosition(
      flow.nodes.findIndex((node) => node.id === edge.source),
    );
    const to = nodePosition(
      flow.nodes.findIndex((node) => node.id === edge.target),
    );
    const laneKey = `${edge.source}->${edge.target}`;
    const laneCount = edgeLaneCounts.get(laneKey) ?? 1;
    const laneIndex = visibleEdges
      .slice(0, visibleEdges.indexOf(edge))
      .filter(
        (candidate) =>
          `${candidate.source}->${candidate.target}` === laneKey,
      ).length;
    return routeGraphEdge(
      positionedGraphNodeBox(
        from,
        { width: nodeWidth, height: nodeHeight },
        !overview,
      ),
      positionedGraphNodeBox(
        to,
        { width: nodeWidth, height: nodeHeight },
        !overview,
      ),
      laneIndex,
      laneCount,
      visibleNodeBoxes,
      edgeObstacles,
      graphBounds,
    );
  };
  const initialEdgeRoutes = visibleEdges.map((edge) => routeVisibleEdge(edge));
  const edgeRoutes = initialEdgeRoutes.map((_, index) =>
    routeVisibleEdge(
      visibleEdges[index]!,
      initialEdgeRoutes.flatMap((route, routeIndex) =>
        routeIndex === index
          ? []
          : [{
              from: route.from,
              to: route.to,
              pathControl: route.pathControl,
            }],
      ),
    ),
  );
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Trace the system"
        title="Behavior flows"
        description="Four directed views keep subsystem context, data, code, and user actions distinct."
      />
      <div className="flow-tabs" role="tablist">
        {(
          [
            "system-overview",
            "data-flow",
            "code-dependency",
            "user-action",
          ] as Flow["type"][]
        ).map((type) => (
          <button
            key={type}
            role="tab"
            aria-label={tabLabels[type]}
            aria-selected={flowType === type}
            className={flowType === type ? "active" : ""}
            onClick={() => setFlowType(type)}
          >
            {tabLabels[type]}
          </button>
        ))}
      </div>
      <div className="flow-toolbar">
        <div className="search-box">
          <Search size={14} />
          <input
            aria-label="Search flow nodes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search flow nodes"
          />
          <kbd>/</kbd>
        </div>
        <div className="node-filter" aria-label="Graph node filter">
          {(["all", "changed", "context"] as const).map((kind) => (
            <button
              key={kind}
              className={`secondary-button ${nodeFilter === kind ? "active" : ""}`}
              aria-label={
                kind === "all"
                  ? "All nodes"
                  : kind === "changed"
                    ? "Changed nodes"
                    : "Context nodes"
              }
              onClick={() => setNodeFilter(kind)}
            >
              {kind === "all"
                ? "All"
                : kind === "changed"
                  ? "Changed"
                  : "Context"}
            </button>
          ))}
        </div>
        <label className="group-highlight">
          <span>Group</span>
          <SelectMenu
            ariaLabel="Highlight change group"
            value={highlightedGroup}
            options={[
              { value: "", label: "None" },
              ...graphGroups.map((group) => ({
                value: group.id,
                label: group.title,
              })),
            ]}
            onChange={setHighlightedGroup}
          />
        </label>
        <button
          className="secondary-button"
          aria-label="Zoom out"
          onClick={() =>
            setZoom((value) => Math.max(MIN_GRAPH_ZOOM, value - 10))
          }
        >
          −
        </button>
        <button
          className="secondary-button"
          aria-label="Zoom in"
          onClick={() => setZoom((value) => Math.min(160, value + 10))}
        >
          +
        </button>
        <button className="secondary-button" onClick={fitToView}>
          Fit to view
        </button>
        <button className="secondary-button" onClick={resetView}>
          Reset zoom
        </button>
        <span className="zoom-status" role="status" aria-label="Zoom level">
          {zoom}%
        </span>
      </div>
      <div className="flow-layout">
        <div
          className="flow-canvas"
          ref={flowCanvasRef}
          role="region"
          aria-label={`${tabLabels[flow.type]} graph`}
          onPointerDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("button,input,select")
            )
              return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              panX: pan.x,
              panY: pan.y,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current)
              setPan({
                x: drag.current.panX + event.clientX - drag.current.x,
                y: drag.current.panY + event.clientY - drag.current.y,
              });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div className="flow-grid" />
          <div
            className="flow-graph-surface"
            data-pan-x={pan.x}
            data-pan-y={pan.y}
            style={{
              width: surfaceWidth,
              height: surfaceHeight,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
              transformOrigin: "top left",
            }}
          >
            {!overview && (
              <svg
                className="flow-edges"
                aria-hidden="true"
                style={{ width: surfaceWidth, height: surfaceHeight }}
                viewBox={`0 0 ${surfaceWidth} ${surfaceHeight}`}
                preserveAspectRatio="none"
              >
                <defs>
                  <marker
                    id="flow-arrow"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L0,6 L7,3 z" fill="#75a9a1" />
                  </marker>
                </defs>
                {visibleEdges.map((edge, edgeIndex) => {
                    const geometry = edgeRoutes[edgeIndex]!;
                    return (
                      <g key={edge.id}>
                        {geometry.path ? (
                          <path
                            d={geometry.path}
                            markerEnd="url(#flow-arrow)"
                          />
                        ) : (
                          <line
                            x1={geometry.from.x}
                            y1={geometry.from.y}
                            x2={geometry.to.x}
                            y2={geometry.to.y}
                            markerEnd="url(#flow-arrow)"
                          />
                        )}
                        <foreignObject
                          className="flow-edge-label-wrap"
                          x={geometry.label.x - 60}
                          y={geometry.label.y - 12}
                          width="120"
                          height="24"
                          aria-label={edge.label}
                        >
                          <div className="flow-edge-label">{edge.label}</div>
                        </foreignObject>
                      </g>
                    );
                  })}
              </svg>
            )}
            {filteredNodes.map((node) => {
              const index = flow.nodes.findIndex(
                (candidate) => candidate.id === node.id,
              );
              const position = nodePosition(index);
              const groupMatch =
                !highlightedGroup ||
                node.changeGroupIds.includes(highlightedGroup);
              return (
                <button
                  key={node.id}
                  data-change-group-highlight={
                    highlightedGroup && groupMatch ? "true" : undefined
                  }
                  className={`flow-node ${overview ? "overview-card" : ""} ${node.changed ? "changed-node" : "context-node"} ${highlightedGroup && !groupMatch ? "group-muted" : ""} ${selected?.id === node.id || tourNodeId === node.id ? "focused" : ""}`}
                  style={{
                    left: position.x,
                    top: position.y,
                    width: nodeWidth,
                    minHeight: nodeHeight,
                  }}
                  onClick={() => setSelectedNode(node.id)}
                  aria-label={`${node.label}: ${node.explanation}`}
                >
                  <span className="flow-node-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {overview ? <strong>{node.label}</strong> : node.label}
                  {overview && <small>{node.explanation}</small>}
                </button>
              );
            })}
          </div>
          <div className="flow-tour">
            <span>
              Step {Math.min(tourStep + 1, tour?.steps.length ?? 1)} /{" "}
              {tour?.steps.length ?? 1}
            </span>
            <button
              className="secondary-button"
              aria-label="Previous tour"
              disabled={tourStep === 0}
              onClick={() => setTourStep((step) => Math.max(0, step - 1))}
            >
              Previous
            </button>
            <button
              className="secondary-button"
              aria-label="Next tour"
              disabled={tourStep >= (tour?.steps.length ?? 1) - 1}
              onClick={() =>
                setTourStep((step) =>
                  Math.min((tour?.steps.length ?? 1) - 1, step + 1),
                )
              }
            >
              Next
            </button>
            <button
              className="secondary-button"
              aria-label="Restart tour"
              onClick={() => setTourStep(0)}
            >
              Restart
            </button>
          </div>
        </div>
        <div className="flow-sidebar">
          <div className="eyebrow">{flow.type}</div>
          <h4>{flow.title}</h4>
          <p>{flow.description}</p>
          {selected && (
            <div className="node-detail">
              <div className="eyebrow">Selected node</div>
              <strong>Selected: {selected.label}</strong>
              <p>{selected.explanation}</p>
              {referencedEvidence.length ? (
                <div className="node-evidence">
                  {referencedEvidence.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => openEvidence(item.path, item.line)}
                    >
                      <FileCode2 size={12} />
                      {item.path}
                      {item.line ? `:${item.line}` : ""}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="muted">No evidence attached</span>
              )}
              {associatedThreads.length > 0 && (
                <div className="node-comments">
                  <strong>Associated review comments</strong>
                  {associatedThreads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() =>
                        openEvidence(thread.file, thread.line || undefined)
                      }
                    >
                      <MessageSquare size={12} />
                      <span>
                        <b>{thread.author}</b>
                        {thread.body}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flow-legend">
            <span>
              <i className="legend-dot changed" /> Changed boundary
            </span>
            <span>
              <i className="legend-dot context" /> Unchanged context
            </span>
          </div>
          <div className="flow-list-alt">
            <strong>Accessible list view</strong>
            {filteredNodes.map((node) => (
              <button key={node.id} onClick={() => setSelectedNode(node.id)}>
                <span>Node {node.label}</span>
                <small>{node.explanation}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilesRich({
  pr,
  openEvidence,
}: {
  pr: PullRequest;
  openEvidence: (path: string, line?: number) => void;
}) {
  const [mode, setMode] = useState<"logical" | "directory">("logical");
  const files = [
    ...new Set([
      ...pr.groups.flatMap((group) => group.files),
      ...pr.evidence.map((item) => item.path),
    ]),
  ];
  const groupsFor = (file: string) =>
    pr.groups.filter((group) => group.files.includes(file));
  const row = (file: string) => {
    const item = pr.evidence.find((candidate) => candidate.path === file);
    const groups = groupsFor(file);
    return (
      <button
        className="file-table-row"
        key={file}
        onClick={() => openEvidence(file, item?.line)}
      >
        <span className="file-path">
          <FileCode2 size={14} />
          <code>{file}</code>
        </span>
        <span>
          {groups.map((group) => group.title).join(" · ") || "Context"}
        </span>
        <span className="evidence-kind">{item?.kind ?? "file"}</span>
      </button>
    );
  };
  const directories = new Map<string, string[]>();
  for (const file of files) {
    const directory = file.includes("/")
      ? file.split("/").slice(0, -1).join("/")
      : "/";
    directories.set(directory, [...(directories.get(directory) ?? []), file]);
  }
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Evidence surface"
        title="Changed files"
        description="Switch between behavior ownership and the repository directory tree."
      />
      <div className="flow-tabs" role="tablist" aria-label="File organization">
        <button
          role="tab"
          aria-selected={mode === "logical"}
          className={mode === "logical" ? "active" : ""}
          onClick={() => setMode("logical")}
        >
          Logical changes
        </button>
        <button
          role="tab"
          aria-selected={mode === "directory"}
          className={mode === "directory" ? "active" : ""}
          onClick={() => setMode("directory")}
        >
          Directories
        </button>
      </div>
      <div className="file-table">
        <div className="file-table-head">
          <span>Path</span>
          <span>Change groups</span>
          <span>Evidence</span>
        </div>
        {mode === "logical"
          ? pr.groups.map((group) => (
              <section key={group.id} aria-label={group.title}>
                <h4>{group.title}</h4>
                {group.files.map(row)}
              </section>
            ))
          : [...directories.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([directory, entries]) => (
                <section key={directory} aria-label={`Directory ${directory}`}>
                  <h4>{directory}</h4>
                  {entries.map(row)}
                </section>
              ))}
      </div>
    </div>
  );
}

function TestsView({
  pr,
  openEvidence,
}: {
  pr: PullRequest;
  openEvidence: (path: string, line?: number) => void;
}) {
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Behavior coverage"
        title="Tests mapped to behavior"
        description="Generated interpretation is kept next to deterministic test paths."
      />
      <div className="test-list">
        {pr.tests.map((test) => (
          <div className="test-row" key={test.id}>
            <div className={`test-status ${test.status}`}>
              <span>
                {test.status === "covered"
                  ? "Covered"
                  : test.status === "partial"
                    ? "Partial"
                    : "Missing"}
              </span>
            </div>
            <div className="test-main">
              <strong>{test.test}</strong>
              <p>{test.behavior}</p>
            </div>
            <button
              className="test-evidence"
              onClick={() => openEvidence(test.evidence)}
            >
              <code>{test.evidence}</code>
              <ExternalLink size={12} />
            </button>
          </div>
        ))}
        {pr.tests.length === 0 && <EmptyAnalysis />}
      </div>
    </div>
  );
}

function DetailsView({
  pr,
  providerName,
  onReopen,
  onOpenRun,
  openEvidence,
  onDeleteRun,
  onPreferRun,
  onRegenerateRun,
  diagnostics,
  diagnosticExportMessage,
  onExportDiagnostics,
  retryProviders,
  onRetryWithProvider,
}: {
  pr: PullRequest;
  providerName: string;
  onReopen: () => void;
  onOpenRun: (runId: string) => void;
  openEvidence: (path: string, line?: number) => void;
  onDeleteRun: (runId: string) => void;
  onPreferRun: (runId: string) => void;
  onRegenerateRun: (runId: string) => void;
  diagnostics: AnalysisDiagnostics | null;
  diagnosticExportMessage: string;
  onExportDiagnostics: () => void;
  retryProviders: AgentInstallationStatus[];
  onRetryWithProvider: (provider: AgentProvider) => void;
}) {
  const live = pr.source === "github";
  const loadedProvider =
    pr.analysisProvenance && pr.analysisProvenance !== "demo"
      ? providerLabel(pr.analysisProvenance)
      : providerName;
  const loadedModel = safeString(
    pr.walkthrough?.run?.model,
    pr.history.find((run) => run.status === "completed")?.model ??
      "Tool default",
  );
  const sameProviderInstalled = retryProviders.some(
    (provider) => provider.provider === diagnostics?.manifest.provider,
  );
  return (
    <div className="view-section">
      <SectionIntro
        eyebrow="Reproducibility"
        title="Analysis details"
        description={
          live
            ? `A transparent record of the validated ${loadedProvider} artifact and persisted run history.`
            : "A transparent record of the deterministic local demo fixture."
        }
      />
      <div className="details-grid">
        <div className="detail-panel">
          <SectionTitle label="Runtime" />
          <dl>
            <dt>Mode</dt>
            <dd>
              {live
                ? "Electron + local artifact"
                : "Deterministic local fixture"}
            </dd>
            <dt>Provider</dt>
            <dd>{live ? loadedProvider : "Demo analysis"}</dd>
            <dt>Model</dt>
            <dd>{live ? loadedModel : "Fixture model"}</dd>
            <dt>Schema</dt>
            <dd>
              {pr.walkthrough?.schemaVersion ??
                pr.history.find((run) => run.schemaVersion)?.schemaVersion ??
                (live ? "walkthrough/1.1.0" : "walkthrough/v1")}
            </dd>
            <dt>Repository state</dt>
            <dd>
              <span className="status-inline ready" />{" "}
              {live ? "Validated revision" : "Fixture snapshot"}
            </dd>
          </dl>
        </div>
        <div className="detail-panel">
          <SectionTitle label="Evidence paths" />
          <div className="evidence-list">
            {pr.evidence.map((item) => (
              <button
                className="evidence-row"
                key={item.id}
                onClick={() => openEvidence(item.path, item.line)}
              >
                <FileCode2 size={14} />
                <code>
                  {item.path}
                  {item.line ? `:${item.line}` : ""}
                </code>
                <span className="evidence-kind">{item.kind}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {diagnostics && (
        <section
          className="diagnostics-panel"
          aria-label="Analysis diagnostics"
        >
          <SectionTitle label="Analysis diagnostics" />
          <p>
            {diagnostics.error?.code ?? diagnostics.manifest.status}:{" "}
            {diagnostics.error?.message ??
              "The run did not produce a validated walkthrough."}
          </p>
          <dl>
            <dt>Provider</dt>
            <dd>{providerLabel(diagnostics.manifest.provider)}</dd>
            <dt>Runtime</dt>
            <dd>
              {diagnostics.manifest.runtimeVersion ?? "Version not reported"}
            </dd>
            <dt>Last progress</dt>
            <dd>
              {diagnostics.manifest.lastProgress
                ? `${diagnostics.manifest.lastProgress.stage}: ${diagnostics.manifest.lastProgress.message}`
                : "No progress event was persisted"}
            </dd>
          </dl>
          {diagnostics.error?.details?.length ? (
            <details>
              <summary>Error details</summary>
              <ul>
                {diagnostics.error.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {diagnostics.manifest.activity?.length ? (
            <details>
              <summary>Recent agent activity</summary>
              <ol className="diagnostics-activity">
                {diagnostics.manifest.activity.slice(-20).map((event) => (
                  <li key={`${event.timestamp}:${event.message}`}>
                    {event.message}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {diagnostics.logExcerpt.length ? (
            <details>
              <summary>Bounded log excerpt</summary>
              <pre>{diagnostics.logExcerpt.join("\n")}</pre>
            </details>
          ) : null}
          <div className="diagnostics-actions">
            <button type="button" onClick={onExportDiagnostics}>
              Save diagnostic report
            </button>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  JSON.stringify(diagnostics, null, 2),
                )
              }
            >
              Copy diagnostics
            </button>
            {sameProviderInstalled && (
              <button
                type="button"
                onClick={() =>
                  onRetryWithProvider(diagnostics.manifest.provider)
                }
              >
                Retry with {providerLabel(diagnostics.manifest.provider)}
              </button>
            )}
            {retryProviders
              .filter(
                (provider) =>
                  provider.provider !== diagnostics.manifest.provider,
              )
              .map((provider) => (
                <button
                  key={provider.provider}
                  type="button"
                  onClick={() => onRetryWithProvider(provider.provider)}
                >
                  Retry with {provider.displayName}
                </button>
              ))}
          </div>
          <small className="failure-sharing-note">
            Saved reports include bounded logs and provider output. Review
            before sharing.
          </small>
          {diagnosticExportMessage && (
            <p className="diagnostic-export-status" role="status">
              {diagnosticExportMessage}
            </p>
          )}
        </section>
      )}
      <div className="run-history">
        <SectionTitle
          label="Run history"
          action={pr.groups.length ? "Reopen walkthrough" : undefined}
          onAction={pr.groups.length ? onReopen : undefined}
        />
        <div className="history-table">
          <div className="history-head">
            <span>Date</span>
            <span>Duration</span>
            <span>Provider</span>
            <span>Model</span>
            <span>Status</span>
          </div>
          {pr.history.map((run) => {
            const provider = run.provider
              ? providerLabel(run.provider)
              : "Demo runtime";
            const content = (
              <>
                <span>
                  <History size={13} />
                  {run.date}
                </span>
                <span>{run.duration}</span>
                <span>{provider}</span>
                <span>{run.model}</span>
                <span className={`run-status ${run.status}`}>
                  {run.status === "completed" ? "ready" : run.status}
                </span>
              </>
            );
            return live && run.status === "completed" ? (
              <div className="history-row" key={run.id}>
                {content}
                <button
                  type="button"
                  aria-label={`Open historical run ${run.date} ${provider} ${run.model}`}
                  onClick={() => onOpenRun(run.id)}
                >
                  Open
                </button>
                <button onClick={() => onPreferRun(run.id)}>Prefer</button>
                <button onClick={() => onRegenerateRun(run.id)}>
                  Regenerate
                </button>
                <button onClick={() => onDeleteRun(run.id)}>Delete</button>
              </div>
            ) : (
              <div className="history-row" key={run.id}>
                {content}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmptyAnalysis() {
  return (
    <div className="empty-analysis">
      <Sparkles size={20} />
      <h4>Walkthrough not generated yet</h4>
      <p>
        Start a local analysis to map this pull request into reviewable
        behavior.
      </p>
    </div>
  );
}

function EvidenceCodeView({ detail }: { detail: EvidenceDetail }) {
  const sections = detail.hunks.length
    ? detail.hunks
    : [{ header: "", content: detail.content }];
  return (
    <div
      className="evidence-code"
      role="table"
      aria-label="Unified evidence diff"
    >
      {sections.map((section, sectionIndex) => (
        <section
          className="evidence-code-section"
          role="rowgroup"
          key={`${section.header}-${sectionIndex}`}
        >
          {section.header && (
            <div className="evidence-hunk-header" role="heading" aria-level={5}>
              {section.header}
            </div>
          )}
          <div className="evidence-code-lines">
            {buildEvidenceCodeLines(
              section.content,
              detail.source,
              section.header || undefined,
            ).map((line, lineIndex) => (
              <div
                className={`evidence-code-line evidence-line-${line.kind} ${line.kind === "source" ? "evidence-line-context" : ""}`}
                data-line-kind={line.kind}
                role="row"
                aria-label={`${line.kind === "addition" ? "Added" : line.kind === "deletion" ? "Removed" : line.kind === "source" ? "Source" : "Context"} line ${line.newLine ?? line.oldLine ?? ""}: ${line.text}`}
                key={`${sectionIndex}-${lineIndex}`}
              >
                <span
                  className="evidence-line-gutter"
                  role="cell"
                  aria-hidden="true"
                >
                  {line.oldLine ?? ""}
                </span>
                <span
                  className="evidence-line-gutter"
                  role="cell"
                  aria-hidden="true"
                >
                  {line.newLine ?? ""}
                </span>
                <span
                  className="evidence-line-marker"
                  role="cell"
                  aria-hidden={line.kind === "context" || line.kind === "source"}
                >
                  {line.kind === "addition"
                    ? "+"
                    : line.kind === "deletion"
                      ? "−"
                      : " "}
                </span>
                {line.kind === "addition" && (
                  <span className="sr-only">Added line</span>
                )}
                {line.kind === "deletion" && (
                  <span className="sr-only">Removed line</span>
                )}
                <span role="cell">
                  <code>{line.text || " "}</code>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof LayoutList;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="metric">
      <Icon size={16} />
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small>{hint}</small>
      </div>
    </div>
  );
}
function SectionTitle({
  label,
  action,
  onAction,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-title">
      <h4>{label}</h4>
      {action && (
        <button onClick={onAction}>
          {action} <ArrowUp size={12} />
        </button>
      )}
    </div>
  );
}
function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="section-intro">
      <div className="eyebrow">{eyebrow}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function AttentionTag({ level }: { level: ChangeGroup["attention"] }) {
  return (
    <span className={`attention ${level}`}>
      <span />
      {level} attention
    </span>
  );
}
function StateTag({ state }: { state: ReviewState }) {
  return <span className={`state-tag ${state}`}>{state}</span>;
}
function InsightRow({ insight }: { insight: ReviewInsight }) {
  return (
    <div className="pulse-row">
      <div className={`pulse-icon ${insight.state}`}>
        <AlertCircle size={14} />
      </div>
      <div>
        <strong>{insight.title}</strong>
        <span>
          {insight.provenance} · {insight.state}
        </span>
      </div>
      <span className="pulse-count">{insight.count}</span>
    </div>
  );
}
function EvidenceStrip({ pr }: { pr: PullRequest }) {
  return (
    <div className="evidence-strip">
      <div>
        <div className="eyebrow">Evidence first</div>
        <strong>Every interpretation points back to repository facts.</strong>
        <p>
          Files, symbols, tests, and threads stay one click away throughout the
          walkthrough.
        </p>
      </div>
      <div className="evidence-strip-items">
        {pr.evidence.slice(0, 3).map((item) => (
          <span key={item.id}>
            <FileCode2 size={13} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default App;
