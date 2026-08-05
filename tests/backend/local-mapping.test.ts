import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisService } from '../../electron/backend/service'

const capabilities = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false }

const sourceFiles = [
  'electron/backend/service.ts',
  'electron/main.ts',
  'electron/preload.ts',
  'shared/contracts.ts',
  'src/App.tsx',
]

describe('removed local repository mapping', () => {
  it('has no renderer, IPC, contract, or analysis-service mapping path', async () => {
    for (const file of sourceFiles) {
      const source = await readFile(file, 'utf8')
      expect(source, file).not.toMatch(/mapLocalRepository|map-local-repository|Map existing checkout/)
    }
  })

  it('does not keep the obsolete mapping persistence module', async () => {
    await expect(readFile('electron/backend/mappings.ts', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prepares fresh analyses with a GitHub clone and an application-managed worktree', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-managed-clone-`)
    const calls: Array<{ file: string; args: string[]; options?: { cwd?: string } }> = []
    const headSha = 'b'.repeat(40)
    try {
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        calls.push({ file, args, options })
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = { id: 'claude' as const, displayName: 'Test provider', detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }), getCapabilities: () => capabilities, analyze: async () => ({ status: 'failed' as const, rawOutput: '', logs: [], errors: ['expected test failure'] }) }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha, provider: 'claude' })
      const clone = resolve(root, 'repositories/github.com/example/backend')
      const worktree = resolve(root, 'worktrees/github.com/example/backend', headSha)

      expect(result.status).toBe('failed')
      expect(calls).toContainEqual(expect.objectContaining({ file: 'gh', args: ['repo', 'clone', 'example/backend', clone] }))
      expect(calls).toContainEqual(expect.objectContaining({ file: 'git', args: ['fetch', '--no-tags', 'origin', 'pull/42/head:refs/pr-atlas/42'], options: expect.objectContaining({ cwd: clone }) }))
      expect(calls).toContainEqual(expect.objectContaining({ file: 'git', args: ['worktree', 'add', '--detach', worktree, headSha], options: expect.objectContaining({ cwd: clone }) }))
      expect(calls.some(({ file, args }) => file === 'git' && args[0] === 'clone')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
