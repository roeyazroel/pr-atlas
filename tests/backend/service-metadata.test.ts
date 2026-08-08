import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisService } from '../../electron/backend/service'
import { SKILL_CONTRACT_VERSION } from '../../electron/backend/agent'

const capabilities = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: true, authenticationState: false }

async function managedWorktreeCommand(file: string, args: string[], options?: { cwd?: string }) {
  if (file !== 'git') return null
  if (args[0] === 'worktree' && args[1] === 'add') { await mkdir(args[3], { recursive: true }); return { stdout: '', stderr: '' } }
  if (args[0] === 'rev-parse') return { stdout: args[1] === '--show-toplevel' ? options?.cwd ?? '' : options?.cwd?.split(/[\\/]/).at(-1) ?? '', stderr: '' }
  if (args[0] === 'status') return { stdout: '', stderr: '' }
  return null
}

function providerDocument() {
  const graph = (id: string) => ({
    id,
    description: `Review ${id}.`,
    nodes: [{
      id: `${id}-node`,
      label: 'Relevant node',
      explanation: 'A relevant node.',
      changed: id !== 'system-overview',
      changeGroupIds: id === 'system-overview' ? [] : ['group-1'],
      testIds: [],
      reviewThreadIds: [],
      reviewInsightIds: [],
      evidenceIds: id === 'system-overview' ? [] : ['evidence-1'],
    }],
    edges: id === 'system-overview' ? [] : [{
      id: `${id}-edge`,
      source: `${id}-node`,
      target: `${id}-node`,
      label: 'continues',
      evidenceIds: ['evidence-1'],
      changeGroupIds: ['group-1'],
      reviewThreadIds: [],
    }],
    guidedTours: [{
      id: `${id}-tour`,
      title: 'Review this graph',
      steps: [{
        nodeId: `${id}-node`,
        title: 'Inspect node',
        explanation: 'Verify exact evidence.',
      }],
    }],
  })
  return {
    schemaVersion: '1.1.0',
    run: { id: 'provider-run-id', createdAt: 'provider-created-at', provider: 'provider-invented', model: 'provider-document-model', skillVersion: 'provider-skill-version' },
    pullRequest: { host: 'github.com', repository: 'example/backend', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    summary: { intent: 'intent', behavioralChanges: [], architecturalImpact: [], limitations: [] },
    changeGroups: [{ id: 'group-1', title: 'Trace evidence', summary: 'Connects behavior to code.', motivation: 'Reviewers need exact evidence.', previousBehavior: 'Evidence was implicit.', newBehavior: 'Evidence is linked.', attention: 'medium', evidenceIds: ['evidence-1'] }],
    walkthrough: [{ id: 'step-1', title: 'Inspect evidence', reason: 'It anchors the review in source evidence.', summary: 'Inspect the changed input.', limitations: [], dependsOnStepIds: [], changeGroupId: 'group-1', flowNodeIds: ['data-flow-node'], evidenceIds: ['evidence-1'], testIds: [], reviewInsightIds: [] }],
    graphs: { systemOverview: graph('system-overview'), dataFlow: graph('data-flow'), codeDependency: graph('code-dependency'), userAction: graph('user-action') },
    tests: [], reviewThreads: [], reviewInsights: [], evidence: [{ id: 'evidence-1', kind: 'file', title: 'Input diff', path: 'diff.patch', line: null, url: null }],
  }
}

function legacyProviderDocument() {
  const document = providerDocument() as Record<string, unknown>
  document.schemaVersion = '1.0.0'
  for (const step of document.walkthrough as Array<Record<string, unknown>>) {
    delete step.reason
    delete step.summary
    delete step.limitations
    delete step.dependsOnStepIds
    delete step.flowNodeIds
    delete step.testIds
    delete step.reviewInsightIds
  }
  return document
}

describe('analysis service reproducibility metadata', () => {
  it('rejects a provider-returned 1.0 walkthrough for a fresh run', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-service-schema-version-`)
    try {
      const legacy = legacyProviderDocument()
      const noThreads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        const managed = await managedWorktreeCommand(file, args, options); if (managed) return managed
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(noThreads), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = {
        id: 'claude' as const,
        displayName: 'Test provider',
        detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }),
        getCapabilities: () => capabilities,
        analyze: async () => ({ status: 'ready' as const, rawOutput: '', logs: [], document: legacy as never }),
      }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })

      expect(result).toMatchObject({ status: 'invalid', error: { code: 'INVALID_WALKTHROUGH' } })
      expect(result.document).toBeUndefined()
      expect(JSON.parse(await readFile(`${result.artifactDirectory}/manifest.json`, 'utf8'))).toMatchObject({ status: 'invalid', error: { code: 'INVALID_WALKTHROUGH' } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('redacts provider-controlled validation errors before returning or persisting them', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-service-errors-`)
    const originalApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'service-secret-value'
    try {
      const noThreads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        const managed = await managedWorktreeCommand(file, args, options); if (managed) return managed
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(noThreads), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = {
        id: 'claude' as const,
        displayName: 'Test provider',
        detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }),
        getCapabilities: () => capabilities,
        analyze: async () => ({
          status: 'invalid' as const,
          rawOutput: '',
          logs: [],
          errors: ["unknown id 'service-secret-value' from https://proxy-user:proxy-pass@proxy.example.test/path"],
        }),
      }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })
      const persistedManifest = await readFile(`${result.artifactDirectory}/manifest.json`, 'utf8')
      const serializedResult = JSON.stringify(result)

      for (const output of [serializedResult, persistedManifest]) {
        expect(output).not.toContain('service-secret-value')
        expect(output).not.toContain('proxy-user')
        expect(output).not.toContain('proxy-pass')
        expect(output).toContain('[REDACTED]')
      }
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
      await rm(root, { recursive: true, force: true })
    }
  })

  it('overwrites provider-owned run metadata on the returned and persisted ready document', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-service-metadata-`)
    try {
      const selectedModel = 'selected-model'
      const noThreads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        const managed = await managedWorktreeCommand(file, args, options); if (managed) return managed
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(noThreads), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = {
        id: 'claude' as const,
        displayName: 'Test provider',
        detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }),
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: selectedModel, label: selectedModel }],
        analyze: async () => ({ status: 'ready' as const, rawOutput: '', logs: [], model: 'provider-response-model', document: providerDocument() as never }),
      }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude', model: selectedModel })

      expect(result.status).toBe('ready')
      expect(result.document?.run).toMatchObject({
        id: result.runId,
        createdAt: result.manifest.createdAt,
        provider: 'claude',
        model: selectedModel,
        skillVersion: SKILL_CONTRACT_VERSION,
      })
      expect(result.document?.run).not.toMatchObject({ id: 'provider-run-id', createdAt: 'provider-created-at', provider: 'provider-invented', skillVersion: 'provider-skill-version' })
      expect(result.manifest).toMatchObject({ runId: result.runId, provider: 'claude', model: selectedModel, skillContractVersion: SKILL_CONTRACT_VERSION })

      const persistedDocument = JSON.parse(await readFile(`${result.artifactDirectory}/walkthrough.json`, 'utf8'))
      const persistedManifest = JSON.parse(await readFile(`${result.artifactDirectory}/manifest.json`, 'utf8'))
      expect(persistedDocument.run).toEqual(result.document?.run)
      expect(persistedManifest).toMatchObject({ runId: result.runId, createdAt: result.manifest.createdAt, provider: 'claude', model: selectedModel, skillContractVersion: SKILL_CONTRACT_VERSION })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a nonempty provider-reported document model when no model was selected', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-service-metadata-fallback-`)
    try {
      const noThreads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        const managed = await managedWorktreeCommand(file, args, options); if (managed) return managed
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(noThreads), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = {
        id: 'claude' as const,
        displayName: 'Test provider',
        detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }),
        getCapabilities: () => capabilities,
        analyze: async () => ({ status: 'ready' as const, rawOutput: '', logs: [], document: providerDocument() as never }),
      }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })

      expect(result.status).toBe('ready')
      expect(result.document?.run.model).toBe('provider-document-model')
      expect(result.manifest.model).toBe('provider-document-model')
      const persistedManifest = JSON.parse(await readFile(`${result.artifactDirectory}/manifest.json`, 'utf8'))
      expect(persistedManifest.model).toBe('provider-document-model')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
