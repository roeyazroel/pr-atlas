/** Provider-neutral, deterministic planning for large PR map/reduce runs. */
export const BATCHING_THRESHOLDS = { files: 20, changes: 1_000 } as const;
export const MAX_BATCH_CONCURRENCY = 4;
export const DEFAULT_BATCH_BYTES = 160 * 1024;

export type ChangedDiff = { path: string; diff: string; additions?: number; deletions?: number };
export type BatchFile = { path: string; diff: string; bytes: number; segment: number };
export type BatchTask = { id: string; files: BatchFile[]; bytes: number; subsystems: string[] };
export type BatchPlan = {
  chunks: BatchTask[];
  coverage: { complete: boolean; missing: string[]; duplicated: string[] };
  sourceFiles: string[];
};
export type BatchMapOutput = { taskId: string; observations: Array<{ path: string; segment: number; summary: string; evidence: Array<{ path: string; line: number | null }>; changeGroups: string[]; tests: string[]; flows: string[]; limitations: string[] }> };

/** Complete unified-diff sections keyed by their current (or deleted) repo path. */
export function parseGitDiffSections(diff: string): Map<string, string> {
  const starts = [...diff.matchAll(/^diff --git (.+)$/gm)].map((match) => match.index ?? 0);
  const sections = new Map<string, string>();
  for (let index = 0; index < starts.length; index += 1) {
    const section = diff.slice(starts[index], starts[index + 1]);
    const header = section.match(/^diff --git (.+)$/m)?.[1] ?? "";
    const [, fallback] = parseHeaderPaths(header);
    const added = section.match(/^\+\+\+ (.+)$/m)?.[1];
    const removed = section.match(/^--- (.+)$/m)?.[1];
    const renamed = section.match(/^rename to (.+)$/m)?.[1];
    const binary = section.match(/^Binary files .+ and b\/(.+) differ$/m)?.[1];
    const path = decodeDiffPath(added && added !== "/dev/null" ? added : removed && removed !== "/dev/null" ? removed : renamed ?? binary ?? fallback);
    if (!path || !section.trim()) throw new Error("Diff section has no safe file path or evidence.");
    sections.set(path, section);
  }
  return sections;
}

export function shouldBatchAnalysis(input: { files: number; changes: number }): boolean {
  return input.files >= BATCHING_THRESHOLDS.files || input.changes >= BATCHING_THRESHOLDS.changes;
}

export function buildBatchPlan(source: ChangedDiff[], options: { maxChunkBytes?: number; overlapBytes?: number } = {}): BatchPlan {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_BATCH_BYTES;
  const overlapBytes = Math.min(options.overlapBytes ?? 2 * 1024, Math.floor(maxChunkBytes / 4));
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 32) throw new Error("maxChunkBytes must be at least 32.");
  const paths = source.map((file) => file.path).sort();
  if (new Set(paths).size !== paths.length) throw new Error("Changed file paths must be unique.");
  const units = source.flatMap((file) => splitFile(file, maxChunkBytes, overlapBytes))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path) || left.segment - right.segment);
  const raw: Array<{ files: BatchFile[]; bytes: number; subsystems: Set<string> }> = [];
  for (const unit of units) {
    const fits = raw.filter((chunk) => chunk.bytes + unit.bytes <= maxChunkBytes);
    const affinity = fits.filter((chunk) => chunk.subsystems.has(subsystem(unit.path)));
    const chosen = [...(affinity.length ? affinity : fits)].sort((a, b) => a.bytes - b.bytes || a.files[0].path.localeCompare(b.files[0].path))[0];
    if (chosen) {
      chosen.files.push(unit); chosen.bytes += unit.bytes; chosen.subsystems.add(subsystem(unit.path));
    } else raw.push({ files: [unit], bytes: unit.bytes, subsystems: new Set([subsystem(unit.path)]) });
  }
  const chunks = raw.map((chunk, index) => ({
    id: `map-${String(index + 1).padStart(3, "0")}`,
    files: chunk.files.slice().sort((a, b) => a.path.localeCompare(b.path) || a.segment - b.segment),
    bytes: chunk.bytes,
    subsystems: [...chunk.subsystems].sort(),
  }));
  const expected = units.map(unitKey); const actual = chunks.flatMap((chunk) => chunk.files.map(unitKey));
  const counts = new Map<string, number>(); for (const key of actual) counts.set(key, (counts.get(key) ?? 0) + 1);
  const coverage = { complete: expected.every((key) => counts.get(key) === 1), missing: expected.filter((key) => !counts.has(key)), duplicated: [...counts].filter(([, count]) => count > 1).map(([key]) => key) };
  return { chunks, coverage, sourceFiles: paths };
}

/** Map output is deliberately small and cannot point outside its assigned evidence. */
export function validateBatchMapOutput(value: unknown, task: Pick<BatchTask, "id" | "files">): { valid: boolean; output?: BatchMapOutput; errors: string[] } {
  if (!recordWithKeys(value, ["taskId", "observations"])) return { valid: false, errors: ["Map output must be a closed object."] };
  const output = value as { taskId: unknown; observations: unknown };
  if (output.taskId !== task.id) return { valid: false, errors: ["Map output taskId does not match its task."] };
  if (!Array.isArray(output.observations)) return { valid: false, errors: ["Map output observations must be an array."] };
  const allowed = new Set(task.files.map(unitKey));
  const observed = new Set<string>();
  const observations: BatchMapOutput["observations"] = [];
  for (const observation of output.observations) {
    if (!recordWithKeys(observation, ["path", "segment", "summary", "evidence", "changeGroups", "tests", "flows", "limitations"]))
      return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    const item = observation as Record<string, unknown>;
    if (typeof item.path !== "string" || !Number.isInteger(item.segment) || !allowed.has(`${item.path}:${item.segment}`) || typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 8_000 || !Array.isArray(item.evidence) || item.evidence.length === 0 || !stringArray(item.changeGroups) || !stringArray(item.tests) || !stringArray(item.flows) || !stringArray(item.limitations)) return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    const evidence = item.evidence.map((entry) => recordWithKeys(entry, ["path", "line"]) ? entry as Record<string, unknown> : null);
    if (evidence.some((entry) => !entry || entry.path !== item.path || !(entry.line === null || (Number.isInteger(entry.line) && (entry.line as number) >= 1)))) return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    observations.push({ path: item.path, segment: item.segment as number, summary: item.summary, evidence: evidence as Array<{ path: string; line: number | null }>, changeGroups: [...item.changeGroups as string[]], tests: [...item.tests as string[]], flows: [...item.flows as string[]], limitations: [...item.limitations as string[]] });
    observed.add(`${item.path}:${item.segment}`);
  }
  if (observed.size !== output.observations.length || [...allowed].some((key) => !observed.has(key))) return { valid: false, errors: ["Map output did not cover every assigned unit exactly once."] };
  return { valid: true, output: { taskId: task.id, observations }, errors: [] };
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0); }
function unitKey(value: Pick<BatchFile, "path" | "segment">): string { return `${value.path}:${value.segment}`; }
function parseHeaderPaths(value: string): [string, string] {
  if (!value.includes('"')) { const boundary = value.lastIndexOf(" b/"); if (boundary > 0) return [value.slice(0, boundary), value.slice(boundary + 1)]; }
  const tokens: string[] = []; let rest = value.trim();
  while (rest) { if (rest.startsWith('"')) { let end = 1; let escaped = false; for (; end < rest.length; end += 1) { if (!escaped && rest[end] === '"') break; escaped = !escaped && rest[end] === "\\"; if (rest[end] !== "\\") escaped = false; } tokens.push(rest.slice(0, end + 1)); rest = rest.slice(end + 1).trimStart(); } else { const end = rest.search(/\s/); tokens.push(end < 0 ? rest : rest.slice(0, end)); rest = end < 0 ? "" : rest.slice(end).trimStart(); } }
  return [tokens[0] ?? "", tokens[1] ?? ""];
}
function decodeDiffPath(value: string): string {
  const raw = value;
  if (!raw.startsWith('"')) return raw.replace(/^(?:a|b)\//, "");
  const body = raw.slice(1, -1); const chunks: Buffer[] = []; let literal = "";
  const flush = () => { if (literal) { chunks.push(Buffer.from(literal, "utf8")); literal = ""; } };
  for (let index = 0; index < body.length; index += 1) { if (body[index] !== "\\") { literal += body[index]; continue; } flush(); const next = body[++index]; if (next && /[0-7]/.test(next)) { const octal = `${next}${body[index + 1] ?? ""}${body[index + 2] ?? ""}`.match(/^[0-7]{1,3}/)?.[0] ?? next; chunks.push(Buffer.from([Number.parseInt(octal, 8)])); index += octal.length - 1; } else { const escapes: Record<string, string> = { a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", "\\": "\\", '"': '"' }; chunks.push(Buffer.from(next ? (escapes[next] ?? next) : "", "utf8")); } }
  flush(); return Buffer.concat(chunks).toString("utf8").replace(/^(?:a|b)\//, "");
}

function splitFile(file: ChangedDiff, max: number, overlap: number): BatchFile[] {
  const bytes = Buffer.byteLength(file.diff, "utf8");
  if (bytes <= max) return [{ path: file.path, diff: file.diff, bytes, segment: 0 }];
  const hunks = file.diff.split(/(?=^@@ )/m).filter(Boolean);
  const pieces: string[] = [];
  let current = "";
  for (const hunk of hunks) {
    if (Buffer.byteLength(hunk, "utf8") > max) {
      if (current) { pieces.push(current); current = ""; }
      pieces.push(...windowText(hunk, max, overlap));
    } else if (Buffer.byteLength(current + hunk, "utf8") > max && current) {
      pieces.push(current); current = hunk;
    } else current += hunk;
  }
  if (current) pieces.push(current);
  return pieces.map((diff, segment) => ({ path: file.path, diff, bytes: Buffer.byteLength(diff, "utf8"), segment }));
}

function windowText(text: string, max: number, overlap: number): string[] {
  const result: string[] = []; let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + max);
    while (Buffer.byteLength(text.slice(offset, end), "utf8") > max) end -= 1;
    result.push(text.slice(offset, end));
    if (end === text.length) break;
    offset = Math.max(offset + 1, end - overlap);
  }
  return result;
}
function subsystem(path: string): string { const parts = path.split("/"); return parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)"; }
