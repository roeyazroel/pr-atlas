import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, AgentCapabilities, AgentInstallationStatus, AnalysisRequest, AnalysisStage, WalkthroughDocument } from '../../shared/contracts'
import { buildProviderEnvironment, detectProvider, redactProviderDocument, redactProviderOutput, redactProviderStderr, runProviderProcess } from '../../electron/backend/agent'

const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: false,
  sessionContinuation: false,
  readOnly: true,
  toolAllowlist: false,
  modelSelection: true,
  authenticationState: false,
}

const request: AnalysisRequest = {
  repository: 'acme/atlas',
  pullNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  provider: 'codex',
}

describe('provider process security boundary', () => {
  it('does not spawn a provider when cancellation lands during detection', async () => {
    let finishDetection!: () => void
    const detectionPending = new Promise<void>((resolve) => { finishDetection = resolve })
    const adapter = {
      id: 'codex',
      displayName: 'Codex CLI',
      detect: vi.fn(async (): Promise<AgentInstallationStatus> => {
        await detectionPending
        return { provider: 'codex', displayName: 'Codex CLI', executable: 'codex', installed: true, capabilities }
      }),
      getCapabilities: () => capabilities,
    } as unknown as AgentAdapter
    const controller = new AbortController()
    const spawn = vi.fn()

    const pending = runProviderProcess(adapter, { run: vi.fn() }, spawn, 'codex', [], request, '/worktree', controller.signal, vi.fn())
    controller.abort()
    finishDetection()

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['codex', 'OPENAI_API_KEY', 'CODEX_HOME', ['ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']],
    ['claude', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', ['OPENAI_API_KEY', 'CURSOR_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']],
    ['cursor', 'CURSOR_API_KEY', 'CURSOR_CONFIG_DIR', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']],
  ] as const)('passes runtime/config and only %s authentication variables', (provider, expectedAuth, expectedConfig, excludedAuth) => {
    const environment = buildProviderEnvironment(provider, {
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      USERPROFILE: 'C:\\Users\\tester',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/Users/tester/.config',
      XDG_CONFIG_DIRS: '/etc/xdg',
      CODEX_HOME: '/Users/tester/.codex',
      CLAUDE_CONFIG_DIR: '/Users/tester/.claude',
      CURSOR_CONFIG_DIR: '/Users/tester/.cursor',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      CURSOR_API_KEY: 'cursor-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'github-secret',
      HTTP_PROXY: 'http://proxy.local:8080',
      ELECTRON_RUN_AS_NODE: '1',
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
      UNRELATED_SECRET: 'should-not-cross-process-boundary',
      DATABASE_PASSWORD: 'should-not-cross-process-boundary',
      XDG_UNRELATED_SECRET: 'should-not-cross-process-boundary',
    })

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      USERPROFILE: 'C:\\Users\\tester',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/Users/tester/.config',
      XDG_CONFIG_DIRS: '/etc/xdg',
      [expectedAuth]: expect.any(String),
      [expectedConfig]: expectedConfig === 'CODEX_HOME' ? '/Users/tester/.codex' : expectedConfig === 'CLAUDE_CONFIG_DIR' ? '/Users/tester/.claude' : expect.any(String),
      HTTP_PROXY: 'http://proxy.local:8080',
    })
    expect(environment[expectedAuth]).toBeTypeOf('string')
    for (const key of excludedAuth) expect(environment).not.toHaveProperty(key)
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('VITE_DEV_SERVER_URL')
    expect(environment).not.toHaveProperty('UNRELATED_SECRET')
    expect(environment).not.toHaveProperty('DATABASE_PASSWORD')
    expect(environment).not.toHaveProperty('XDG_UNRELATED_SECRET')
  })

  it('redacts environment secrets and token-shaped stderr values', () => {
    const stderr = [
      'OPENAI_API_KEY=openai-secret',
      'Authorization: Bearer bearer-secret',
      'Proxy-Authorization: Basic basic-secret',
      'token: inline-token',
      'Token inline-token-standalone',
      'PASSWORD="inline-password"',
    ].join('\n')

    const redacted = redactProviderStderr(stderr, {
      OPENAI_API_KEY: 'openai-secret',
      UNRELATED_SECRET: 'unrelated-secret',
    })

    expect(redacted).not.toContain('openai-secret')
    expect(redacted).not.toContain('bearer-secret')
    expect(redacted).not.toContain('basic-secret')
    expect(redacted).not.toContain('inline-token')
    expect(redacted).not.toContain('inline-token-standalone')
    expect(redacted).not.toContain('inline-password')
    expect(redacted).toContain('[REDACTED]')
  })

  it('keeps already-redacted credential prose stable across repeated sanitization', () => {
    const source = 'task-token [REDACTED] · Bearer [REDACTED] · Authorization: [REDACTED] · Authorization: Bearer [REDACTED] · Proxy-Authorization: Basic [REDACTED] · Authorization=Token [REDACTED]'
    const once = redactProviderStderr(source, {})

    expect(once).toBe(source)
    expect(redactProviderStderr(once, {})).toBe(once)
    expect(once).not.toContain('[REDACTED]]')
  })

  it('redacts credentials embedded in proxy URLs', () => {
    const redacted = redactProviderStderr(
      'proxy failed: https://proxy-user:proxy-password@proxy.example.test:8443/path',
      { HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example.test:8443' },
    )

    expect(redacted).not.toContain('proxy-user')
    expect(redacted).not.toContain('proxy-password')
    expect(redacted).toContain('https://[REDACTED]@proxy.example.test:8443/path')
  })

  it('redacts provider stderr before returning logs to callers', async () => {
    const originalApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'openai-secret'
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdin: { end: ReturnType<typeof vi.fn> }
        kill: ReturnType<typeof vi.fn>
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end: vi.fn() }
      child.kill = vi.fn()
      const spawn = vi.fn((_file: string, _args: string[], _options: { cwd: string; stdio: 'pipe'; windowsHide: boolean; env?: NodeJS.ProcessEnv }) => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('provider output: OPENAI_API_KEY=openai-secret'))
          child.stderr.emit('data', Buffer.from('provider failed: OPENAI_API_KEY=openai-secret Authorization: Bearer bearer-secret'))
          child.emit('close', 1)
        })
        return child as unknown as ChildProcess
      })
      const adapter = {
        id: 'codex',
        displayName: 'Codex CLI',
        detect: vi.fn(async (): Promise<AgentInstallationStatus> => ({ provider: 'codex', displayName: 'Codex CLI', executable: 'codex', installed: true, capabilities })),
        getCapabilities: () => capabilities,
      } as unknown as AgentAdapter

      const response = await runProviderProcess(
        adapter,
        { run: vi.fn() },
        spawn,
        'codex',
        [],
        request,
        '/worktree',
        undefined,
        vi.fn<(stage: AnalysisStage, message: string) => void>(),
      )

      expect(spawn).toHaveBeenCalledWith('codex', [], expect.objectContaining({ env: expect.any(Object) }))
      const spawnedEnvironment = (spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {}
      expect(spawnedEnvironment.OPENAI_API_KEY).toBe('openai-secret')
      expect(spawnedEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(spawnedEnvironment).not.toHaveProperty('CURSOR_API_KEY')
      expect(spawnedEnvironment).not.toHaveProperty('GITHUB_TOKEN')
      expect(spawnedEnvironment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
      expect(response.logs.join('\n')).not.toContain('openai-secret')
      expect(response.logs.join('\n')).not.toContain('bearer-secret')
      expect(response.rawOutput).not.toContain('openai-secret')
      expect(response.logs.join('\n')).toContain('[REDACTED]')
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
    }
  })

  it('redacts provider stderr before using it in installation status', async () => {
    const status = await detectProvider(
      { run: vi.fn(async () => ({ stdout: 'OPENAI_API_KEY=openai-secret', stderr: 'Authorization: Bearer bearer-secret' })) },
      'codex',
      'Codex CLI',
      'codex',
      capabilities,
    )

    expect(status.version).not.toContain('openai-secret')
    expect(status.version).not.toContain('bearer-secret')
    expect(status.version).toContain('[REDACTED]')
  })

  it('redacts stdout with the same boundary used for stderr', () => {
    expect(redactProviderOutput('OPENAI_API_KEY=openai-secret Authorization: Bearer bearer-secret')).toContain('[REDACTED]')
    expect(redactProviderOutput('OPENAI_API_KEY=openai-secret Authorization: Bearer bearer-secret')).not.toContain('openai-secret')
  })

  it('redacts validated document string leaves without changing their types', () => {
    const document = { summary: { intent: 'OPENAI_API_KEY=openai-secret' } } as unknown as WalkthroughDocument
    const safe = redactProviderDocument(document)
    expect(safe.summary.intent).toContain('[REDACTED]')
    expect(typeof safe.summary.intent).toBe('string')
  })
})
