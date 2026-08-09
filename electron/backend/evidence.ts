import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewDocument } from "../../shared/contracts.js";
import type { EvidenceDetail } from "../../shared/contracts.js";
import { validateRepository } from "./validation.js";

const MAX_EVIDENCE_BYTES = 512 * 1024;

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

export async function resolveEvidencePath(
  dataRoot: string,
  repository: string,
  headSha: string,
  evidencePath: string,
): Promise<string> {
  if (!validateRepository(repository)) throw new Error("Invalid repository.");
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) throw new Error("Invalid revision.");
  if (!evidencePath || evidencePath.split(/[\\/]/).includes(".."))
    throw new Error("Unsafe evidence path.");
  const worktree = resolve(
    dataRoot,
    "worktrees",
    "github.com",
    ...repository.split("/"),
    headSha,
  );
  const analysisRoot = resolve(
    dataRoot,
    "analyses",
    "github.com",
    ...repository.split("/"),
  );
  const target = isAbsolute(evidencePath)
    ? resolve(evidencePath)
    : resolve(worktree, evidencePath);
  const worktreeCandidate = inside(worktree, target);
  const analysisRelative = relative(analysisRoot, target);
  const analysisParts = analysisRelative.split(sep);
  const analysisCandidate =
    inside(analysisRoot, target) &&
    analysisParts.length >= 5 &&
    /^\d+$/.test(analysisParts[0] ?? "") &&
    analysisParts[1] === headSha &&
    analysisParts[3] === "input";
  if (!worktreeCandidate && !analysisCandidate)
    throw new Error("Unsafe evidence path.");
  let metadata;
  try {
    metadata = await stat(target);
  } catch {
    throw new Error("Evidence file not found.");
  }
  if (!metadata.isFile()) throw new Error("Evidence path is not a file.");
  try {
    const canonicalTarget = await realpath(target);
    const canonicalRoot = await realpath(
      worktreeCandidate ? worktree : analysisRoot,
    );
    if (!inside(canonicalRoot, canonicalTarget))
      throw new Error("Unsafe evidence path.");
    return target;
  } catch (error) {
    if (error instanceof Error && /unsafe evidence path/i.test(error.message))
      throw error;
    throw new Error("Evidence file not found.");
  }
}

/** Safe, size-bounded source context for the renderer drawer. */
export async function readEvidenceDetail(
  dataRoot: string,
  repository: string,
  headSha: string,
  evidencePath: string,
  line?: number,
): Promise<EvidenceDetail> {
  const target = await resolveEvidencePath(
    dataRoot,
    repository,
    headSha,
    evidencePath,
  );
  const analysisRoot = resolve(
    dataRoot,
    "analyses",
    "github.com",
    ...repository.split("/"),
  );
  const source: EvidenceDetail["source"] = inside(analysisRoot, target)
    ? "analysis-input"
    : "worktree";
  const metadata = await stat(target);
  const raw = await readEvidenceText(target, metadata.size);
  const lines = raw.split(/\r?\n/);
  const focus =
    Number.isInteger(line) && (line as number) > 0 ? Number(line) : null;
  const start = focus ? Math.max(0, focus - 11) : 0;
  const end = focus
    ? Math.min(lines.length, focus + 10)
    : Math.min(lines.length, 80);
  const content = lines
    .slice(start, end)
    .map(
      (entry, index) =>
        `${String(start + index + 1).padStart(5, " ")} | ${entry}`,
    )
    .join("\n");
  return {
    path: evidencePath,
    line: focus,
    source,
    content,
    hunks:
      source === "analysis-input" && target.endsWith("diff.patch")
        ? parseDiffHunks(raw)
        : [],
  };
}

async function readEvidenceText(target: string, size: number): Promise<string> {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(
      Math.min(Math.max(size, 0), MAX_EVIDENCE_BYTES),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0))
      throw new Error("Binary evidence cannot be rendered as text.");
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded))
        throw new Error("Binary evidence cannot be rendered as text.");
      return decoded;
    } catch {
      throw new Error("Binary evidence cannot be rendered as text.");
    }
  } finally {
    await handle.close();
  }
}

function parseDiffHunks(value: string): EvidenceDetail["hunks"] {
  const hunks: EvidenceDetail["hunks"] = [];
  let header = "";
  let body: string[] = [];
  let collecting = false;
  const flush = () => {
    if (header)
      hunks.push({ header, content: body.join("\n").slice(0, 32 * 1024) });
    header = "";
    body = [];
    collecting = false;
  };
  const fileMetadataPrefixes = [
    "diff --git ",
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
  ];
  const isFileMetadata = (line: string) =>
    fileMetadataPrefixes.some((prefix) => line.startsWith(prefix));
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flush();
      header = line;
      body = [];
      collecting = true;
    } else if (collecting && line.startsWith("\\ No newline at end of file")) {
      continue;
    } else if (collecting && isFileMetadata(line)) {
      flush();
    } else if (collecting && body.length < 240) {
      body.push(line);
    }
  }
  flush();
  return hunks.slice(0, 30);
}

async function assertFile(target: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(target);
  } catch {
    throw new Error(`Evidence file not found: ${target}`);
  }
  if (!metadata.isFile())
    throw new Error(`Evidence path is not a file: ${target}`);
}

/**
 * Provider output may name a repository file relative to the worktree or a
 * deterministic run input relative to the input directory. Resolve that
 * ambiguity once, before a run can become Ready, and retain only paths that
 * the evidence IPC can safely open later.
 */
export async function normalizeDocumentEvidencePaths(
  dataRoot: string,
  repository: string,
  headSha: string,
  worktree: string,
  inputDirectory: string,
  document: ReviewDocument,
): Promise<ReviewDocument> {
  const normalized = structuredClone(document);
  for (const item of normalized.evidence) {
    const path = item.path;
    if (typeof path !== "string" || !path.trim())
      throw new Error(`Evidence ${item.id} has no file path.`);
    if (isAbsolute(path)) {
      item.path = await resolveEvidencePath(
        dataRoot,
        repository,
        headSha,
        path,
      );
      continue;
    }
    if (path.split(/[\\/]/).includes(".."))
      throw new Error(`Evidence ${item.id} has an unsafe path.`);
    const repositoryTarget = resolve(worktree, path);
    if (!inside(worktree, repositoryTarget))
      throw new Error(`Evidence ${item.id} has an unsafe path.`);
    try {
      await assertFile(repositoryTarget);
      await resolveEvidencePath(dataRoot, repository, headSha, path);
      item.path = path;
      continue;
    } catch (repositoryError) {
      const inputTarget = resolve(inputDirectory, path);
      if (!inside(inputDirectory, inputTarget))
        throw new Error(`Evidence ${item.id} has an unsafe path.`);
      try {
        await assertFile(inputTarget);
        item.path = await resolveEvidencePath(
          dataRoot,
          repository,
          headSha,
          inputTarget,
        );
        continue;
      } catch (inputError) {
        if (
          repositoryError instanceof Error &&
          /not a file/i.test(repositoryError.message)
        )
          throw repositoryError;
        if (
          inputError instanceof Error &&
          /not a file/i.test(inputError.message)
        )
          throw inputError;
        throw new Error(`Evidence file not found for ${item.id}: ${path}`);
      }
    }
  }
  return normalized;
}
