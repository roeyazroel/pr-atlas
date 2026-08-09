import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage, ProviderAnalysisTask } from '../../shared/contracts.js';
import { buildAnalysisPrompt, detectProvider, discoverCodexModels, discoverProviderModels, runProviderProcess, schemaForProvider, withTemporarySchema, READ_ONLY_CAPABILITIES, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

type CodexSpawn = ProviderSpawn;

const CODEX_CAPABILITIES: AgentCapabilities = { ...READ_ONLY_CAPABILITIES, streaming: true };

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  constructor(private readonly runner: CommandRunner, private readonly spawn: CodexSpawn = nodeSpawn as CodexSpawn) {}

  getCapabilities(): AgentCapabilities { return { ...CODEX_CAPABILITIES }; }
  detect(): Promise<AgentInstallationStatus> { return detectProvider(this.runner, this.id, this.displayName, 'codex', this.getCapabilities()); }
  async listModels(): Promise<AgentModelOption[]> {
    const generic = await discoverProviderModels(this.runner, 'codex', this.id);
    return generic.length ? generic : discoverCodexModels(this.spawn, 'codex');
  }
  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string, task?: ProviderAnalysisTask): Promise<AgentAnalysisResult> {
    if (task?.coordinator) {
      const selectedModel = model?.trim() || request.model?.trim();
      const config = [
        `mcp_servers.atlas.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.atlas.args=[${JSON.stringify(task.coordinator.shimPath)}]`,
        "mcp_servers.atlas.env_vars=[\"ATLAS_COORDINATOR_URL\",\"ATLAS_TASK_TOKEN\",\"ELECTRON_RUN_AS_NODE\"]",
        "mcp_servers.atlas.default_tools_approval_mode=\"approve\"",
        "approval_policy=\"never\"",
      ];
      const args = ["exec", ...(request.effort ? ["-c", `model_reasoning_effort=\"${request.effort}\"`] : []), ...(selectedModel ? ["--model", selectedModel] : []), "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", ...config.flatMap((item) => ["-c", item]), buildAnalysisPrompt(request, undefined, task)];
      return runProviderProcess(this, this.runner, this.spawn, "codex", args, request, worktree, signal, progress, task);
    }
    return withTemporarySchema(async (schemaPath) => {
      const selectedModel = model?.trim() || request.model?.trim();
      const effort = request.effort;
      const args = [
        'exec',
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
        ...(selectedModel ? ['--model', selectedModel] : []),
        '--json',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        ...(task ? ['--skip-git-repo-check'] : []),
        '--output-schema', schemaPath,
        buildAnalysisPrompt(request, inputDirectory, task),
      ];
      return runProviderProcess(this, this.runner, this.spawn, 'codex', args, request, worktree, signal, progress, task);
    }, schemaForProvider(task));
  }
}
