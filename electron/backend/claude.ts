import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage, ProviderAnalysisTask } from '../../shared/contracts.js';
import { detectProvider, buildAnalysisPrompt, discoverClaudeModels, parseProviderOutput, runProviderProcess, schemaForProvider, withTemporaryMcpConfig, READ_ONLY_CAPABILITIES, SKILL_CONTRACT_VERSION, SKILL_REFERENCE_URL, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

export { SKILL_CONTRACT_VERSION, SKILL_REFERENCE_URL } from './agent.js';
export type ClaudeSpawn = ProviderSpawn;
export type ClaudeResponse = AgentAnalysisResult;

const CLAUDE_CAPABILITIES: AgentCapabilities = { ...READ_ONLY_CAPABILITIES, toolAllowlist: true };

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  constructor(private readonly runner: CommandRunner, private readonly spawn: ClaudeSpawn = nodeSpawn as ClaudeSpawn) {}

  getCapabilities(): AgentCapabilities { return { ...CLAUDE_CAPABILITIES }; }
  detect(): Promise<AgentInstallationStatus> { return detectProvider(this.runner, this.id, this.displayName, 'claude', this.getCapabilities()); }
  listModels(): Promise<AgentModelOption[]> { return discoverClaudeModels(this.runner, 'claude'); }
  getModels(): Promise<AgentModelOption[]> { return this.listModels(); }
  discoverModels(): Promise<AgentModelOption[]> { return this.listModels(); }

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string, task?: ProviderAnalysisTask): Promise<ClaudeResponse> {
    if (task?.coordinator) return withTemporaryMcpConfig(async (mcpConfig) => {
      const selectedModel = model?.trim() || request.model?.trim();
      const args = ["-p", buildAnalysisPrompt(request, undefined, task), ...(selectedModel ? ["--model", selectedModel] : []), ...(request.effort ? ["--effort", request.effort] : []), "--safe-mode", "--setting-sources", "", "--permission-mode", "plan", "--strict-mcp-config", "--mcp-config", mcpConfig, "--settings", mcpConfig, "--allowedTools", "Read,Grep,Glob,Bash,mcp__atlas__get_task,mcp__atlas__get_anchor,mcp__atlas__get_pr_context,mcp__atlas__validate_evidence,mcp__atlas__report_progress,mcp__atlas__submit_result", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
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
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schemaForProvider(task)),
    );
    return runProviderProcess(this, this.runner, this.spawn, 'claude', args, request, worktree, signal, progress, task);
  }
}

/** Compatibility helper retained for callers that previously parsed Claude envelopes directly. */
export function parseEnvelope(raw: string): unknown { return parseProviderOutput(raw); }
