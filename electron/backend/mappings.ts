import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { validateRepository } from './validation.js';

/** The persisted shape is intentionally small; the renderer only needs the mapped path. */
export interface RepositoryMappingRecord {
  repository: string;
  path: string;
  remote: string;
  updatedAt: string;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error('Unsafe repository mapping path.');
  return value;
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..');
}

export function mappingFile(dataRoot: string, repository: string): string {
  if (!validateRepository(repository)) throw new Error('Invalid repository.');
  const [owner, name] = repository.split('/');
  const root = resolve(dataRoot);
  const file = resolve(root, 'mappings', 'github.com', safeSegment(owner), `${safeSegment(name)}.json`);
  if (!inside(root, file)) throw new Error('Repository mapping path escaped storage.');
  return file;
}

export async function writeRepositoryMapping(dataRoot: string, mapping: RepositoryMappingRecord): Promise<void> {
  const target = mappingFile(dataRoot, mapping.repository);
  await mkdir(resolve(target, '..'), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(mapping, null, 2), 'utf8');
  await rename(temporary, target);
}

export async function readRepositoryMapping(dataRoot: string, repository: string): Promise<RepositoryMappingRecord | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(mappingFile(dataRoot, repository), 'utf8')); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.repository !== repository || typeof record.path !== 'string' || !record.path || !resolve(record.path) || typeof record.remote !== 'string' || typeof record.updatedAt !== 'string') return null;
  return { repository, path: resolve(record.path), remote: record.remote, updatedAt: record.updatedAt };
}

/**
 * Converts the supported GitHub remote forms to an owner/name pair. GitHub
 * repository names are case-insensitive, so comparison is performed lower-case
 * while the persisted selected repository keeps its original spelling.
 */
export function repositoryFromRemote(remote: string): string | null {
  let value = remote.trim().split(/\r?\n/, 1)[0] ?? '';
  if (!value) return null;
  if (value.startsWith('git@github.com:')) value = `https://github.com/${value.slice('git@github.com:'.length)}`;
  else if (value.startsWith('ssh://git@github.com/')) value = `https://github.com/${value.slice('ssh://git@github.com/'.length)}`;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    const name = segments[1].replace(/\.git$/i, '');
    if (!name || !validateRepository(`${segments[0]}/${name}`)) return null;
    return `${segments[0]}/${name}`;
  } catch { return null; }
}

export function repositoriesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
