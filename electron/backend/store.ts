import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { AgentProvider, AnalysisManifest, AnalysisRunResult, AnalysisRunSummary, WalkthroughDocument } from '../../shared/contracts.js';
import { validateLegacyWalkthroughDocument, validateWalkthroughDocument } from '../../shared/schema.js';
import { validateRepository } from './validation.js';

function safeSegment(value: string): string { if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error('Unsafe storage path segment.'); return value; }
function isInside(root: string, target: string): boolean { const relation = relative(root, target); return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !relation.includes(`${sep}..${sep}`)); }
export class AnalysisStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  runDirectory(repository: string, pullNumber: number, headSha: string, runId: string): string {
    if (!validateRepository(repository) || !Number.isInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid analysis storage path.');
    const [owner, repo] = repository.split('/'); const target = resolve(this.root, 'analyses', 'github.com', safeSegment(owner), safeSegment(repo), String(pullNumber), safeSegment(headSha), safeSegment(runId));
    if (!isInside(this.root, target)) throw new Error('Analysis path escaped application storage.'); return target;
  }
  async writeManifest(directory: string, manifest: AnalysisManifest): Promise<void> { await this.writeJson(directory, 'manifest.json', manifest); }
  async writeWalkthrough(directory: string, document: WalkthroughDocument): Promise<void> { await this.writeJson(directory, 'walkthrough.json', document); }
  async writeInput(directory: string, name: string, content: unknown): Promise<void> { await this.writeJson(resolve(directory, 'input'), `${safeSegment(name)}.json`, content); }
  async writeText(directory: string, name: 'raw-output.txt' | 'logs.jsonl' | 'input/diff.patch', content: string): Promise<void> { const target = resolve(directory, name); if (!isInside(directory, target)) throw new Error('Unsafe artifact path.'); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content.slice(0, 8 * 1024 * 1024), 'utf8'); }
  async listRuns(repository: string, pullNumber: number, currentHeadSha?: string): Promise<AnalysisRunSummary[]> {
    if (!validateRepository(repository) || !Number.isInteger(pullNumber) || pullNumber < 1) return [];
    const [owner, repo] = repository.split('/'); const base = resolve(this.root, 'analyses', 'github.com', safeSegment(owner), safeSegment(repo), String(pullNumber));
    try { const heads = await readdir(base, { withFileTypes: true }); const runs = await Promise.all(heads.filter((head) => head.isDirectory()).flatMap(async (head) => { const dir = resolve(base, head.name); const entries = await readdir(dir, { withFileTypes: true }); return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => this.readRun(resolve(dir, entry.name), repository, pullNumber, currentHeadSha))); })); return runs.flat().filter((run): run is AnalysisRunSummary => run !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); } catch { return []; }
  }
  async loadRun(repository: string, pullNumber: number, runId: string): Promise<AnalysisRunResult | null> {
    if (!validateRepository(repository) || !Number.isInteger(pullNumber) || pullNumber < 1 || !/^[A-Za-z0-9-]{1,80}$/.test(runId)) return null;
    const [owner, repo] = repository.split('/'); const base = resolve(this.root, 'analyses', 'github.com', safeSegment(owner), safeSegment(repo), String(pullNumber));
    try {
      const heads = await readdir(base, { withFileTypes: true });
      for (const head of heads) {
        if (!head.isDirectory()) continue;
        const directory = resolve(base, head.name, runId); if (!isInside(this.root, directory)) continue;
        const manifest = await this.readManifest(directory, repository, pullNumber, runId); if (!manifest) continue;
        if (manifest.status !== 'ready') return null;
        try { const parsed: unknown = JSON.parse(await readFile(resolve(directory, 'walkthrough.json'), 'utf8')); const validation = manifest.schemaVersion ? validateWalkthroughDocument(parsed) : validateLegacyWalkthroughDocument(parsed); if (!validation.valid || !validation.document || validation.document.pullRequest.repository !== repository || validation.document.pullRequest.number !== pullNumber || validation.document.pullRequest.headSha !== manifest.headSha || validation.document.pullRequest.baseSha !== manifest.baseSha) return null; return { runId, status: 'ready', document: validation.document, manifest, artifactDirectory: directory }; } catch { return null; }
      }
    } catch { /* Treat unavailable or malformed application storage as no saved run. */ }
    return null;
  }
  private async readRun(directory: string, repository: string, pullNumber: number, currentHeadSha?: string): Promise<AnalysisRunSummary | null> { const manifest = await this.readManifest(directory, repository, pullNumber); return manifest ? { ...manifest, artifactDirectory: directory, outdated: currentHeadSha ? manifest.headSha !== currentHeadSha : undefined } : null; }
  private async readManifest(directory: string, repository: string, pullNumber: number, runId?: string): Promise<AnalysisManifest | null> { try { if (!isInside(this.root, directory)) return null; const value: unknown = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')); if (!value || typeof value !== 'object') return null; const manifest = value as Record<string, unknown>; const provider = manifest.provider === undefined ? 'claude' : manifest.provider; if (typeof manifest.runId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(manifest.runId) || !['ready', 'failed', 'invalid', 'cancelled'].includes(manifest.status as string) || manifest.repository !== repository || manifest.pullNumber !== pullNumber || (runId && manifest.runId !== runId) || typeof manifest.headSha !== 'string' || typeof manifest.baseSha !== 'string' || typeof manifest.createdAt !== 'string' || !['claude', 'codex', 'cursor'].includes(provider as string)) return null; const error = manifest.error && typeof manifest.error === 'object' && typeof (manifest.error as Record<string, unknown>).code === 'string' && typeof (manifest.error as Record<string, unknown>).message === 'string' ? { code: (manifest.error as Record<string, string>).code.slice(0, 100), message: (manifest.error as Record<string, string>).message.slice(0, 1_000) } : undefined; return { runId: manifest.runId, repository, pullNumber, baseSha: manifest.baseSha, headSha: manifest.headSha, provider: provider as AgentProvider, status: manifest.status as AnalysisManifest['status'], createdAt: manifest.createdAt, ...(typeof manifest.completedAt === 'string' ? { completedAt: manifest.completedAt } : {}), ...(typeof manifest.schemaVersion === 'string' ? { schemaVersion: manifest.schemaVersion } : {}), ...(typeof manifest.model === 'string' ? { model: manifest.model } : {}), ...(typeof manifest.skillContractVersion === 'string' ? { skillContractVersion: manifest.skillContractVersion } : {}), ...(typeof manifest.skillReferenceUrl === 'string' ? { skillReferenceUrl: manifest.skillReferenceUrl } : {}), ...(error ? { error } : {}) }; } catch { return null; } }
  private async writeJson(directory: string, file: string, value: unknown): Promise<void> { const target = resolve(directory, file); if (!isInside(this.root, target)) throw new Error('Unsafe artifact path.'); await mkdir(directory, { recursive: true }); const temporary = `${target}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8'); await rename(temporary, target); }
}
