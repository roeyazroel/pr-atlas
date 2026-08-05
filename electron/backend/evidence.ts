import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WalkthroughDocument } from '../../shared/contracts.js';
import { validateRepository } from './validation.js';

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

export async function resolveEvidencePath(dataRoot: string, repository: string, headSha: string, evidencePath: string): Promise<string> {
  if (!validateRepository(repository)) throw new Error('Invalid repository.');
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) throw new Error('Invalid revision.');
  if (!evidencePath || evidencePath.split(/[\\/]/).includes('..')) throw new Error('Unsafe evidence path.');
  const worktree = resolve(dataRoot, 'worktrees', 'github.com', ...repository.split('/'), headSha);
  const analysisRoot = resolve(dataRoot, 'analyses', 'github.com', ...repository.split('/'));
  const target = isAbsolute(evidencePath) ? resolve(evidencePath) : resolve(worktree, evidencePath);
  const worktreeCandidate = inside(worktree, target);
  const analysisRelative = relative(analysisRoot, target);
  const analysisParts = analysisRelative.split(sep);
  const analysisCandidate = inside(analysisRoot, target)
    && analysisParts.length >= 5
    && /^\d+$/.test(analysisParts[0] ?? '')
    && analysisParts[1] === headSha
    && analysisParts[3] === 'input';
  if (!worktreeCandidate && !analysisCandidate) throw new Error('Unsafe evidence path.');
  let metadata;
  try { metadata = await stat(target); } catch { throw new Error('Evidence file not found.'); }
  if (!metadata.isFile()) throw new Error('Evidence path is not a file.');
  try {
    const canonicalTarget = await realpath(target);
    const canonicalRoot = await realpath(worktreeCandidate ? worktree : analysisRoot);
    if (!inside(canonicalRoot, canonicalTarget)) throw new Error('Unsafe evidence path.');
    return target;
  } catch (error) {
    if (error instanceof Error && /unsafe evidence path/i.test(error.message)) throw error;
    throw new Error('Evidence file not found.');
  }
}

async function assertFile(target: string): Promise<void> {
  let metadata;
  try { metadata = await stat(target); } catch { throw new Error(`Evidence file not found: ${target}`); }
  if (!metadata.isFile()) throw new Error(`Evidence path is not a file: ${target}`);
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
  document: WalkthroughDocument,
): Promise<WalkthroughDocument> {
  const normalized = structuredClone(document);
  for (const item of normalized.evidence) {
    const path = item.path;
    if (typeof path !== 'string' || !path.trim()) throw new Error(`Evidence ${item.id} has no file path.`);
    if (isAbsolute(path)) {
      item.path = await resolveEvidencePath(dataRoot, repository, headSha, path);
      continue;
    }
    if (path.split(/[\\/]/).includes('..')) throw new Error(`Evidence ${item.id} has an unsafe path.`);
    const repositoryTarget = resolve(worktree, path);
    if (!inside(worktree, repositoryTarget)) throw new Error(`Evidence ${item.id} has an unsafe path.`);
    try {
      await assertFile(repositoryTarget);
      await resolveEvidencePath(dataRoot, repository, headSha, path);
      item.path = path;
      continue;
    } catch (repositoryError) {
      const inputTarget = resolve(inputDirectory, path);
      if (!inside(inputDirectory, inputTarget)) throw new Error(`Evidence ${item.id} has an unsafe path.`);
      try {
        await assertFile(inputTarget);
        item.path = await resolveEvidencePath(dataRoot, repository, headSha, inputTarget);
        continue;
      } catch (inputError) {
        if (repositoryError instanceof Error && /not a file/i.test(repositoryError.message)) throw repositoryError;
        if (inputError instanceof Error && /not a file/i.test(inputError.message)) throw inputError;
        throw new Error(`Evidence file not found for ${item.id}: ${path}`);
      }
    }
  }
  return normalized;
}
