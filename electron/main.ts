import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AnalysisService } from './backend/service.js';
import { safeExternalUrl, validatePullNumber, validateRepository } from './backend/validation.js';
import { resolveEvidencePath } from './backend/evidence.js';
import { checkForUpdate } from './backend/update.js';
import { downloadUpdateArtifact, openDownloadedArtifact } from './backend/update-download.js';
import type { AnalysisRequest, UpdateCheckResult, UpdateDownloadResult } from '../shared/contracts.js';

let analysis: AnalysisService;
let latestSafeUpdate: UpdateCheckResult | null = null;
let downloadedUpdatePath: string | null = null;
const GENERIC_UPDATE_DOWNLOAD_ERROR = 'Could not download the update.';

export interface EvidenceOpenOptions {
  /** Injectable for tests; production launches through node's non-shell spawn. */
  launchEditor?: (command: string, args: string[]) => Promise<boolean>;
  /** Injectable for tests; production falls back to Electron's path opener. */
  openPath?: (target: string) => Promise<string>;
}

function configuredEditor(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  const name = candidate.split(/[\\/]/).pop()?.toLowerCase();
  if (name !== 'cursor' && name !== 'code') return null;
  return candidate;
}

function editorCommands(): string[] {
  const configured = [process.env.PR_ATLAS_EDITOR, process.env.VISUAL, process.env.EDITOR].map(configuredEditor).filter((value): value is string => Boolean(value));
  return [...new Set([...configured, 'cursor', 'code'])];
}

function launchEditor(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (started: boolean) => { if (settled) return; settled = true; resolve(started); };
    try {
      const child = nodeSpawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => finish(false));
      child.once('spawn', () => { child.unref(); finish(true); });
    } catch { finish(false); }
  });
}

export async function openEvidenceInEditor(target: string, line?: number, options: EvidenceOpenOptions = {}): Promise<boolean> {
  const location = Number.isInteger(line) && (line as number) > 0 ? `${target}:${line}` : target;
  const launch = options.launchEditor ?? launchEditor;
  for (const command of editorCommands()) {
    try { if (await launch(command, ['--goto', location])) return true; } catch { /* Try the next supported editor or path fallback. */ }
  }
  try { return (await (options.openPath ?? ((path: string) => shell.openPath(path)))(target)) === ''; } catch { return false; }
}

function isAllowedNavigation(url: string, productionUrl: string): boolean {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devUrl) return new URL(url).origin === new URL(devUrl).origin;
    return url === productionUrl;
  } catch { return false; }
}
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1480, height: 920, minWidth: 1040, minHeight: 680, backgroundColor: '#f4f7f6', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, 'preload.cjs') } });
  const devUrl = process.env.VITE_DEV_SERVER_URL; const productionUrl = pathToFileURL(join(__dirname, '../dist/index.html')).toString();
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(join(__dirname, '../dist/index.html'));
  window.webContents.on('will-navigate', (event, url) => { if (!isAllowedNavigation(url, productionUrl)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => { const allowed = safeExternalUrl(url); if (allowed) void shell.openExternal(allowed); return { action: 'deny' }; });
  return window;
}
function registerIpc(): void {
  ipcMain.handle('pr-atlas:bootstrap', () => analysis.bootstrap());
  ipcMain.handle('pr-atlas:list-providers', () => analysis.listProviders());
  ipcMain.handle('pr-atlas:list-pulls', (_event, repository: unknown) => { if (!validateRepository(repository)) throw new Error('Invalid repository.'); return analysis.listPullRequests(repository); });
  ipcMain.handle('pr-atlas:start-analysis', (_event, request: unknown) => analysis.startAnalysis(request as AnalysisRequest));
  ipcMain.handle('pr-atlas:cancel-analysis', (_event, runId: unknown) => typeof runId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(runId) ? analysis.cancelAnalysis(runId) : false);
  ipcMain.handle('pr-atlas:list-runs', (_event, payload: unknown) => { const input = payload as { repository?: unknown; pullNumber?: unknown; currentHeadSha?: unknown }; if (!validateRepository(input?.repository) || !validatePullNumber(input?.pullNumber)) throw new Error('Invalid analysis history request.'); return analysis.listAnalysisRuns(input.repository, input.pullNumber, typeof input.currentHeadSha === 'string' ? input.currentHeadSha : undefined); });
  ipcMain.handle('pr-atlas:load-run', (_event, payload: unknown) => { const input = payload as { repository?: unknown; pullNumber?: unknown; runId?: unknown }; if (!validateRepository(input?.repository) || !validatePullNumber(input?.pullNumber) || typeof input.runId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(input.runId)) return null; return analysis.loadAnalysisRun(input.repository, input.pullNumber, input.runId); });
  ipcMain.handle('pr-atlas:open-external', async (_event, url: unknown) => { const allowed = safeExternalUrl(url); if (!allowed) return false; await shell.openExternal(allowed); return true; });
  ipcMain.handle('pr-atlas:open-evidence', async (_event, payload: unknown) => {
    const input = payload as { repository?: unknown; headSha?: unknown; path?: unknown; line?: unknown };
    if (typeof input?.repository !== 'string' || typeof input.headSha !== 'string' || typeof input.path !== 'string') return false;
    try {
      const target = await resolveEvidencePath(app.getPath('userData'), input.repository, input.headSha, input.path);
      const line = Number.isInteger(input.line) && Number(input.line) > 0 ? Number(input.line) : undefined;
      return openEvidenceInEditor(target, line);
    } catch { return false; }
  });
  ipcMain.handle('pr-atlas:map-local-repository', async (_event, repository: unknown) => {
    if (!validateRepository(repository)) return null;
    const selected = await dialog.showOpenDialog({ title: `Map ${repository}`, properties: ['openDirectory'] });
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    return analysis.mapLocalRepository(repository, selected.filePaths[0]);
  });
  ipcMain.handle('pr-atlas:check-for-update', async () => {
    const result = await checkForUpdate(app.getVersion(), {
      feedUrl: process.env.PR_ATLAS_UPDATE_FEED_URL,
      platform: process.platform,
      arch: process.arch,
    });
    latestSafeUpdate = result.available && result.downloadUrl && result.artifactName ? result : null;
    downloadedUpdatePath = null;
    return result;
  });
  ipcMain.handle('pr-atlas:download-update', async (): Promise<UpdateDownloadResult> => {
    if (!latestSafeUpdate) return { success: false, error: GENERIC_UPDATE_DOWNLOAD_ERROR };
    const result = await downloadUpdateArtifact(latestSafeUpdate, {
      downloadsPath: app.getPath('downloads'),
      platform: process.platform,
      arch: process.arch,
    });
    downloadedUpdatePath = result.success ? result.path ?? null : null;
    return result;
  });
  ipcMain.handle('pr-atlas:open-downloaded-update', () => openDownloadedArtifact(downloadedUpdatePath, (path) => shell.openPath(path)));
}
app.whenReady().then(() => {
  analysis = new AnalysisService(app.getPath('userData'), undefined, (event) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('pr-atlas:progress', event); });
  registerIpc(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
