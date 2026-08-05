import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage, ProviderAnalysisTask } from '../../shared/contracts.js';
import { buildAnalysisPrompt, detectProvider, discoverCodexModels, discoverProviderModels, runProviderProcess, schemaForProvider, withTemporarySchema, READ_ONLY_CAPABILITIES, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

export type CodexSpawn = ProviderSpawn;
export type CodexResponse = AgentAnalysisResult;

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
  getModels(): Promise<AgentModelOption[]> { return this.listModels(); }
  discoverModels(): Promise<AgentModelOption[]> { return this.listModels(); }

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string, task?: ProviderAnalysisTask): Promise<CodexResponse> {
    return withTemporarySchema(async (schemaPath) => {
      const selectedModel = model?.trim() || request.model?.trim();
      const args = [
        'exec',
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
