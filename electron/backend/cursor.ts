import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentAdapter, AgentAnalysisResult, AgentCapabilities, AgentInstallationStatus, AgentModelOption, AnalysisRequest, AnalysisStage } from '../../shared/contracts.js';
import { buildAnalysisPrompt, detectProvider, discoverProviderModels, runProviderProcess, READ_ONLY_CAPABILITIES, schemaForProvider, type ProviderSpawn } from './agent.js';
import type { CommandRunner } from './github.js';

export type CursorSpawn = ProviderSpawn;
export type CursorResponse = AgentAnalysisResult;

const CURSOR_CAPABILITIES: AgentCapabilities = { ...READ_ONLY_CAPABILITIES };

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor Agent';
  constructor(private readonly runner: CommandRunner, private readonly spawn: CursorSpawn = nodeSpawn as CursorSpawn) {}

  getCapabilities(): AgentCapabilities { return { ...CURSOR_CAPABILITIES }; }
  detect(): Promise<AgentInstallationStatus> { return detectProvider(this.runner, this.id, this.displayName, 'cursor-agent', this.getCapabilities()); }
  listModels(): Promise<AgentModelOption[]> { return discoverProviderModels(this.runner, 'cursor-agent', this.id); }
  getModels(): Promise<AgentModelOption[]> { return this.listModels(); }
  discoverModels(): Promise<AgentModelOption[]> { return this.listModels(); }

  async analyze(request: AnalysisRequest, worktree: string, inputDirectory: string, signal: AbortSignal | undefined, progress: (stage: AnalysisStage, message: string) => void, model?: string): Promise<CursorResponse> {
    const prompt = `${buildAnalysisPrompt(request)}\n\nThe exact JSON Schema follows:\n${JSON.stringify(schemaForProvider())}`;
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
    return runProviderProcess(this, this.runner, this.spawn, 'cursor-agent', args, request, worktree, signal, progress);
  }
}
