import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, AnalysisRequest, AnalysisStage } from '../../shared/contracts'
import { ClaudeAdapter } from '../../electron/backend/claude'
import { CodexAdapter } from '../../electron/backend/codex'
import { CursorAdapter } from '../../electron/backend/cursor'
import { buildAnalysisPrompt, discoverCodexModels, parseProviderModels, parseProviderOutput, schemaForProvider } from '../../electron/backend/agent'
import { validateWalkthroughDocument } from '../../shared/schema'
import { AnalysisService } from '../../electron/backend/service'

type SpawnCall = {
  file: string
  args: string[]
  options: { cwd: string; stdio: 'pipe'; windowsHide: boolean; env?: NodeJS.ProcessEnv }
  stdinEnd: ReturnType<typeof vi.fn>
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

const requestFor = (provider: AnalysisRequest['provider']): AnalysisRequest => ({
  repository: 'acme/atlas',
  pullNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  provider,
})

function fakeSpawn(rawOutput: string, calls: SpawnCall[]) {
  return (file: string, args: string[], options: SpawnCall['options']): ChildProcess => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdinEnd = vi.fn()
    child.stdin = { write: vi.fn(), end: stdinEnd }
    child.kill = vi.fn()
    calls.push({ file, args, options, stdinEnd })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(rawOutput))
      child.emit('close', 0)
    })
    return child as unknown as ChildProcess
  }
}

const progress = vi.fn<(stage: AnalysisStage, message: string) => void>()
const adapterCapabilities = {
  structuredOutput: true,
  streaming: false,
  sessionContinuation: false,
  readOnly: true,
  toolAllowlist: false,
  modelSelection: true,
  authenticationState: false,
}

describe('provider structured-output schema', () => {
  it('normalizes every object and array for Codex strict JSON-schema mode', () => {
    const schema = schemaForProvider() as Record<string, unknown>
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!value || typeof value !== 'object') return
      const node = value as Record<string, unknown>
      if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
        const properties = node.properties as Record<string, unknown>
        expect(node.additionalProperties).toBe(false)
        expect(node.required).toEqual(Object.keys(properties))
        Object.values(properties).forEach(walk)
      }
      if (node.type === 'array') {
        expect(node.items).toBeDefined()
        walk(node.items)
      }
    }

    expect(schema.$id).toBeUndefined()
    walk(schema)
    const summary = (schema.properties as Record<string, unknown>).summary as Record<string, unknown>
    const summaryProperties = summary.properties as Record<string, unknown>
    for (const key of ['behavioralChanges', 'architecturalImpact', 'limitations']) {
      expect((summaryProperties[key] as Record<string, unknown>).items).toEqual(expect.objectContaining({ type: 'string', minLength: 1 }))
    }
  })

  it('requires rich walkthrough fields in provider output while keeping historical documents valid', () => {
    const schema = schemaForProvider() as Record<string, unknown>
    const propertiesAt = (path: string[]): Record<string, unknown> => {
      let node: Record<string, unknown> = schema
      for (const segment of path) {
        const properties = node.properties as Record<string, unknown>
        node = properties[segment] as Record<string, unknown>
        if (node.type === 'array') node = node.items as Record<string, unknown>
      }
      return node.properties as Record<string, unknown>
    }
    const expectRich = (path: string[], fields: string[]) => {
      const node = propertiesAt(path)
      expect(Object.keys(node)).toEqual(expect.arrayContaining(fields))
      const parent = path.reduce<Record<string, unknown>>((current, segment) => {
        const properties = current.properties as Record<string, unknown>
        const next = properties[segment] as Record<string, unknown>
        return next.type === 'array' ? next.items as Record<string, unknown> : next
      }, schema)
      expect(parent.required).toEqual(expect.arrayContaining(fields))
    }
    expectRich(['changeGroups'], ['summary', 'motivation', 'previousBehavior', 'newBehavior', 'attention'])
    expectRich(['evidence'], ['path'])
    expectRich(['tests'], ['title', 'behavior'])
    expectRich(['reviewThreads'], ['author', 'body'])
    expectRich(['reviewInsights'], ['detail', 'status', 'provenance'])
    expectRich(['graphs', 'systemOverview'], ['description'])
    expectRich(['graphs', 'systemOverview', 'nodes'], ['label', 'evidenceIds'])
    expectRich(['graphs', 'systemOverview', 'guidedTours', 'steps'], ['title', 'explanation'])

    expect(validateWalkthroughDocument(minimalWalkthrough()).valid).toBe(true)
  })
})

describe('provider output envelopes', () => {
  it('extracts a walkthrough from Codex JSONL item.completed instead of trailing turn events', () => {
    const walkthrough = minimalWalkthrough()
    const raw = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(walkthrough) } },
      { type: 'turn.completed' },
    ].map((event) => JSON.stringify(event)).join('\n')

    expect(parseProviderOutput(raw)).toEqual(walkthrough)
  })

  it('extracts one fenced JSON walkthrough from a prose result envelope', () => {
    const walkthrough = minimalWalkthrough()
    const raw = JSON.stringify({
      type: 'result',
      result: `I prepared the walkthrough below.\n\n\`\`\`json\n${JSON.stringify(walkthrough)}\n\`\`\`\nThis is the complete result.`,
    })

    expect(parseProviderOutput(raw)).toEqual(walkthrough)
  })
})

describe('provider model discovery', () => {
  it('parses Cursor Agent plain model listings while ignoring headers and tips', () => {
    const raw = `Available models

auto - Auto (default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High

Tip: Use --model <model> to select a model.
`

    expect(parseProviderModels(raw)).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true },
      { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
    ])
  })
})

describe('provider analysis prompt', () => {
  it('requires graph edge, tour, and final consistency checks', () => {
    const prompt = buildAnalysisPrompt(requestFor('claude'))
    expect(prompt).toMatch(/every graph edge source and target must reference an existing node in the same graph/i)
    expect(prompt).toMatch(/every guided-tour step nodeId must reference an existing node in that graph/i)
    expect(prompt).toMatch(/final consistency check before returning/i)
    expect(prompt).toMatch(/no review threads.*empty reviewThreads and reviewInsights arrays/i)
  })

  it('defines deterministic GitHub review status precedence and canonical metadata', () => {
    const prompt = buildAnalysisPrompt(requestFor('claude'))
    expect(prompt).toMatch(/outdated if isOutdated is true.*resolved if isResolved is true.*active/i)
    expect(prompt).toMatch(/preserve.*author.*body.*location.*timestamp.*commit/i)
  })

  it('adds user collection guidance without allowing it to replace the fixed structure', () => {
    const prompt = buildAnalysisPrompt({ ...requestFor('claude'), customPrompt: 'Collect more migration and rollback evidence.' })
    expect(prompt).toMatch(/supplemental collection guidance/i)
    expect(prompt).toContain('Collect more migration and rollback evidence.')
    expect(prompt).toMatch(/cannot remove, rename, or weaken/i)
    expect(prompt).toMatch(/return only output conforming to the supplied JSON schema/i)
  })
})

function minimalWalkthrough(): Record<string, unknown> {
  const graph = (id: string) => ({
    id,
    description: `Review ${id}.`,
    nodes: [{
      id: `${id}-node`, label: 'Relevant node', explanation: 'A relevant node.', changed: id !== 'system-overview',
      changeGroupIds: id === 'system-overview' ? [] : ['group-1'], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: id === 'system-overview' ? [] : ['evidence-1'],
    }],
    edges: id === 'system-overview' ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: 'continues', evidenceIds: ['evidence-1'], changeGroupIds: ['group-1'], reviewThreadIds: [] }],
    guidedTours: [{ id: `${id}-tour`, title: 'Review this graph', steps: [{ nodeId: `${id}-node`, title: 'Inspect node', explanation: 'Verify exact evidence.' }] }],
  })
  return {
    schemaVersion: '1.0.0',
    run: { id: 'run-1', createdAt: '2026-08-05T00:00:00.000Z', provider: 'codex', model: 'test-model', skillVersion: '1.0.0' },
    pullRequest: { host: 'github.com', repository: 'acme/atlas', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    summary: { intent: 'Trace the changed system.', behavioralChanges: [], architecturalImpact: [], limitations: [] },
    changeGroups: [{ id: 'group-1', title: 'Trace evidence', summary: 'Connects the behavior to code.', motivation: 'Reviewers need exact evidence.', previousBehavior: 'Evidence was implicit.', newBehavior: 'Evidence is linked.', attention: 'medium', evidenceIds: ['evidence-1'] }],
    walkthrough: [{ id: 'step-1', title: 'Inspect evidence', changeGroupId: 'group-1', evidenceIds: ['evidence-1'] }],
    graphs: { systemOverview: graph('system-overview'), dataFlow: graph('data-flow'), codeDependency: graph('code-dependency'), userAction: graph('user-action') },
    tests: [], reviewThreads: [], reviewInsights: [], evidence: [{ id: 'evidence-1', kind: 'file', title: 'Agent source', path: 'electron/backend/agent.ts', line: null, url: null }],
  }
}

describe('provider-neutral agent adapters', () => {
  it('reports providers in Codex, Cursor, Claude priority regardless of construction order', async () => {
    const adapter = (id: 'claude' | 'codex' | 'cursor'): AgentAdapter => ({
      id,
      displayName: id,
      detect: vi.fn(async () => ({ provider: id, displayName: id, executable: id, installed: true, capabilities: adapterCapabilities })),
      getCapabilities: () => adapterCapabilities,
      analyze: vi.fn(),
    })
    const service = new AnalysisService('/tmp/pr-atlas-provider-priority', { run: vi.fn() }, undefined, undefined, [adapter('claude'), adapter('cursor'), adapter('codex')])

    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({ provider: 'codex' }),
      expect.objectContaining({ provider: 'cursor' }),
      expect.objectContaining({ provider: 'claude' }),
    ])
  })

  it('surfaces only model choices dynamically reported by each installed adapter', async () => {
    const adapter = {
      id: 'codex', displayName: 'Codex CLI',
      detect: vi.fn(async () => ({ provider: 'codex', displayName: 'Codex CLI', executable: 'codex', installed: true, capabilities: adapterCapabilities })),
      listModels: vi.fn(async () => [{ id: 'tool-model-a', label: 'Tool model A', isDefault: true }]),
      getCapabilities: vi.fn(), analyze: vi.fn(),
    } as unknown as AgentAdapter
    const service = new AnalysisService('/tmp/pr-atlas-provider-models', { run: vi.fn() }, undefined, undefined, [adapter])

    await expect(service.listProviders()).resolves.toEqual([expect.objectContaining({ models: [{ id: 'tool-model-a', label: 'Tool model A', isDefault: true }] })])
    expect(adapter.listModels).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['claude', ClaudeAdapter, 'claude', 'Claude Code 1.2.3'],
    ['codex', CodexAdapter, 'codex', 'codex-cli 1.2.3'],
    ['cursor', CursorAdapter, 'cursor-agent', 'cursor-agent 1.2.3'],
  ] as const)('detects %s through the injected command runner', async (_id, Adapter, executable, version) => {
    const runner = { run: vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe(executable)
      expect(args).toEqual(['--version'])
      return { stdout: version }
    }) }

    const adapter = new Adapter(runner)
    const status = await adapter.detect()

    expect(status.installed).toBe(true)
    expect(status.executable).toBe(executable)
    expect(status.version).toBe(version)
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['claude', ClaudeAdapter, 'claude'],
    ['codex', CodexAdapter, 'codex'],
    ['cursor', CursorAdapter, 'cursor-agent'],
  ] as const)('returns a safe unavailable status when %s is not on PATH', async (_id, Adapter, executable) => {
    const runner = { run: vi.fn(async () => { throw new Error(`spawn ${executable} ENOENT`) }) }
    const adapter = new Adapter(runner)

    const status = await adapter.detect()

    expect(status.installed).toBe(false)
    expect(status.executable).toBe(executable)
    expect(status.error).toEqual(expect.any(String))
    expect(status.error).not.toContain('ENOENT')
  })

  it.each([
    ['claude', ClaudeAdapter, 'claude'],
    ['codex', CodexAdapter, 'codex'],
    ['cursor', CursorAdapter, 'cursor-agent'],
  ] as const)('discovers %s models from the installed runtime', async (_id, Adapter, executable) => {
    const runner = { run: vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe(executable)
      expect(args).toEqual(['models'])
      return { stdout: JSON.stringify({ models: [{ id: `${_id}-runtime-1`, name: 'display name' }, { id: `${_id}-runtime-2` }] }) }
    }) }
    const adapter = new Adapter(runner)

    await expect(adapter.listModels()).resolves.toEqual([
      { id: `${_id}-runtime-1`, label: 'display name' },
      { id: `${_id}-runtime-2`, label: `${_id}-runtime-2` },
    ])
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('falls back to Codex app-server model/list when the models command is unavailable', async () => {
    const calls: SpawnCall[] = []
    const writes: string[] = []
    let kill: ReturnType<typeof vi.fn> | undefined
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'models') throw new Error('unsupported models command')
      return { stdout: 'codex-cli 1.2.3' }
    }) }
    const spawn = (file: string, args: string[], options: SpawnCall['options']): ChildProcess => {
      const child = new EventEmitter() as FakeChild
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = {
        write: vi.fn((payload: string | Uint8Array) => {
          const message = JSON.parse(String(payload)) as { id?: string; method?: string }
          writes.push(String(payload))
          if (message.method === 'initialize') {
            queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { } })}\n`)))
          } else if (message.method === 'model/list') {
            queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({
              id: message.id,
              result: { models: [{ id: 'codex-local-fast', name: 'Local Fast', description: 'Local test model', isDefault: true }] },
            })}\n`)))
          }
          return true
        }),
        end: vi.fn(),
      }
      child.kill = kill = vi.fn()
      calls.push({ file, args, options, stdinEnd: child.stdin.end })
      return child as unknown as ChildProcess
    }
    const adapter = new CodexAdapter(runner, spawn)

    await expect(adapter.listModels()).resolves.toEqual([
      { id: 'codex-local-fast', label: 'Local Fast', description: 'Local test model', isDefault: true },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: 'codex', args: ['app-server'] })
    expect(calls[0].options.env).toBeDefined()
    expect(writes.map((payload) => JSON.parse(payload).method)).toEqual(['initialize', 'initialized', 'model/list'])
    expect(calls[0].stdinEnd).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('falls back to dynamically parsed Claude model aliases from --help', async () => {
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'models') throw new Error('unsupported models command')
      expect(args).toEqual(['--help'])
      return { stdout: `Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'local-fast', 'local-quality') or a
                                        model's full name (e.g.
                                        'provider/model-latest').
  --next-option                         Another option
` }
    }) }
    const adapter = new ClaudeAdapter(runner)

    await expect(adapter.listModels()).resolves.toEqual([
      { id: 'local-fast', label: 'local-fast' },
      { id: 'local-quality', label: 'local-quality' },
      { id: 'provider/model-latest', label: 'provider/model-latest' },
    ])
    expect(runner.run).toHaveBeenCalledTimes(2)
  })

  it('cancels a Codex app-server fallback and terminates the child process', async () => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write: vi.fn(), end: vi.fn() }
    child.kill = vi.fn()
    const spawn = vi.fn(() => child as unknown as ChildProcess) as unknown as Parameters<typeof discoverCodexModels>[0]
    const controller = new AbortController()
    const models = discoverCodexModels(spawn, 'codex', controller.signal)

    controller.abort()

    await expect(models).resolves.toEqual([])
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['claude', ClaudeAdapter],
    ['cursor', CursorAdapter],
  ] as const)('returns an empty model list when %s does not support discovery', async (_id, Adapter) => {
    const runner = { run: vi.fn(async () => { throw new Error('unsupported models command') }) }
    const adapter = new Adapter(runner)

    await expect(adapter.listModels()).resolves.toEqual([])
  })

  it('returns an empty Codex model list when both discovery protocols are unavailable', async () => {
    const runner = { run: vi.fn(async () => { throw new Error('unsupported models command') }) }
    const spawn = vi.fn(() => { throw new Error('codex app-server unavailable') }) as unknown as ConstructorParameters<typeof CodexAdapter>[1]
    const adapter = new CodexAdapter(runner, spawn)

    await expect(adapter.listModels()).resolves.toEqual([])
  })

  it.each([
    ['claude', ClaudeAdapter],
    ['codex', CodexAdapter],
    ['cursor', CursorAdapter],
  ] as const)('passes an optional selected model to %s when provided', async (_id, Adapter) => {
    const calls: SpawnCall[] = []
    const runner = { run: vi.fn(async () => ({ stdout: `${_id} CLI 1.2.3` })) }
    const adapter = new Adapter(runner, fakeSpawn('{"not":"a walkthrough"}', calls))

    await adapter.analyze({ ...requestFor(_id), model: 'runtime-selected-model' }, '/worktree', '/input', undefined, progress)

    const modelIndex = calls[0].args.indexOf('--model')
    expect(modelIndex).toBeGreaterThanOrEqual(0)
    expect(calls[0].args[modelIndex + 1]).toBe('runtime-selected-model')
  })

  it('uses Claude plan mode, an allow-list, and structured output without write-capable tools', async () => {
    const calls: SpawnCall[] = []
    const runner = { run: vi.fn(async () => ({ stdout: 'Claude Code 1.2.3' })) }
    const adapter = new ClaudeAdapter(runner, fakeSpawn('{"not":"a walkthrough"}', calls))

    const response = await adapter.analyze(requestFor('claude'), '/worktree', '/input', undefined, progress)
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('claude')
    expect(calls[0].options).toMatchObject({ cwd: '/worktree', stdio: 'pipe', windowsHide: true })
    expect(calls[0].args[0]).toBe('-p')
    expect(calls[0].args[1]).toContain('acme/atlas#42')
    expect(calls[0].args.slice(2)).toEqual([
      '--safe-mode',
      '--permission-mode', 'plan',
      '--allowed-tools', 'Read', 'Grep', 'Glob',
      '--add-dir', '/input',
      '--no-session-persistence',
      '--output-format', 'json',
      '--json-schema', expect.any(String),
    ])
    expect(calls[0].args.join(' ')).not.toMatch(/(?:--dangerously|--force|--yolo|\bBash\b|\bEdit\b|\bWrite\b)/i)
  })

  it('starts Codex with JSON events, an ephemeral read-only sandbox, and no dangerous bypass', async () => {
    const calls: SpawnCall[] = []
    const runner = { run: vi.fn(async () => ({ stdout: 'codex-cli 1.2.3' })) }
    const adapter = new CodexAdapter(runner, fakeSpawn('{"not":"a walkthrough"}', calls))

    const response = await adapter.analyze(requestFor('codex'), '/worktree', '/input', undefined, progress)
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('codex')
    expect(calls[0].options).toMatchObject({ cwd: '/worktree', stdio: 'pipe', windowsHide: true })
    expect(calls[0].args.slice(0, 7)).toEqual([
      'exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    ])
    expect(calls[0].args[7]).toBe('--output-schema')
    expect(calls[0].args[8]).toMatch(/\/pr-atlas-schema-[^/]+\/[^/]+\.json$/)
    expect(calls[0].args[9]).toContain('acme/atlas#42')
    expect(calls[0].args[9]).toContain('/input')
    expect(calls[0].args).toHaveLength(10)
    expect(calls[0].stdinEnd).toHaveBeenCalledTimes(1)
    expect(calls[0].args.join(' ')).not.toMatch(/(?:dangerously-bypass|workspace-write|danger-full-access|--add-dir)/i)
  })

  it('starts Cursor Agent in ask mode with sandboxing and the worktree/input roots', async () => {
    const calls: SpawnCall[] = []
    const runner = { run: vi.fn(async () => ({ stdout: 'cursor-agent 1.2.3' })) }
    const adapter = new CursorAdapter(runner, fakeSpawn('{"not":"a walkthrough"}', calls))

    const response = await adapter.analyze(requestFor('cursor'), '/worktree', '/input', undefined, progress)
    expect(response.rawOutput).toBe('{"not":"a walkthrough"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('cursor-agent')
    expect(calls[0].options).toMatchObject({ cwd: '/worktree', stdio: 'pipe', windowsHide: true })
    expect(calls[0].args[0]).toBe('-p')
    expect(calls[0].args[1]).toContain('acme/atlas#42')
    expect(calls[0].args[1]).toContain('The exact JSON Schema follows')
    expect(calls[0].args[1]).toContain('"schemaVersion"')
    expect(calls[0].args.slice(2)).toEqual([
      '--output-format', 'json',
      '--mode', 'ask',
      '--sandbox', 'enabled',
      '--workspace', '/worktree',
      '--trust',
      '--add-dir', '/input',
    ])
    expect(calls[0].args.join(' ')).not.toMatch(/(?:--force|--yolo|--sandbox disabled)/i)
  })
})
