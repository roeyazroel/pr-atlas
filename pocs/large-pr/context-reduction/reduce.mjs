import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_OVERHEAD = 120;

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

function normalizeLine(line) {
  return line.replace(/^[-+]/, "").replace(/\s+/g, "").trim();
}

function changedEntries(patch = "") {
  const entries = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      entries.push({ kind: "+", line: newLine, text: raw });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      entries.push({ kind: "-", line: oldLine, text: raw });
      oldLine += 1;
    } else if (!raw.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return entries;
}

function semanticEntries(patch = "") {
  const lines = changedEntries(patch);
  const removed = new Map();
  for (const line of lines.filter((entry) => entry.kind === "-")) {
    const key = normalizeLine(line.text);
    if (key) removed.set(key, (removed.get(key) ?? 0) + 1);
  }
  const formattingAdds = new Set();
  for (const [index, line] of lines.entries()) {
    if (line.kind !== "+") continue;
    const key = normalizeLine(line.text);
    const count = removed.get(key) ?? 0;
    if (key && count > 0) {
      formattingAdds.add(index);
      removed.set(key, count - 1);
    }
  }
  const formattingRemovals = new Map();
  for (const [key, count] of removed) formattingRemovals.set(key, count);
  return lines.filter((line, index) => {
    if (line.kind === "+" && formattingAdds.has(index)) return false;
    if (line.kind !== "-") return true;
    const key = normalizeLine(line.text);
    const remaining = formattingRemovals.get(key) ?? 0;
    if (remaining <= 0) return false;
    formattingRemovals.set(key, remaining - 1);
    return true;
  });
}

function category(filename) {
  const lower = filename.toLowerCase();
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./.test(lower)) return "test";
  if (/\.md$|(^|\/)docs?\//.test(lower)) return "docs";
  if (/package(-lock)?\.json$|\.ya?ml$|\.toml$|\.json$|(^|\/)\.github\//.test(lower)) return "config";
  return "source";
}

function scoreFile(file, semanticCount) {
  const weights = { test: 6, source: 5, config: 3, docs: 2 };
  return (weights[category(file.filename)] ?? 1) * 1_000
    + Math.min(semanticCount, 500) * 4
    + Math.min(Number(file.changes) || 0, 500);
}

export function reduceFiles(rawFiles, budgetBytes = 120_000) {
  const files = flattenPages(rawFiles).filter((file) => file && typeof file.filename === "string");
  const candidates = files.map((file) => {
    const semantic = semanticEntries(file.patch ?? "");
    const allChanged = changedEntries(file.patch ?? "");
    const formattingOnlyLines = Math.max(0, allChanged.length - semantic.length);
    return {
      file,
      semantic,
      formattingOnlyLines,
      score: scoreFile(file, semantic.length),
      estimatedBytes: semantic.reduce((total, line) => total + Buffer.byteLength(line.text) + 1, TEXT_OVERHEAD),
    };
  }).sort((left, right) => right.score - left.score || left.file.filename.localeCompare(right.file.filename));

  let remaining = Math.max(0, budgetBytes);
  const detailed = new Map();
  const dropped = [];
  // Give every semantic file a small evidence floor before ranking additional
  // context. This avoids a fast but misleading result that understands only a
  // handful of the highest-scored files.
  for (const candidate of candidates) {
    const selected = [];
    for (const line of candidate.semantic.slice(0, 12)) {
      const bytes = Buffer.byteLength(line.text) + 1;
      if (bytes > remaining) break;
      selected.push(line);
      remaining -= bytes;
    }
    if (selected.length) detailed.set(candidate.file.filename, selected);
  }
  for (const candidate of candidates) {
    if (candidate.semantic.length === 0) {
      dropped.push({ path: candidate.file.filename, reason: candidate.formattingOnlyLines ? "formatting-only" : "no-text-patch" });
      continue;
    }
    const selected = detailed.get(candidate.file.filename) ?? [];
    for (const line of candidate.semantic.slice(selected.length)) {
      const bytes = Buffer.byteLength(line.text) + 1;
      if (bytes > remaining) break;
      selected.push(line);
      remaining -= bytes;
    }
    if (selected.length) detailed.set(candidate.file.filename, selected);
    if (selected.length < candidate.semantic.length) {
      dropped.push({ path: candidate.file.filename, reason: "byte-budget", omittedLines: candidate.semantic.length - selected.length });
    }
  }

  const fileFacts = files
    .map((file) => {
      const selected = detailed.get(file.filename) ?? [];
      const semantic = semanticEntries(file.patch ?? "");
      return {
        path: file.filename,
        status: file.status ?? "unknown",
        category: category(file.filename),
        changes: Number(file.changes) || 0,
        semanticChangedLines: semantic.length,
        formattingOnlyLines: Math.max(0, changedEntries(file.patch ?? "").length - semantic.length),
        // The file path is stored once above; tuples retain exact line locators
        // without repeating it for every excerpt.
        evidence: selected.map((entry) => [entry.line, entry.text]),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const rawPatchBytes = files.reduce((total, file) => total + Buffer.byteLength(file.patch ?? ""), 0);
  const result = {
    version: 1,
    strategy: "deterministic-context-reduction",
    budgetBytes,
    facts: fileFacts,
    droppedContext: dropped.sort((left, right) => left.path.localeCompare(right.path)),
  };
  const outputBytes = Buffer.byteLength(JSON.stringify(result));
  return {
    result,
    metrics: {
      files: files.length,
      filesRepresented: fileFacts.length,
      detailedFiles: fileFacts.filter((file) => file.evidence.length).length,
      rawPatchBytes,
      outputBytes,
      compressionRatio: rawPatchBytes ? Number((outputBytes / rawPatchBytes).toFixed(4)) : 0,
      changedFileCoverage: files.length ? fileFacts.length / files.length : 1,
      evidenceLocators: fileFacts.reduce((total, file) => total + file.evidence.length, 0),
      droppedReasons: dropped.reduce((counts, entry) => ({ ...counts, [entry.reason]: (counts[entry.reason] ?? 0) + 1 }), {}),
      estimatedProviderSeconds: Number((outputBytes / 2_500).toFixed(1)),
    },
  };
}

export async function reduceInputDirectory(inputDirectory, outputPath, budgetBytes = 120_000) {
  const rawFiles = JSON.parse(await readFile(join(inputDirectory, "files.json"), "utf8"));
  const reduced = reduceFiles(rawFiles, budgetBytes);
  await writeFile(outputPath, `${JSON.stringify(reduced, null, 2)}\n`, "utf8");
  return reduced;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [inputDirectory, outputPath = "reduced-input.json", budget = "120000"] = process.argv.slice(2);
  if (!inputDirectory) throw new Error("Usage: node reduce.mjs <input-directory> [output.json] [budget-bytes]");
  const reduced = await reduceInputDirectory(inputDirectory, outputPath, Number(budget));
  console.log(JSON.stringify(reduced.metrics, null, 2));
}
