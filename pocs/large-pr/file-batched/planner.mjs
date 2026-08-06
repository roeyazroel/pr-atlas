import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULTS = {
  maxChunkBytes: 160 * 1024,
  parallelism: 4,
  sharedPromptBytes: 2 * 1024,
};

/**
 * Load the locally captured Atlas inputs. files.json is paginated, so nested
 * arrays are flattened and filenames are deduplicated before planning.
 */
export async function loadAtlasInput(inputDirectory) {
  const [rawFiles, diff] = await Promise.all([
    readFile(join(inputDirectory, "files.json"), "utf8"),
    readFile(join(inputDirectory, "diff.patch"), "utf8"),
  ]);
  const metadata = flattenFilePages(JSON.parse(rawFiles));
  const sections = parseDiffSections(diff);
  const byPath = new Map();

  for (const entry of metadata) {
    if (!entry.filename || byPath.has(entry.filename)) continue;
    const section = sections.get(entry.filename);
    const fallback = typeof entry.patch === "string" ? entry.patch : "";
    const content = section ?? fallback;
    byPath.set(entry.filename, {
      path: entry.filename,
      subsystem: subsystemFor(entry.filename),
      diff: content,
      diffBytes: byteLength(content),
      source: section ? "diff.patch" : fallback ? "files.json.patch" : "metadata-only",
    });
  }

  return {
    inputDirectory,
    diffBytes: byteLength(diff),
    files: [...byPath.values()].sort(comparePath),
  };
}

/** Split a unified diff into its complete, file-scoped sections. */
export function parseDiffSections(diff) {
  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index);
  const sections = new Map();
  for (let index = 0; index < starts.length; index += 1) {
    const section = diff.slice(starts[index], starts[index + 1]);
    const newPath = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const headerPath = section.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2];
    const path = newPath ?? headerPath;
    if (path) sections.set(path, section);
  }
  return sections;
}

/**
 * Deterministic first-fit decreasing partitioner. It fills a same-subsystem
 * chunk first; only then does it mix subsystems to meet the byte ceiling.
 * A single oversized file is retained as an explicitly marked exception: a
 * file is never split, so its evidence can be reviewed intact.
 */
export function buildFileBatchedPlan(files, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const normalized = files
    .map((file) => ({
      path: file.path,
      subsystem: file.subsystem ?? subsystemFor(file.path),
      diff: file.diff ?? "",
      diffBytes: Math.max(0, Math.trunc(file.diffBytes ?? byteLength(file.diff ?? ""))),
      source: file.source ?? "synthetic",
    }))
    .sort(compareSizeThenPath);
  assertUniquePaths(normalized);

  const chunks = [];
  for (const file of normalized) {
    const fitting = chunks.filter((chunk) => chunk.diffBytes + file.diffBytes <= options.maxChunkBytes);
    const affinity = fitting.filter((chunk) => chunk.subsystems.has(file.subsystem));
    const target = chooseLeastLoaded(affinity.length ? affinity : fitting);
    if (target) {
      target.files.push(file);
      target.diffBytes += file.diffBytes;
      target.subsystems.add(file.subsystem);
      continue;
    }
    chunks.push({
      files: [file],
      diffBytes: file.diffBytes,
      subsystems: new Set([file.subsystem]),
      oversized: file.diffBytes > options.maxChunkBytes,
    });
  }

  const materializedChunks = chunks
    .map((chunk, index) => ({
      id: `chunk-${String(index + 1).padStart(3, "0")}`,
      files: chunk.files.slice().sort(comparePath),
      diffBytes: chunk.diffBytes,
      subsystems: [...chunk.subsystems].sort(),
      oversized: chunk.oversized,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const mapTasks = materializedChunks.map((chunk, index) => ({
    id: `map-${String(index + 1).padStart(3, "0")}`,
    chunkId: chunk.id,
    files: chunk.files,
    diffBytes: chunk.diffBytes,
    estimatedPromptBytes: options.sharedPromptBytes + chunk.diffBytes,
    instruction: "Analyze only these changed files. Return evidence-backed findings keyed by path; do not infer changes outside this task.",
  }));
  const plan = {
    version: 1,
    id: planId(normalized, options),
    options,
    files: normalized.slice().sort(comparePath),
    chunks: materializedChunks,
    mapTasks,
  };
  assertPlanCoverage(plan);
  return plan;
}

/** Throws if the plan loses, duplicates, or silently violates its byte bound. */
export function assertPlanCoverage(plan) {
  const expected = plan.files.map((file) => file.path).sort();
  const actual = plan.chunks.flatMap((chunk) => chunk.files.map((file) => file.path)).sort();
  const duplicated = actual.filter((path, index) => index > 0 && path === actual[index - 1]);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const overLimit = plan.chunks
    .filter((chunk) => chunk.diffBytes > plan.options.maxChunkBytes && !chunk.oversized)
    .map((chunk) => chunk.id);
  if (missing.length || duplicated.length || unexpected.length || overLimit.length) {
    throw new Error(`Invalid partition: missing=${missing.join(",")}; duplicated=${duplicated.join(",")}; unexpected=${unexpected.join(",")}; overLimit=${overLimit.join(",")}`);
  }
  return { complete: true, missing, duplicated, unexpected, overLimit };
}

/**
 * Canonical reduce payload. Provider map results may arrive in any order but
 * are checked and serialized in map-task order, so reduce runs are replayable.
 */
export function buildReduceInput(plan, mapResults) {
  const expected = plan.mapTasks.map((task) => task.id);
  const byTask = new Map();
  for (const result of mapResults) {
    if (!result?.taskId || !expected.includes(result.taskId)) throw new Error(`Unknown map output: ${result?.taskId ?? "missing taskId"}.`);
    if (byTask.has(result.taskId)) throw new Error(`Duplicate map output: ${result.taskId}.`);
    byTask.set(result.taskId, result);
  }
  const missing = expected.filter((taskId) => !byTask.has(taskId));
  if (missing.length) throw new Error(`Missing map output: ${missing.join(", ")}.`);
  return {
    version: 1,
    planId: plan.id,
    instruction: "Merge only supplied findings. Preserve each finding path and taskId; resolve duplicate observations without inventing evidence.",
    coverage: assertPlanCoverage(plan),
    mapResults: expected.map((taskId) => byTask.get(taskId)),
  };
}

/** Metrics used to compare map/reduce with a single full-diff provider call. */
export function summarizePlan(plan) {
  const coverage = assertPlanCoverage(plan);
  const loads = Array.from({ length: plan.options.parallelism }, () => 0);
  for (const task of plan.mapTasks.slice().sort((left, right) => right.estimatedPromptBytes - left.estimatedPromptBytes || left.id.localeCompare(right.id))) {
    const worker = loads.indexOf(Math.min(...loads));
    loads[worker] += task.estimatedPromptBytes;
  }
  const chunkBytes = plan.chunks.map((chunk) => chunk.diffBytes);
  const totalDiffBytes = chunkBytes.reduce((sum, bytes) => sum + bytes, 0);
  const maxChunkBytes = Math.max(0, ...chunkBytes);
  const monolithicPromptBytes = plan.options.sharedPromptBytes + totalDiffBytes;
  const maxMapPromptBytes = plan.options.sharedPromptBytes + maxChunkBytes;
  const aggregateMapPromptBytes = plan.mapTasks.reduce((sum, task) => sum + task.estimatedPromptBytes, 0);
  return {
    planId: plan.id,
    files: plan.files.length,
    chunks: plan.chunks.length,
    coverage,
    chunkBalance: {
      minBytes: plan.chunks.length ? Math.min(...chunkBytes) : 0,
      maxBytes: maxChunkBytes,
      averageBytes: plan.chunks.length ? totalDiffBytes / plan.chunks.length : 0,
      imbalanceRatio: plan.chunks.length && totalDiffBytes ? maxChunkBytes / (totalDiffBytes / plan.chunks.length) : 0,
      oversizedChunks: plan.chunks.filter((chunk) => chunk.oversized).map((chunk) => chunk.id),
    },
    prompt: {
      monolithicPromptBytes,
      maxMapPromptBytes,
      perCallReductionBytes: Math.max(0, monolithicPromptBytes - maxMapPromptBytes),
      perCallReductionPercent: percentReduction(monolithicPromptBytes, maxMapPromptBytes),
      aggregateMapPromptBytes,
      aggregateMapOverheadBytes: aggregateMapPromptBytes - monolithicPromptBytes,
    },
    parallel: {
      workers: plan.options.parallelism,
      serialBytes: aggregateMapPromptBytes,
      criticalPathBytes: Math.max(0, ...loads),
      speedupEstimate: Math.max(0, aggregateMapPromptBytes / Math.max(1, ...loads)),
      workerLoads: loads,
    },
  };
}

/** Write provider-neutral replay inputs and blank output templates; no calls occur. */
export async function writeReplayBundle(plan, outputDirectory) {
  const summary = summarizePlan(plan);
  const resultTemplate = plan.mapTasks.map((task) => ({
    taskId: task.id,
    findings: [],
    notes: "Fill with a provider's structured map result, then pass all results to buildReduceInput.",
  }));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson(join(outputDirectory, "plan.json"), { plan, summary }),
    writeJson(join(outputDirectory, "map-tasks.json"), plan.mapTasks),
    writeJson(join(outputDirectory, "map-output.template.json"), resultTemplate),
    writeJson(join(outputDirectory, "reduce-input.template.json"), {
      version: 1,
      planId: plan.id,
      expectedTaskIds: plan.mapTasks.map((task) => task.id),
      instruction: "Insert exactly one map result per expected taskId, in any order; buildReduceInput canonicalizes their order.",
    }),
    ...plan.mapTasks.map((task) =>
      writeJson(join(outputDirectory, `${task.id}.json`), task),
    ),
  ]);
  return summary;
}

export function subsystemFor(path) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
}

function flattenFilePages(value) {
  if (Array.isArray(value)) return value.flatMap(flattenFilePages);
  return value && typeof value === "object" && typeof value.filename === "string" ? [value] : [];
}

function normalizeOptions(options) {
  const result = { ...DEFAULTS, ...options };
  for (const key of ["maxChunkBytes", "parallelism", "sharedPromptBytes"]) {
    if (!Number.isInteger(result[key]) || result[key] < (key === "sharedPromptBytes" ? 0 : 1)) throw new Error(`${key} must be a non-negative integer.`);
  }
  return result;
}

function chooseLeastLoaded(chunks) {
  return chunks.slice().sort((left, right) => left.diffBytes - right.diffBytes || left.files[0].path.localeCompare(right.files[0].path))[0];
}

function assertUniquePaths(files) {
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error("Changed file paths must be unique.");
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path);
}

function compareSizeThenPath(left, right) {
  return right.diffBytes - left.diffBytes || comparePath(left, right);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function percentReduction(baseline, candidate) {
  return baseline ? Number((((baseline - candidate) / baseline) * 100).toFixed(2)) : 0;
}

function planId(files, options) {
  return createHash("sha256")
    .update(JSON.stringify({ files: files.map(({ path, diffBytes }) => [path, diffBytes]), options }))
    .digest("hex")
    .slice(0, 16);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
