import { contextBridge, ipcRenderer } from 'electron';
import type { AnalysisProgressEvent, AnalysisRequest, PrAtlasApi } from '../shared/contracts.js';

// Kept only as a source-compatible type while the renderer migrates to PrAtlasApi.
export type GithubOperation = 'status' | 'viewer' | 'repository' | 'pulls';
const api: PrAtlasApi = {
  bootstrap: () => ipcRenderer.invoke('pr-atlas:bootstrap'),
  listProviders: () => ipcRenderer.invoke('pr-atlas:list-providers'),
  listPullRequests: (repository) => ipcRenderer.invoke('pr-atlas:list-pulls', repository),
  startAnalysis: (request: AnalysisRequest) => ipcRenderer.invoke('pr-atlas:start-analysis', request),
  cancelAnalysis: (runId) => ipcRenderer.invoke('pr-atlas:cancel-analysis', runId),
  listAnalysisRuns: (repository, pullNumber, currentHeadSha) => ipcRenderer.invoke('pr-atlas:list-runs', { repository, pullNumber, currentHeadSha }),
  loadAnalysisRun: (repository, pullNumber, runId) => ipcRenderer.invoke('pr-atlas:load-run', { repository, pullNumber, runId }),
  openExternal: (url) => ipcRenderer.invoke('pr-atlas:open-external', url),
  openEvidence: (repository, headSha, path, line) => ipcRenderer.invoke('pr-atlas:open-evidence', { repository, headSha, path, line }),
  checkForUpdate: () => ipcRenderer.invoke('pr-atlas:check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('pr-atlas:download-update'),
  openDownloadedUpdate: () => ipcRenderer.invoke('pr-atlas:open-downloaded-update'),
  subscribeAnalysisProgress: (listener) => { const receive = (_event: Electron.IpcRendererEvent, event: AnalysisProgressEvent) => listener(event); ipcRenderer.on('pr-atlas:progress', receive); return () => ipcRenderer.removeListener('pr-atlas:progress', receive); },
};
contextBridge.exposeInMainWorld('prAtlas', api);
