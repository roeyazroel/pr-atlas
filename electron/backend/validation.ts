import {
  DEFAULT_ANALYSIS_RUN_CONFIG,
  type AnalysisEffort,
  type AnalysisRequest,
  type AnalysisRunConfig,
  type SafeDiagnostic,
} from "../../shared/contracts.js";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[a-fA-F0-9]{7,64}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,+-]{0,199}$/;
const analysisEfforts: readonly AnalysisEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function validateRepository(value: unknown): value is string {
  return (
    typeof value === "string" &&
    repositoryPattern.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}
export function validatePullNumber(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 2_147_483_647
  );
}
export function validateCommentBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 65_536 &&
    !/[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)
  );
}
export function safeError(
  code: string,
  message: string,
  details?: string[],
): SafeDiagnostic {
  return { code, message, ...(details?.length ? { details } : {}) };
}
function validateAnalysisRunConfig(
  value: unknown,
): AnalysisRunConfig | null {
  if (value === undefined) return { ...DEFAULT_ANALYSIS_RUN_CONFIG };
  if (!value || typeof value !== "object") return null;
  const config = value as Partial<AnalysisRunConfig>;
  if (
    config.depth !== "quick" &&
    config.depth !== "standard" &&
    config.depth !== "deep"
  )
    return null;
  if (typeof config.includeReviewComments !== "boolean") return null;
  if (config.scanMode !== undefined && config.scanMode !== "coordinator" && config.scanMode !== "legacy")
    return null;
  if (
    !Number.isInteger(config.maxGraphNodes) ||
    (config.maxGraphNodes as number) < 20 ||
    (config.maxGraphNodes as number) > 200
  )
    return null;
  if (
    !Number.isInteger(config.timeoutMinutes) ||
    (config.timeoutMinutes as number) < 1 ||
    (config.timeoutMinutes as number) > 60
  )
    return null;
  return {
    depth: config.depth,
    scanMode: config.scanMode ?? "coordinator",
    includeReviewComments: config.includeReviewComments,
    maxGraphNodes: config.maxGraphNodes as number,
    timeoutMinutes: config.timeoutMinutes as number,
  };
}
export function validateAnalysisRequest(
  value: unknown,
):
  | { valid: true; value: AnalysisRequest }
  | { valid: false; error: SafeDiagnostic } {
  if (!value || typeof value !== "object")
    return {
      valid: false,
      error: safeError(
        "INVALID_REQUEST",
        "Analysis request must be an object.",
      ),
    };
  const request = value as Partial<AnalysisRequest>;
  if (!validateRepository(request.repository))
    return {
      valid: false,
      error: safeError(
        "INVALID_REPOSITORY",
        "Repository must be an owner/name pair.",
      ),
    };
  if (!validatePullNumber(request.pullNumber))
    return {
      valid: false,
      error: safeError(
        "INVALID_PULL_NUMBER",
        "Pull request number must be a positive integer.",
      ),
    };
  if (
    !shaPattern.test(request.baseSha ?? "") ||
    !shaPattern.test(request.headSha ?? "")
  )
    return {
      valid: false,
      error: safeError(
        "INVALID_SHA",
        "Base and head revisions must be commit SHA values.",
      ),
    };
  if (
    request.provider !== "claude" &&
    request.provider !== "codex" &&
    request.provider !== "cursor"
  )
    return {
      valid: false,
      error: safeError(
        "INVALID_PROVIDER",
        "Provider must be Claude Code, Codex CLI, or Cursor Agent.",
      ),
    };
  if (
    request.model !== undefined &&
    (typeof request.model !== "string" || !modelPattern.test(request.model))
  )
    return {
      valid: false,
      error: safeError(
        "INVALID_MODEL",
        "Selected model must be a provider-reported model id.",
      ),
    };
  if (
    request.effort !== undefined &&
    !analysisEfforts.includes(request.effort)
  )
    return {
      valid: false,
      error: safeError(
        "INVALID_EFFORT",
        "Thinking effort must be a supported level.",
      ),
    };
  if (
    request.customPrompt !== undefined &&
    (typeof request.customPrompt !== "string" ||
      request.customPrompt.length > 4_000 ||
      /[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(request.customPrompt))
  )
    return {
      valid: false,
      error: safeError(
        "INVALID_CUSTOM_PROMPT",
        "Supplemental collection guidance must be at most 4,000 safe text characters.",
      ),
    };
  const config = validateAnalysisRunConfig(request.config);
  if (!config)
    return {
      valid: false,
      error: safeError(
        "INVALID_ANALYSIS_CONFIG",
        "Analysis configuration contains unsupported values.",
      ),
    };
  const normalized: AnalysisRequest = {
    ...(request as AnalysisRequest),
    config,
    ...(request.customPrompt !== undefined
      ? { customPrompt: request.customPrompt.trim() }
      : {}),
  };
  if (normalized.provider === "cursor") {
    const cursorRequest = { ...normalized };
    delete cursorRequest.effort;
    return { valid: true, value: cursorRequest };
  }
  return { valid: true, value: normalized };
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
