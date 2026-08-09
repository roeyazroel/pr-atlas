import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage, ProviderAnalysisTask } from '../../shared/contracts.js';
import { detectProvider, buildAnalysisPrompt, discoverClaudeModels, runProviderProcess, schemaForProvider, withTemporaryMcpConfig, READ_ONLY_CAPABILITIES, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

type ClaudeSpawn = ProviderSpawn;

const CLAUDE_CAPABILITIES: AgentCapabilities = { ...READ_ONLY_CAPABILITIES, toolAllowlist: true };

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  constructor(private readonly runner: CommandRunner, private readonly spawn: ClaudeSpawn = nodeSpawn as ClaudeSpawn) {}

  getCapabilities(): AgentCapabilities { return { ...CLAUDE_CAPABILITIES }; }
  detect(): Promise<AgentInstallationStatus> { return detectProvider(this.runner, this.id, this.displayName, 'claude', this.getCapabilities()); }
  listModels(): Promise<AgentModelOption[]> { return discoverClaudeModels(this.runner, 'claude'); }

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string, task?: ProviderAnalysisTask): Promise<AgentAnalysisResult> {
    if (task?.coordinator) return withTemporaryMcpConfig(async (mcpConfig) => {
      const selectedModel = model?.trim() || request.model?.trim();
      const args = ["-p", buildAnalysisPrompt(request, undefined, task), ...(selectedModel ? ["--model", selectedModel] : []), ...(request.effort ? ["--effort", request.effort] : []), "--safe-mode", "--setting-sources", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", mcpConfig, "--settings", mcpConfig, "--allowedTools", "Read,Grep,Glob,mcp__atlas__get_task,mcp__atlas__get_anchor,mcp__atlas__get_pr_context,mcp__atlas__validate_evidence,mcp__atlas__preflight_result,mcp__atlas__report_progress,mcp__atlas__submit_result", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
      return runProviderProcess(this, this.runner, this.spawn, "claude", args, request, worktree, signal, progress, task);
    }, { mcpServers: { atlas: { command: process.execPath, args: [task.coordinator.shimPath], env: { ATLAS_COORDINATOR_URL: task.coordinator.url, ATLAS_TASK_TOKEN: task.coordinator.token, ELECTRON_RUN_AS_NODE: "1" } } }, sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [worktree] }, network: { allowedDomains: [] } } });
    const validatorTool = task?.kind === "map" || task?.kind === "reduce"
      ? `Bash(${task.validatorCommand} *)`
      : undefined;
    const args = ['-p', buildAnalysisPrompt(request, inputDirectory, task), ...(request.effort ? ['--effort', request.effort] : [])];
    const selectedModel = model?.trim() || request.model?.trim();
    if (selectedModel) args.push('--model', selectedModel);
    args.push(
      '--safe-mode',
      '--permission-mode', 'plan', '--allowed-tools', 'Read', 'Grep', 'Glob', ...(validatorTool ? [validatorTool] : []),
      '--add-dir', inputDirectory,
      '--no-session-persistence',
      '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(schemaForProvider(task)),
    );
    return runProviderProcess(this, this.runner, this.spawn, 'claude', args, request, worktree, signal, progress, task);
  }
}
