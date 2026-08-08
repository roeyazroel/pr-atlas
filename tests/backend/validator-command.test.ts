import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBatchMapValidatorScript } from "../../electron/backend/batching";
import { buildBundledValidatorCommand, buildWindowsValidatorLauncher, VALIDATOR_RUNTIME_ENV, validatorLauncherName } from "../../electron/backend/validator-command";

function localElectronRuntime(): string {
  const root = resolve("node_modules/electron/dist");
  return process.platform === "darwin"
    ? join(root, "Electron.app/Contents/MacOS/Electron")
    : join(root, process.platform === "win32" ? "electron.exe" : "electron");
}

async function run(command: string, cwd: string, input: string, environment: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...environment } })
      : spawn("sh", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...environment } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("bundled validator command", () => {
  it("quotes bundled-runtime paths and uses a shell-neutral Windows launcher command", () => {
    expect(buildBundledValidatorCommand("validate map; $(bad).mjs", "darwin")).toBe('ELECTRON_RUN_AS_NODE=1 "$PR_ATLAS_VALIDATOR_RUNTIME" \'validate map; $(bad).mjs\'');
    expect(buildBundledValidatorCommand("validate reduce.mjs", "linux")).toBe('ELECTRON_RUN_AS_NODE=1 "$PR_ATLAS_VALIDATOR_RUNTIME" \'validate reduce.mjs\'');
    expect(validatorLauncherName("map")).toBe("run-map-validator.cmd");
    expect(validatorLauncherName("reduce")).toBe("run-reduce-validator.cmd");
    expect(buildBundledValidatorCommand("validate-map-output.mjs", "win32", "run-map-validator.cmd")).toBe("cmd.exe /d /s /c run-map-validator.cmd");
    const unicodeRuntime = "C:\\Users\\Álvaro\\PR Atlas\\Electron.exe";
    expect(buildWindowsValidatorLauncher("validate-map-output.mjs")).toBe(`@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%${VALIDATOR_RUNTIME_ENV}%" "validate-map-output.mjs"\r\nexit /b %errorlevel%\r\n`);
    expect(buildWindowsValidatorLauncher("validate-map-output.mjs")).not.toContain(unicodeRuntime);
  });

  it("executes a task-local validator with the bundled Electron runtime and stdin", async () => {
    const runtime = localElectronRuntime();
    expect(existsSync(runtime)).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "pr atlas validator "));
    try {
      const task = { id: "map-001", files: [{ path: "src/a.ts", diff: "x", bytes: 1, segment: 0 }] };
      await writeFile(join(directory, "validate-map-output.mjs"), buildBatchMapValidatorScript(task), "utf8");
      const candidate = { taskId: task.id, observations: [{ path: "src/a.ts", segment: 0, summary: "Changed input.", evidence: [{ path: "src/a.ts", line: 1 }], changeGroups: ["group"], tests: [], flows: [], limitations: [] }] };
      await expect(run(buildBundledValidatorCommand("validate-map-output.mjs", process.platform), directory, JSON.stringify(candidate), { [VALIDATOR_RUNTIME_ENV]: runtime })).resolves.toMatchObject({ code: 0, stdout: expect.stringMatching(/passed/i) });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
