import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage, ProviderAnalysisTask } from '../../shared/contracts.js';
import { buildAnalysisPrompt, detectProvider, discoverCursorModels, runProviderProcess, READ_ONLY_CAPABILITIES, schemaForProvider, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

type CursorSpawn = ProviderSpawn;

const CURSOR_CAPABILITIES: AgentCapabilities = { ...READ_ONLY_CAPABILITIES };
export const CURSOR_COORDINATOR_ISOLATION_FAILED = "Cursor coordinator instruction isolation was unavailable.";

function isCursorInstructionPath(path: string): boolean {
  const parts = path.split(/[\\/]/).map((part) => part.toLowerCase());
  const name = parts.at(-1);
  return name === ".cursorrules" || name === "agents.md" || name === "claude.md" || parts.some((part, index) => part === ".cursor" && parts[index + 1] === "rules");
}
function isAllowedCursorShadowChange(path: string): boolean { return path.replace(/\\/g, "/").startsWith(".cursor/") || isCursorInstructionPath(path); }
async function sanitizeCursorInstructions(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (isCursorInstructionPath(target.slice(root.length + 1))) { await rm(target, { recursive: true, force: true }); continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(target);
    }
  };
  await visit(root);
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor Agent';
  constructor(private readonly runner: CommandRunner, private readonly spawn: CursorSpawn = nodeSpawn as CursorSpawn) {}

  getCapabilities(): AgentCapabilities { return { ...CURSOR_CAPABILITIES }; }
  detect(): Promise<AgentInstallationStatus> { return detectProvider(this.runner, this.id, this.displayName, 'cursor-agent', this.getCapabilities()); }
  listModels(): Promise<AgentModelOption[]> { return discoverCursorModels(this.runner, 'cursor-agent'); }

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string, task?: ProviderAnalysisTask): Promise<AgentAnalysisResult> {
    if (task?.coordinator) {
      const root = await mkdtemp(join(tmpdir(), "pr-atlas-cursor-")); const shadow = join(root, "exact-head");
      try {
        const head = (await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: worktree, timeout: 30_000, signal })).stdout.trim();
        if (!head) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        await this.runner.run("git", ["worktree", "add", "--detach", shadow, head], { cwd: worktree, timeout: 120_000, signal });
        const shadowHead = (await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: shadow, timeout: 30_000, signal })).stdout.trim();
        const initial = (await this.runner.run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: shadow, timeout: 30_000, signal })).stdout;
        if (shadowHead !== head || initial.trim()) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        await sanitizeCursorInstructions(shadow);
        // The root Cursor config is repository-controlled. Remove it without
        // following any symlink, then rebuild the host-owned MCP directory.
        const repositoryCursorDirectory = join(shadow, ".cursor");
        try {
          if ((await lstat(repositoryCursorDirectory)).isSymbolicLink() || (await lstat(join(repositoryCursorDirectory, "mcp.json"))).isSymbolicLink()) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        } catch (error) { if (error instanceof Error && error.message === CURSOR_COORDINATOR_ISOLATION_FAILED) throw error; }
        await rm(join(shadow, ".cursor"), { recursive: true, force: true });
        const trackedChanges = (await this.runner.run("git", ["diff", "--name-only"], { cwd: shadow, timeout: 30_000, signal })).stdout.split(/\r?\n/).filter(Boolean);
        const untracked = (await this.runner.run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: shadow, timeout: 30_000, signal })).stdout.split(/\r?\n/).filter(Boolean);
        if (trackedChanges.some((path) => !isAllowedCursorShadowChange(path)) || untracked.length) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        const cursorDirectory = join(shadow, ".cursor"); await mkdir(cursorDirectory, { recursive: true });
        const [shadowCanonical, cursorCanonical, metadata] = await Promise.all([realpath(shadow), realpath(cursorDirectory), lstat(cursorDirectory)]);
        if (metadata.isSymbolicLink() || cursorCanonical !== join(shadowCanonical, ".cursor")) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        const mcp = JSON.stringify({ mcpServers: { atlas: { command: process.execPath, args: [task.coordinator.shimPath], env: { ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, ELECTRON_RUN_AS_NODE: "1" } } } });
        const mcpPath = join(cursorDirectory, "mcp.json"); await writeFile(mcpPath, mcp, { encoding: "utf8", flag: "wx" });
        if ((await realpath(mcpPath)) !== join(shadowCanonical, ".cursor", "mcp.json") || (await lstat(mcpPath)).isSymbolicLink()) throw new Error(CURSOR_COORDINATOR_ISOLATION_FAILED);
        await writeFile(join(root, "mcp.json"), mcp, "utf8");
        const baseline = (await this.runner.run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: shadow, timeout: 30_000, signal })).stdout;
        const selectedModel = model?.trim() || request.model?.trim();
        const args = ["-p", buildAnalysisPrompt(request, undefined, task), ...(selectedModel ? ["--model", selectedModel] : []), "--output-format", "stream-json", "--mode", "ask", "--sandbox", "enabled", "--workspace", shadow, "--trust", "--approve-mcps"];
        const response = await runProviderProcess(this, this.runner, this.spawn, "cursor-agent", args, request, shadow, signal, progress, task, { CURSOR_CONFIG_DIR: root, ELECTRON_RUN_AS_NODE: "1" });
        const after = (await this.runner.run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: shadow, timeout: 30_000, signal })).stdout;
        return after === baseline ? response : { ...response, status: "invalid", errors: ["Cursor modified the disposable exact-head worktree; output was rejected."], document: undefined, taskOutput: undefined, mapOutput: undefined };
      } catch {
        return { status: "failed", rawOutput: "", logs: [], errors: [CURSOR_COORDINATOR_ISOLATION_FAILED] };
      } finally {
        await this.runner.run("git", ["reset", "--hard", "HEAD"], { cwd: shadow, timeout: 30_000 }).catch(() => undefined);
        await this.runner.run("git", ["clean", "-fd"], { cwd: shadow, timeout: 30_000 }).catch(() => undefined);
        await this.runner.run("git", ["worktree", "remove", shadow], { cwd: worktree, timeout: 120_000 }).catch(() => undefined);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const prompt = `${buildAnalysisPrompt(request, inputDirectory, task)}\n\nThe exact JSON Schema follows:\n${JSON.stringify(schemaForProvider(task))}`;
    const selectedModel = model?.trim() || request.model?.trim();
    const args = [
      '-p', prompt,
      ...(selectedModel ? ['--model', selectedModel] : []),
      '--output-format', 'json',
      '--mode', 'ask',
      '--sandbox', 'enabled',
      '--workspace', worktree,
      '--trust',
      '--add-dir', inputDirectory,
    ];
    return runProviderProcess(this, this.runner, this.spawn, 'cursor-agent', args, request, worktree, signal, progress, task);
  }
}
