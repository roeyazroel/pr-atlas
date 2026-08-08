import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BATCHING_THRESHOLDS,
  buildBatchPlan,
  buildBatchMapValidatorScript,
  shouldBatchAnalysis,
  validateBatchMapOutput,
  parseGitDiffSections,
} from "../../electron/backend/batching";

async function runMapValidator(script: string, candidate: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pr-atlas-map-validator-"));
  const path = join(directory, "validate-map-output.mjs");
  await writeFile(path, script, "utf8");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(JSON.stringify(candidate));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("large PR batching", () => {
  it("uses the deterministic file-or-change threshold", () => {
    expect(shouldBatchAnalysis({ files: 19, changes: 999 })).toBe(false);
    expect(shouldBatchAnalysis({ files: BATCHING_THRESHOLDS.files, changes: 1 })).toBe(true);
    expect(shouldBatchAnalysis({ files: 1, changes: BATCHING_THRESHOLDS.changes })).toBe(true);
  });

  it("is deterministic, bounded, and covers each source file exactly once", () => {
    const files = [
      { path: "electron/backend/a.ts", diff: "a".repeat(80) },
      { path: "electron/backend/b.ts", diff: "b".repeat(80) },
      { path: "src/ui/c.tsx", diff: "c".repeat(70) },
      { path: "src/ui/d.tsx", diff: "d".repeat(70) },
    ];
    const plan = buildBatchPlan(files, { maxChunkBytes: 160 });
    expect(plan).toEqual(buildBatchPlan([...files].reverse(), { maxChunkBytes: 160 }));
    expect(plan.chunks.every((chunk) => chunk.bytes <= 160)).toBe(true);
    expect(plan.coverage).toEqual({ complete: true, missing: [], duplicated: [] });
    expect(plan.chunks.map((chunk) => chunk.files.map((file) => file.path))).toEqual([
      ["electron/backend/a.ts", "electron/backend/b.ts"],
      ["src/ui/c.tsx", "src/ui/d.tsx"],
    ]);
  });

  it("splits oversized files on bounded hunk windows with overlap", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,1 @@", "+one", "@@ -20,1 +20,1 @@", "+two", "@@ -40,1 +40,1 @@", "+three"].join("\n");
    const plan = buildBatchPlan([{ path: "a.ts", diff }], { maxChunkBytes: 55, overlapBytes: 12 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.every((chunk) => chunk.bytes <= 55)).toBe(true);
    expect(plan.coverage).toEqual({ complete: true, missing: [], duplicated: [] });
    expect(plan.chunks.flatMap((chunk) => chunk.files).every((file) => file.path === "a.ts")).toBe(true);
    expect(new Set(plan.chunks.flatMap((chunk) => chunk.files.map((file) => `${file.path}:${file.segment}`))).size).toBe(plan.chunks.flatMap((chunk) => chunk.files).length);
  });

  it("accepts only a complete map response for its assigned task", () => {
    const task = { id: "map-001", files: [{ path: "a.ts", diff: "x", bytes: 1, segment: 0 }] };
    const observation = { path: "a.ts", segment: 0, summary: "Changed x.", evidence: [{ path: "a.ts", line: 1 }], changeGroups: ["change"], tests: [], flows: [], limitations: [] };
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [observation] }, task).valid).toBe(true);
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [] }, task).valid).toBe(false);
    expect(validateBatchMapOutput({ taskId: "map-002", observations: [] }, task).valid).toBe(false);
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [{ ...observation, path: "other.ts" }] }, task).valid).toBe(false);
    expect(validateBatchMapOutput({ taskId: "map-001", extra: true, observations: [observation] }, task).valid).toBe(false);
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [{ ...observation, evidence: [] }] }, task).valid).toBe(false);
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [{ ...observation, evidence: [{ path: "a.ts", line: 0 }] }] }, task).valid).toBe(false);
    const canonical = validateBatchMapOutput({ taskId: "map-001", observations: [observation] }, task).output;
    expect(canonical).toEqual({ taskId: "map-001", observations: [observation] });
    expect(canonical?.observations[0]).not.toBe(observation);
    expect(validateBatchMapOutput({ taskId: "map-001", observations: [{ ...observation, segment: 1 }] }, task).valid).toBe(false);
    const segmented = { id: "map-002", files: [{ path: "a.ts", diff: "x", bytes: 1, segment: 0 }, { path: "a.ts", diff: "y", bytes: 1, segment: 1 }] };
    const merged = validateBatchMapOutput({ taskId: "map-002", observations: [{ ...observation, summary: "First." }, { ...observation, summary: "Second.", tests: ["test"], flows: ["flow"], limitations: ["limit"] }, { ...observation, segment: 1 }] }, segmented);
    expect(merged.valid).toBe(true);
    expect(merged.output?.observations).toHaveLength(2);
    expect(merged.output?.observations[0].summary).toContain("First.");
    expect(merged.output?.observations[0].summary).toContain("Second.");
    const bounded = validateBatchMapOutput({ taskId: "map-001", observations: [{ ...observation, summary: "a".repeat(8_000) }, { ...observation, summary: "b".repeat(8_000) }] }, task);
    expect(bounded.output?.observations[0].summary).toHaveLength(8_000);
  });

  it("generates a standalone map validator with exact, actionable coverage diagnostics", async () => {
    const task = { id: "map-002", files: [{ path: "src/data/demo.ts", diff: "x", bytes: 1, segment: 0 }, { path: "src/styles.css", diff: "y", bytes: 1, segment: 1 }] };
    const observation = (path: string, segment: number) => ({ path, segment, summary: `Changed ${path}.`, evidence: [{ path, line: 1 }], changeGroups: ["change"], tests: [], flows: [], limitations: [] });
    const script = buildBatchMapValidatorScript(task);
    expect(script).not.toMatch(/require\(|from\s+['"][^'"./]/);

    await expect(runMapValidator(script, { taskId: task.id, observations: [observation("src/data/demo.ts", 0), observation("src/styles.css", 1)] })).resolves.toMatchObject({ code: 0, stdout: expect.stringMatching(/passed/i) });
    await expect(runMapValidator(script, { taskId: task.id, observations: [] })).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/missing assigned unit: src\/data\/demo\.ts#0/i) });
    await expect(runMapValidator(script, { taskId: task.id, observations: [observation("src/data/demo.ts", 0), observation("src/data/demo.ts", 0), observation("src/styles.css", 1)] })).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/duplicate assigned unit: src\/data\/demo\.ts#0/i) });
    await expect(runMapValidator(script, { taskId: task.id, observations: [observation("src/data/demo.ts", 0), observation("elsewhere.ts", 0), observation("src/styles.css", 1)] })).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/out-of-scope assigned unit: elsewhere\.ts#0/i) });
    await expect(runMapValidator(script, { taskId: task.id, observations: [observation("src/data/demo.ts", 0), { ...observation("src/styles.css", 1), evidence: [{ path: "src/styles.css", line: 0 }] }] })).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/line must be null or an integer at least 1/i) });
  });

  it("parses quoted Unicode, rename, deletion, and oversized diff sections without losing evidence", () => {
    const unicode = "caf\\303\\251.ts";
    const diff = [
      `diff --git "a/${unicode}" "b/${unicode}"`, `--- "a/${unicode}"`, `+++ "b/${unicode}"`, "@@ -1 +1 @@", "+one",
      "diff --git a/old-name.ts b/new-name.ts", "similarity index 90%", "rename from old-name.ts", "rename to new-name.ts", "--- a/old-name.ts", "+++ b/new-name.ts", "@@ -1 +1 @@", "+two",
      "diff --git a/deleted.ts b/deleted.ts", "deleted file mode 100644", "--- a/deleted.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
      "diff --git a/large.ts b/large.ts", "--- a/large.ts", "+++ b/large.ts", "@@ -1 +1 @@", `+${"x".repeat(10_000)}`,
    ].join("\n");
    const sections = parseGitDiffSections(diff);
    expect([...sections.keys()]).toEqual(["café.ts", "new-name.ts", "deleted.ts", "large.ts"]);
    expect([...sections.values()].every((section) => section.length > 0)).toBe(true);
    expect(sections.get("large.ts")?.length).toBeGreaterThan(10_000);
  });

  it("decodes Git C-style control, slash, and quote escapes in quoted paths", () => {
    const escaped = "line\\rbreak\\tbell\\aform\\fvertical\\vback\\\\quote\\\".ts";
    const diff = [`diff --git "a/${escaped}" "b/${escaped}"`, `--- "a/${escaped}"`, `+++ "b/${escaped}"`, "@@ -1 +1 @@", "+content"].join("\n");
    const sections = parseGitDiffSections(diff);
    const path = "line\rbreak\tbell\u0007form\fvertical\u000bback\\quote\".ts";
    expect([...sections.keys()]).toEqual([path]);
    expect(sections.get(path)).toContain("+content");
  });

  it("uses extended headers and a space-safe diff boundary when binary or pure rename sections lack markers", () => {
    const diff = [
      "diff --git a/assets/logo final.png b/assets/logo final.png", "new file mode 100644", "Binary files /dev/null and b/assets/logo final.png differ",
      "diff --git a/docs/old name.md b/docs/new name.md", "similarity index 100%", "rename from docs/old name.md", "rename to docs/new name.md",
    ].join("\n");
    const sections = parseGitDiffSections(diff);
    expect([...sections.keys()]).toEqual(["assets/logo final.png", "docs/new name.md"]);
    expect([...sections.values()].every((section) => section.trim().length > 0)).toBe(true);
  });
});
