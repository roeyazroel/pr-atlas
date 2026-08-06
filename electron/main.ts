import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn as nodeSpawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AnalysisService } from "./backend/service.js";
import {
  discoverNvmVersionBinPaths,
  normalizeDesktopPath,
} from "./backend/desktop-path.js";
import {
  safeExternalUrl,
  validatePullNumber,
  validateRepository,
} from "./backend/validation.js";
import { readEvidenceDetail, resolveEvidencePath } from "./backend/evidence.js";
import { checkForUpdate } from "./backend/update.js";
import {
  diagnosticReportFilename,
  serializeDiagnosticReport,
} from "./backend/diagnostics.js";
import {
  downloadUpdateArtifact,
  openDownloadedArtifact,
} from "./backend/update-download.js";
import type {
  AnalysisRequest,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
} from "../shared/contracts.js";

let analysis: AnalysisService;
let latestSafeUpdate: UpdateCheckResult | null = null;
let downloadedUpdatePath: string | null = null;
let downloadedUpdateDigest: string | null = null;
let activeUpdateDownload: Promise<UpdateDownloadResult> | null = null;
let updateDownloadGeneration = 0;
let updateCheckSequence = 0;
const GENERIC_UPDATE_DOWNLOAD_ERROR = "Could not download the update.";

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
  if (name !== "cursor" && name !== "code") return null;
  return candidate;
}

function editorCommands(): string[] {
  const configured = [
    process.env.PR_ATLAS_EDITOR,
    process.env.VISUAL,
    process.env.EDITOR,
  ]
    .map(configuredEditor)
    .filter((value): value is string => Boolean(value));
  return [...new Set([...configured, "cursor", "code"])];
}

function launchEditor(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      resolve(started);
    };
    try {
      const child = nodeSpawn(command, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.once("error", () => finish(false));
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
    } catch {
      finish(false);
    }
  });
}

export async function openEvidenceInEditor(
  target: string,
  line?: number,
  options: EvidenceOpenOptions = {},
): Promise<boolean> {
  const location =
    Number.isInteger(line) && (line as number) > 0
      ? `${target}:${line}`
      : target;
  const launch = options.launchEditor ?? launchEditor;
  for (const command of editorCommands()) {
    try {
      if (await launch(command, ["--goto", location])) return true;
    } catch {
      /* Try the next supported editor or path fallback. */
    }
  }
  try {
    return (
      (await (options.openPath ?? ((path: string) => shell.openPath(path)))(
        target,
      )) === ""
    );
  } catch {
    return false;
  }
}

function isAllowedNavigation(url: string, productionUrl: string): boolean {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devUrl) return new URL(url).origin === new URL(devUrl).origin;
    return url === productionUrl;
  } catch {
    return false;
  }
}
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#f4f7f6",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const productionUrl = pathToFileURL(
    join(__dirname, "../dist/index.html"),
  ).toString();
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, "../dist/index.html"));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, productionUrl)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url);
    if (allowed) void shell.openExternal(allowed);
    return { action: "deny" };
  });
  return window;
}
function registerIpc(): void {
  ipcMain.handle("pr-atlas:bootstrap", () => analysis.bootstrap());
  ipcMain.handle("pr-atlas:list-providers", () => analysis.listProviders());
  ipcMain.handle("pr-atlas:list-pulls", (_event, repository: unknown) => {
    if (!validateRepository(repository)) throw new Error("Invalid repository.");
    return analysis.listPullRequests(repository);
  });
  ipcMain.handle("pr-atlas:start-analysis", (_event, request: unknown) =>
    analysis.startAnalysis(request as AnalysisRequest),
  );
  ipcMain.handle("pr-atlas:cancel-analysis", (_event, runId: unknown) =>
    typeof runId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(runId)
      ? analysis.cancelAnalysis(runId)
      : false,
  );
  ipcMain.handle("pr-atlas:list-runs", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      currentHeadSha?: unknown;
    };
    if (
      !validateRepository(input?.repository) ||
      !validatePullNumber(input?.pullNumber)
    )
      throw new Error("Invalid analysis history request.");
    return analysis.listAnalysisRuns(
      input.repository,
      input.pullNumber,
      typeof input.currentHeadSha === "string"
        ? input.currentHeadSha
        : undefined,
    );
  });
  ipcMain.handle("pr-atlas:load-run", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      runId?: unknown;
    };
    if (
      !validateRepository(input?.repository) ||
      !validatePullNumber(input?.pullNumber) ||
      typeof input.runId !== "string" ||
      !/^[A-Za-z0-9-]{1,80}$/.test(input.runId)
    )
      return null;
    return analysis.loadAnalysisRun(
      input.repository,
      input.pullNumber,
      input.runId,
    );
  });
  ipcMain.handle("pr-atlas:load-diagnostics", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      runId?: unknown;
    };
    return validateRepository(input?.repository) &&
      validatePullNumber(input?.pullNumber) &&
      typeof input.runId === "string" &&
      /^[A-Za-z0-9-]{1,80}$/.test(input.runId)
      ? analysis.loadAnalysisDiagnostics(
          input.repository,
          input.pullNumber,
          input.runId,
        )
      : null;
  });
  ipcMain.handle(
    "pr-atlas:export-diagnostics",
    async (_event, payload: unknown) => {
      const input = payload as {
        repository?: unknown;
        pullNumber?: unknown;
        runId?: unknown;
      };
      if (
        !validateRepository(input?.repository) ||
        !validatePullNumber(input?.pullNumber) ||
        typeof input.runId !== "string" ||
        !/^[A-Za-z0-9-]{1,80}$/.test(input.runId)
      )
        return { saved: false, error: "Diagnostics are unavailable." };
      const diagnostics = await analysis.loadAnalysisDiagnostics(
        input.repository,
        input.pullNumber,
        input.runId,
      );
      if (!diagnostics)
        return { saved: false, error: "Diagnostics are unavailable." };
      const selected = await dialog.showSaveDialog({
        title: "Save PR Atlas diagnostic report",
        defaultPath: join(
          app.getPath("downloads"),
          diagnosticReportFilename(
            input.repository,
            input.pullNumber,
            input.runId,
          ),
        ),
        filters: [{ name: "JSON diagnostic report", extensions: ["json"] }],
      });
      if (selected.canceled || !selected.filePath) return { saved: false };
      try {
        await writeFile(
          selected.filePath,
          serializeDiagnosticReport(diagnostics, {
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
          }),
          { encoding: "utf8", mode: 0o600 },
        );
        shell.showItemInFolder(selected.filePath);
        return { saved: true, filePath: selected.filePath };
      } catch {
        return { saved: false, error: "Could not save the diagnostic report." };
      }
    },
  );
  ipcMain.handle("pr-atlas:get-review-progress", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      runId?: unknown;
    };
    return validateRepository(input?.repository) &&
      validatePullNumber(input?.pullNumber) &&
      typeof input.runId === "string" &&
      /^[A-Za-z0-9-]{1,80}$/.test(input.runId)
      ? analysis.getReviewProgress(
          input.repository,
          input.pullNumber,
          input.runId,
        )
      : [];
  });
  ipcMain.handle("pr-atlas:set-review-progress", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      progress?: unknown;
    };
    if (
      !validateRepository(input?.repository) ||
      !validatePullNumber(input?.pullNumber) ||
      !input.progress ||
      typeof input.progress !== "object"
    )
      return null;
    const progress = input.progress as {
      runId?: unknown;
      stepId?: unknown;
      status?: unknown;
      note?: unknown;
    };
    if (
      typeof progress.runId !== "string" ||
      !/^[A-Za-z0-9-]{1,80}$/.test(progress.runId) ||
      typeof progress.stepId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(progress.stepId) ||
      !["pending", "reviewed", "follow-up", "skipped"].includes(
        progress.status as string,
      ) ||
      typeof progress.note !== "string" ||
      progress.note.length > 4_000
    )
      return null;
    return analysis.setReviewProgress(input.repository, input.pullNumber, {
      runId: progress.runId,
      stepId: progress.stepId,
      status: progress.status as
        "pending" | "reviewed" | "follow-up" | "skipped",
      note: progress.note,
      updatedAt: "",
    });
  });
  ipcMain.handle("pr-atlas:delete-run", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      runId?: unknown;
    };
    return validateRepository(input?.repository) &&
      validatePullNumber(input?.pullNumber) &&
      typeof input.runId === "string" &&
      /^[A-Za-z0-9-]{1,80}$/.test(input.runId)
      ? analysis.deleteAnalysisRun(
          input.repository,
          input.pullNumber,
          input.runId,
        )
      : false;
  });
  ipcMain.handle("pr-atlas:set-preferred-run", (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      pullNumber?: unknown;
      runId?: unknown;
    };
    return validateRepository(input?.repository) &&
      validatePullNumber(input?.pullNumber) &&
      typeof input.runId === "string" &&
      /^[A-Za-z0-9-]{1,80}$/.test(input.runId)
      ? analysis.setPreferredAnalysisRun(
          input.repository,
          input.pullNumber,
          input.runId,
        )
      : false;
  });
  ipcMain.handle("pr-atlas:get-retention-settings", () =>
    analysis.getRetentionSettings(),
  );
  ipcMain.handle("pr-atlas:set-retention-settings", (_event, value: unknown) =>
    analysis.setRetentionSettings(
      value as { analysisDays: number; worktreeDays: number },
    ),
  );
  ipcMain.handle("pr-atlas:open-external", async (_event, url: unknown) => {
    const allowed = safeExternalUrl(url);
    if (!allowed) return false;
    await shell.openExternal(allowed);
    return true;
  });
  ipcMain.handle("pr-atlas:open-evidence", async (_event, payload: unknown) => {
    const input = payload as {
      repository?: unknown;
      headSha?: unknown;
      path?: unknown;
      line?: unknown;
    };
    if (
      typeof input?.repository !== "string" ||
      typeof input.headSha !== "string" ||
      typeof input.path !== "string"
    )
      return false;
    try {
      const target = await resolveEvidencePath(
        app.getPath("userData"),
        input.repository,
        input.headSha,
        input.path,
      );
      const line =
        Number.isInteger(input.line) && Number(input.line) > 0
          ? Number(input.line)
          : undefined;
      return openEvidenceInEditor(target, line);
    } catch {
      return false;
    }
  });
  ipcMain.handle(
    "pr-atlas:get-evidence-detail",
    async (_event, payload: unknown) => {
      const input = payload as {
        repository?: unknown;
        headSha?: unknown;
        path?: unknown;
        line?: unknown;
      };
      if (
        !validateRepository(input?.repository) ||
        typeof input.headSha !== "string" ||
        typeof input.path !== "string" ||
        !/^[0-9a-f]{7,64}$/i.test(input.headSha)
      )
        return null;
      try {
        return await readEvidenceDetail(
          app.getPath("userData"),
          input.repository,
          input.headSha,
          input.path,
          Number.isInteger(input.line) && Number(input.line) > 0
            ? Number(input.line)
            : undefined,
        );
      } catch {
        return null;
      }
    },
  );
  ipcMain.handle("pr-atlas:check-for-update", async () => {
    const checkSequence = ++updateCheckSequence;
    const downloadGenerationAtStart = updateDownloadGeneration;
    const startedDuringDownload = activeUpdateDownload !== null;
    const result = await checkForUpdate(app.getVersion(), {
      feedUrl: process.env.PR_ATLAS_UPDATE_FEED_URL,
      platform: process.platform,
      arch: process.arch,
    });
    if (
      checkSequence === updateCheckSequence &&
      !startedDuringDownload &&
      downloadGenerationAtStart === updateDownloadGeneration
    ) {
      latestSafeUpdate =
        result.available &&
        result.downloadUrl &&
        result.artifactName &&
        result.digest
          ? result
          : null;
      downloadedUpdatePath = null;
      downloadedUpdateDigest = null;
    }
    return result;
  });
  ipcMain.handle(
    "pr-atlas:download-update",
    async (event): Promise<UpdateDownloadResult> => {
      if (!latestSafeUpdate || activeUpdateDownload)
        return { success: false, error: GENERIC_UPDATE_DOWNLOAD_ERROR };
      updateDownloadGeneration += 1;
      const task = downloadUpdateArtifact(latestSafeUpdate, {
        downloadsPath: app.getPath("downloads"),
        platform: process.platform,
        arch: process.arch,
        onProgress: (progress: UpdateDownloadProgress) => {
          try {
            event.sender.send("pr-atlas:update-download-progress", progress);
          } catch {
            /* The invoking renderer may have closed during download. */
          }
        },
      }).then((result) => {
        downloadedUpdatePath = result.success ? (result.path ?? null) : null;
        downloadedUpdateDigest = result.success
          ? (result.digest ?? null)
          : null;
        return result;
      });
      activeUpdateDownload = task;
      try {
        return await task;
      } finally {
        if (activeUpdateDownload === task) activeUpdateDownload = null;
      }
    },
  );
  ipcMain.handle("pr-atlas:open-downloaded-update", () =>
    openDownloadedArtifact(
      downloadedUpdatePath,
      downloadedUpdateDigest,
      (path) => shell.openPath(path),
    ),
  );
}
app.whenReady().then(() => {
  const homePath = app.getPath("home");
  const nvmVersionPaths = discoverNvmVersionBinPaths(homePath, (directory) =>
    readdirSync(directory),
  );
  process.env.PATH = normalizeDesktopPath(process.env.PATH, process.platform, {
    homePath,
    nvmVersionPaths,
  });
  analysis = new AnalysisService(
    app.getPath("userData"),
    undefined,
    (event) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send("pr-atlas:progress", event);
    },
  );
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
