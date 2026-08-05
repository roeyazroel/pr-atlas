import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage } from '../../shared/contracts.js';
import { detectProvider, buildAnalysisPrompt, discoverClaudeModels, parseProviderOutput, runProviderProcess, schemaForProvider, READ_ONLY_CAPABILITIES, SKILL_CONTRACT_VERSION, SKILL_REFERENCE_URL, type ProviderSpawn } from './agent.js';
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

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string): Promise<ClaudeResponse> {
    const args = ['-p', buildAnalysisPrompt(request)];
    const selectedModel = model?.trim() || request.model?.trim();
    if (selectedModel) args.push('--model', selectedModel);
    args.push(
      '--safe-mode',
      '--permission-mode', 'plan',
      '--allowed-tools', 'Read', 'Grep', 'Glob',
      '--add-dir', inputDirectory,
      '--no-session-persistence',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schemaForProvider()),
    );
    return runProviderProcess(this, this.runner, this.spawn, 'claude', args, request, worktree, signal, progress);
  }
}

/** Compatibility helper retained for callers that previously parsed Claude envelopes directly. */
export function parseEnvelope(raw: string): unknown { return parseProviderOutput(raw); }
