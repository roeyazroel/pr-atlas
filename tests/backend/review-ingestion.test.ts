import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { GithubClient } from '../../electron/backend/github'

describe('GitHub review ingestion', () => {
  it('retrieves paginated review threads with deterministic resolution and source fields intact', async () => {
    const raw = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: 'PRRT_kwDO-thread-1',
                isResolved: false,
                isOutdated: true,
                resolvedBy: null,
                comments: {
                  nodes: [{
                    id: 'PRRC_kwDO-comment-1',
                    body: 'I disagree with this approach.',
                    author: { login: 'review-bot' },
                    authorAssociation: 'NONE',
                    url: 'https://github.com/example/backend/pull/42#discussion_r1',
                  }],
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([raw]), stderr: '' })
    const client = new GithubClient({ run })

    await expect(client.fetchReviewThreads('example/backend', 42)).resolves.toEqual([raw])
    expect(run).toHaveBeenCalledTimes(1)
    const [file, args] = run.mock.calls[0] as [string, string[]]
    expect(file).toBe('gh')
    expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--paginate', '--slurp'])
    const query = args.find((arg) => arg.startsWith('query='))
    expect(query).toContain('reviewThreads')
    expect(query).toContain('isResolved')
    expect(query).toContain('isOutdated')
    expect(query).toContain('resolvedBy')
    expect(query).toContain('comments')
    expect(query).toContain('body')
  })

  it('paginates nested comments so replies beyond the first page remain in the raw thread input', async () => {
    const firstPage = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [{
      id: 'PRRT_kwDO-thread-2', isResolved: false, isOutdated: false, path: 'src/App.tsx', line: 20,
      comments: { nodes: [{ id: 'comment-1', body: 'Original concern', url: 'https://github.com/example/backend/pull/42#discussion_r1' }], pageInfo: { hasNextPage: true, endCursor: 'comments-cursor-1' } },
    }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
    const secondPage = [{ data: { node: { comments: { nodes: [{
      id: 'comment-2', body: 'I disagree with the proposed resolution.', author: { login: 'reviewer' }, authorAssociation: 'MEMBER', url: 'https://github.com/example/backend/pull/42#discussion_r2', replyTo: { id: 'comment-1' },
    }], pageInfo: { hasNextPage: false, endCursor: null } } } } }]
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(firstPage), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(secondPage), stderr: '' })
    const client = new GithubClient({ run })

    const result = await client.fetchReviewThreads('example/backend', 42)
    const thread = (((result as unknown[])[0] as Record<string, unknown>).data as Record<string, unknown>)
      .repository as Record<string, unknown>
    const reviewThreads = ((thread.pullRequest as Record<string, unknown>).reviewThreads as Record<string, unknown>)
    const comments = (((reviewThreads.nodes as unknown[])[0] as Record<string, unknown>).comments as Record<string, unknown>)
    expect(comments.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'comment-1' }),
      expect.objectContaining({ id: 'comment-2', body: 'I disagree with the proposed resolution.' }),
    ]))
    expect(run).toHaveBeenCalledTimes(2)
    const nestedQuery = (run.mock.calls[1] as [string, string[]])[1].find((arg) => arg.startsWith('query='))
    expect(nestedQuery).toContain('node(id:$threadId)')
    expect(nestedQuery).toContain('comments')
    expect(nestedQuery).toContain('after:$endCursor')
  })

  it('writes the raw no-thread GraphQL response as provider input rather than inventing active review data', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-review-`)
    try {
      const noThreads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
      const run = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
        if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { await mkdir(args[3], { recursive: true }); return { stdout: '', stderr: '' } }
        if (file === 'git' && args[0] === 'rev-parse') return { stdout: args[1] === '--show-toplevel' ? options?.cwd ?? '' : options?.cwd?.split(/[\\/]/).at(-1) ?? '', stderr: '' }
        if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' }
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(noThreads), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        if (file === 'gh') return { stdout: '', stderr: '' }
        return { stdout: '', stderr: '' }
      })

      // Exercise the service boundary so the provider receives the raw
      // GraphQL response, including an explicit empty thread collection.
      const { AnalysisService } = await import('../../electron/backend/service')
      const adapter = {
        id: 'claude' as const,
        displayName: 'Test provider',
        detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities: { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false } }),
        getCapabilities: () => ({ structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false }),
        analyze: async () => ({ status: 'failed' as const, rawOutput: '', logs: [], errors: ['expected test failure'] }),
      }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])
      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })
      const saved = JSON.parse(await readFile(`${result.artifactDirectory}/input/review-threads.json`, 'utf8'))
      expect(saved).toEqual(noThreads)
      expect(saved[0].data.repository.pullRequest.reviewThreads.nodes).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('derives pull-request relationship flags from the authenticated GitHub viewer and review records', async () => {
    const pullRequest = {
      id: 'PR_42', number: 42, title: 'Keep review context', url: 'https://github.com/example/backend/pull/42',
      author: { login: 'viewer' }, baseRefName: 'main', headRefName: 'feature/reviews', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40),
      updatedAt: '2026-08-05T00:00:00Z', state: 'OPEN', isDraft: false, additions: 1, deletions: 0, changedFiles: 1,
      labels: [], reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'viewer' }],
    }
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'viewer', name: 'Viewer' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest]), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([[{ user: { login: 'viewer' }, state: 'COMMENTED' }]]), stderr: '' })
    const client = new GithubClient({ run })

    await client.bootstrap()
    await expect(client.listPullRequests('example/backend')).resolves.toMatchObject([{
      author: 'viewer', authoredByViewer: true, reviewRequested: true, reviewedByViewer: true,
    }])
    expect(run).toHaveBeenLastCalledWith('gh', ['api', '--paginate', '--slurp', 'repos/example/backend/pulls/42/reviews?per_page=100'], expect.objectContaining({ timeout: 30_000 }))
  })
})
