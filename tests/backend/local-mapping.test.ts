import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisService } from '../../electron/backend/service'

const capabilities = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false }

describe('local repository mapping', () => {
  it('validates the Git repository and GitHub origin, then persists the canonical path', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-mapping-`)
    const localPath = `${root}/checkout`
    try {
      const run = vi.fn()
        .mockResolvedValueOnce({ stdout: `${localPath}\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://token:secret@github.com/example/backend.git\n', stderr: '' })
      const service = new AnalysisService(root, { run })

      await expect(service.mapLocalRepository('example/backend', localPath)).resolves.toEqual({ repository: 'example/backend', path: localPath })
      const saved = JSON.parse(await readFile(`${root}/mappings/github.com/example/backend.json`, 'utf8'))
      expect(saved).toMatchObject({ repository: 'example/backend', path: localPath, remote: 'https://github.com/example/backend.git' })
      expect(JSON.stringify(saved)).not.toMatch(/token|secret/i)
      expect(run).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--show-toplevel'], expect.objectContaining({ cwd: localPath }))
      expect(run).toHaveBeenNthCalledWith(2, 'git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: localPath }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a local repository whose origin points at another GitHub repository', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-mapping-`)
    try {
      const run = vi.fn()
        .mockResolvedValueOnce({ stdout: '/tmp/checkout\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/example/other.git\n', stderr: '' })
      const service = new AnalysisService(root, { run })

      await expect(service.mapLocalRepository('example/backend', '/tmp/checkout')).rejects.toThrow(/origin|repository/i)
      await expect(readFile(`${root}/mappings/github.com/example/backend.json`, 'utf8')).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('seeds the managed clone from a mapping without running Git commands in the user checkout', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-mapping-`)
    const localPath = `${root}/user-checkout`
    const calls: Array<{ file: string; args: string[]; options?: { cwd?: string } }> = []
    try {
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        calls.push({ file, args, options })
        if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${localPath}\n`, stderr: '' }
        if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { stdout: 'https://github.com/example/backend.git\n', stderr: '' }
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const adapter = { id: 'claude' as const, displayName: 'Test provider', detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }), getCapabilities: () => capabilities, analyze: async () => ({ status: 'failed' as const, rawOutput: '', logs: [], errors: ['expected test failure'] }) }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])
      await service.mapLocalRepository('example/backend', localPath)
      const mappingCallCount = calls.length
      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })
      const preparationCalls = calls.slice(mappingCallCount)

      expect(result.status).toBe('failed')
      expect(preparationCalls.some(({ file, args }) => file === 'git' && args[0] === 'clone' && args.includes(localPath))).toBe(true)
      expect(preparationCalls.some(({ file, args, options }) => file === 'git' && args[0] === 'remote' && args[1] === 'set-url' && options?.cwd?.includes('/repositories/github.com/example/backend'))).toBe(true)
      expect(preparationCalls.some(({ file, args }) => file === 'gh' && args[0] === 'repo' && args[1] === 'clone')).toBe(false)
      expect(preparationCalls.some(({ options }) => options?.cwd === localPath)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
