import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisService } from '../../electron/backend/service'
import { validateReviewCoverage } from '../../electron/backend/review-coverage'

const capabilities = { structuredOutput: true, streaming: false, sessionContinuation: false, readOnly: true, toolAllowlist: false, modelSelection: false, authenticationState: false }

function rawReviewThreads() {
  return [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [{
    id: 'PRRT_kwDO-coverage-1',
    isResolved: false,
    isOutdated: true,
    resolvedBy: { login: 'maintainer' },
    path: 'src/review.ts',
    line: 42,
    originalLine: 40,
    startLine: 41,
    originalStartLine: 39,
    diffSide: 'RIGHT',
    startDiffSide: 'RIGHT',
    comments: { nodes: [
      {
        id: 'PRRC_kwDO-original',
        body: 'PRIVATE REVIEW COMMENT SHOULD NOT LEAK',
        author: { login: 'reviewer' },
        authorAssociation: 'CONTRIBUTOR',
        createdAt: '2026-08-05T08:00:00Z',
        updatedAt: '2026-08-05T08:05:00Z',
        url: 'https://github.com/example/backend/pull/42#discussion_r1',
        path: 'src/review.ts',
        line: 42,
        originalLine: 40,
        commit: { oid: 'head-sha' },
        originalCommit: { oid: 'base-sha' },
      },
      {
        id: 'PRRC_kwDO-reply-1',
        body: 'PRIVATE REPLY SHOULD NOT LEAK',
        author: { login: 'maintainer' },
        authorAssociation: 'MEMBER',
        createdAt: '2026-08-05T08:10:00Z',
        updatedAt: '2026-08-05T08:11:00Z',
        url: 'https://github.com/example/backend/pull/42#discussion_r2',
        path: 'src/review.ts',
        line: 43,
        originalLine: 41,
        commit: { oid: 'head-sha' },
        originalCommit: { oid: 'base-sha' },
        replyTo: { id: 'PRRC_kwDO-original' },
      },
    ] },
  }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]
}

function canonicalCoverageThread(): Record<string, unknown> {
  return {
    id: 'PRRT_kwDO-coverage-1',
    status: 'outdated',
    provenance: 'human',
    evidenceIds: [],
    author: 'reviewer',
    body: 'PRIVATE REVIEW COMMENT SHOULD NOT LEAK',
    replies: [{
      id: 'PRRC_kwDO-reply-1',
      author: 'maintainer',
      body: 'PRIVATE REPLY SHOULD NOT LEAK',
      authorAssociation: 'MEMBER',
      createdAt: '2026-08-05T08:10:00Z',
      updatedAt: '2026-08-05T08:11:00Z',
      url: 'https://github.com/example/backend/pull/42#discussion_r2',
      path: 'src/review.ts',
      line: 43,
      originalLine: 41,
      side: 'RIGHT',
      commitSha: 'head-sha',
      originalCommitSha: 'base-sha',
    }],
    replyCount: 1,
    url: 'https://github.com/example/backend/pull/42#discussion_r1',
    resolvedBy: 'maintainer',
    authorAssociation: 'CONTRIBUTOR',
    path: 'src/review.ts',
    line: 42,
    originalLine: 40,
    side: 'RIGHT',
    startLine: 41,
    originalStartLine: 39,
    commitSha: 'head-sha',
    originalCommitSha: 'base-sha',
    createdAt: '2026-08-05T08:00:00Z',
    updatedAt: '2026-08-05T08:05:00Z',
    changeGroupIds: [],
    graphNodeIds: [],
    reviewInsightIds: [],
  }
}

function coverageDocument(reviewThreads: unknown[]): unknown {
  return {
    pullRequest: { repository: 'example/backend', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    reviewThreads,
  }
}

describe('review coverage gate', () => {
  it('requires every GitHub thread and every raw reply id while keeping errors text-free', () => {
    const result = validateReviewCoverage(rawReviewThreads(), coverageDocument([{ id: 'PRRT_kwDO-coverage-1', body: 'Summarized concern', replies: [], replyCount: 0 }]))

    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).not.toContain('PRIVATE REVIEW COMMENT SHOULD NOT LEAK')
    expect(result.errors.join(' ')).not.toContain('PRIVATE REPLY SHOULD NOT LEAK')
    expect(result.errors.join(' ')).toMatch(/reply|comment|coverage/i)
  })

  it('accepts complete coverage and preserves exact GitHub thread identifiers', () => {
    const result = validateReviewCoverage(rawReviewThreads(), coverageDocument([canonicalCoverageThread()]))

    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('represents a resolved-and-outdated GitHub thread as outdated without losing its resolver', () => {
    const raw = rawReviewThreads()
    const source = raw[0].data.repository.pullRequest.reviewThreads.nodes[0]
    source.isResolved = true
    source.isOutdated = true
    const thread = canonicalCoverageThread()

    expect(validateReviewCoverage(raw, coverageDocument([thread]))).toEqual({ valid: true, errors: [] })
    thread.status = 'resolved'
    expect(validateReviewCoverage(raw, coverageDocument([thread])).valid).toBe(false)
  })

  it.each([
    ['thread author', (thread: Record<string, unknown>) => { thread.author = 'attacker' }],
    ['thread body', (thread: Record<string, unknown>) => { thread.body = 'altered body' }],
    ['thread path', (thread: Record<string, unknown>) => { thread.path = 'src/other.ts' }],
    ['thread line', (thread: Record<string, unknown>) => { thread.line = 99 }],
    ['thread original line', (thread: Record<string, unknown>) => { thread.originalLine = 98 }],
    ['thread side', (thread: Record<string, unknown>) => { thread.side = 'LEFT' }],
    ['thread timestamp', (thread: Record<string, unknown>) => { thread.updatedAt = '2026-08-06T08:05:00Z' }],
    ['thread resolution or outdated state', (thread: Record<string, unknown>) => { thread.status = 'active' }],
  ])('rejects altered canonical %s', (_field, mutate) => {
    const thread = canonicalCoverageThread()
    mutate(thread)

    const result = validateReviewCoverage(rawReviewThreads(), coverageDocument([thread]))

    expect(result.valid).toBe(false)
  })

  it.each([
    ['reply author', (reply: Record<string, unknown>) => { reply.author = 'attacker' }],
    ['reply body', (reply: Record<string, unknown>) => { reply.body = 'altered reply' }],
    ['reply path', (reply: Record<string, unknown>) => { reply.path = 'src/other.ts' }],
    ['reply line', (reply: Record<string, unknown>) => { reply.line = 99 }],
    ['reply original line', (reply: Record<string, unknown>) => { reply.originalLine = 98 }],
    ['reply side', (reply: Record<string, unknown>) => { reply.side = 'LEFT' }],
    ['reply timestamp', (reply: Record<string, unknown>) => { reply.createdAt = '2026-08-06T08:10:00Z' }],
  ])('rejects altered canonical %s', (_field, mutate) => {
    const thread = canonicalCoverageThread()
    mutate((thread.replies as Array<Record<string, unknown>>)[0])

    const result = validateReviewCoverage(rawReviewThreads(), coverageDocument([thread]))

    expect(result.valid).toBe(false)
  })

  it('rejects coverage before a service run can become ready', async () => {
    const root = await mkdtemp(`${tmpdir()}/pr-atlas-review-coverage-`)
    try {
      const raw = rawReviewThreads()
      const run = vi.fn(async (file: string, args: string[]) => {
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify(raw), stderr: '' }
        if (file === 'gh' && args[0] === 'api') return { stdout: '[]', stderr: '' }
        return { stdout: '', stderr: '' }
      })
      const analyze = vi.fn(async () => ({
        status: 'ready' as const,
        rawOutput: '',
        logs: [],
        document: coverageDocument([{ id: 'PRRT_kwDO-coverage-1', body: 'Summarized concern', replies: [], replyCount: 0 }]) as never,
      }))
      const adapter = { id: 'claude' as const, displayName: 'Test provider', detect: async () => ({ provider: 'claude' as const, displayName: 'Test provider', executable: 'test', installed: true, capabilities }), getCapabilities: () => capabilities, analyze }
      const service = new AnalysisService(root, { run }, undefined, undefined, [adapter])

      const result = await service.startAnalysis({ repository: 'example/backend', pullNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude' })

      expect(result.status).toBe('invalid')
      expect(result.error).toMatchObject({ code: 'INVALID_WALKTHROUGH', message: expect.stringMatching(/walkthrough|review/i) })
      expect(JSON.stringify(result)).not.toContain('PRIVATE REVIEW COMMENT SHOULD NOT LEAK')
      expect(analyze).toHaveBeenCalledOnce()
      const manifest = JSON.parse(await readFile(`${result.artifactDirectory}/manifest.json`, 'utf8'))
      expect(manifest.status).toBe('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
