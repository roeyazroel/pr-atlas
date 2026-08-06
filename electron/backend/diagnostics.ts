import type { AnalysisDiagnostics } from "../../shared/contracts.js";

export interface DiagnosticReportMetadata {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  generatedAt?: string;
}

export function diagnosticReportFilename(
  repository: string,
  pullNumber: number,
  runId: string,
): string {
  const repositorySlug = repository
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "repository";
  const runSlug = runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "run";
  return `pr-atlas-${repositorySlug}-pr-${pullNumber}-${runSlug}-diagnostics.json`;
}

export function serializeDiagnosticReport(
  diagnostics: AnalysisDiagnostics,
  metadata: DiagnosticReportMetadata,
): string {
  return `${JSON.stringify(
    {
      formatVersion: 1,
      generatedAt: metadata.generatedAt ?? new Date().toISOString(),
      sharingNotice:
        "Review before sharing: this report contains repository identifiers, local runtime metadata, log excerpts, and bounded provider output.",
      app: {
        version: metadata.appVersion,
        platform: metadata.platform,
        arch: metadata.arch,
      },
      analysis: diagnostics,
    },
    null,
    2,
  )}\n`;
}
