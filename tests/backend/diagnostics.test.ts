import { describe, expect, it } from "vitest";
import {
  diagnosticReportFilename,
  serializeDiagnosticReport,
} from "../../electron/backend/diagnostics";
import type { AnalysisDiagnostics } from "../../shared/contracts";

const diagnostics: AnalysisDiagnostics = {
  manifest: {
    runId: "run-failed",
    repository: "acme/atlas",
    pullNumber: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    provider: "cursor",
    status: "invalid",
    createdAt: "2026-08-06T06:27:44.110Z",
    completedAt: "2026-08-06T06:29:41.116Z",
    error: {
      code: "INVALID_WALKTHROUGH",
      message: "Generated walkthrough failed validation.",
      details: ["Map output must be a closed object."],
    },
  },
  error: {
    code: "INVALID_WALKTHROUGH",
    message: "Generated walkthrough failed validation.",
    details: ["Map output must be a closed object."],
  },
  logExcerpt: ["provider stderr excerpt"],
  rawOutputExcerpt: "redacted provider result envelope",
};

describe("analysis diagnostic reports", () => {
  it("creates a portable, self-describing report with a sharing warning", () => {
    const report = JSON.parse(
      serializeDiagnosticReport(diagnostics, {
        appVersion: "0.5.0",
        platform: "darwin",
        arch: "arm64",
        generatedAt: "2026-08-06T07:00:00.000Z",
      }),
    );

    expect(report).toMatchObject({
      formatVersion: 1,
      generatedAt: "2026-08-06T07:00:00.000Z",
      app: { version: "0.5.0", platform: "darwin", arch: "arm64" },
      analysis: {
        error: { code: "INVALID_WALKTHROUGH" },
        rawOutputExcerpt: "redacted provider result envelope",
      },
    });
    expect(report.sharingNotice).toMatch(/provider output|repository/i);
  });

  it("builds a filesystem-safe filename without exposing the full run id", () => {
    expect(
      diagnosticReportFilename("acme/atlas", 42, "3e1e4488-46af-435e-b021-ff32e639c823"),
    ).toBe("pr-atlas-acme-atlas-pr-42-3e1e4488-diagnostics.json");
  });
});
