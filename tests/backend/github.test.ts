import { describe, expect, it, vi } from 'vitest'
import { GithubClient, sanitizeGhError } from '../../electron/backend/github'

describe('GitHub CLI backend', () => {
  it('maps status and pull-list operations to fixed gh argv through an injected runner', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'reviewer', name: 'Reviewer' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]), stderr: '' })
    const client = new GithubClient({ run })

    await client.bootstrap()
    await client.listPullRequests('example/backend')

    expect(run).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'status', '--hostname', 'github.com', '--active'], expect.objectContaining({ timeout: 5_000 }))
    expect(run).toHaveBeenNthCalledWith(2, 'gh', ['api', 'user'], expect.objectContaining({ timeout: 10_000 }))
    expect(run).toHaveBeenNthCalledWith(3, 'gh', ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100'], expect.objectContaining({ timeout: 30_000 }))
    expect(run).toHaveBeenNthCalledWith(4, 'gh', ['pr', 'list', '--repo', 'example/backend', '--state', 'open', '--limit', '100', '--json', 'id,number,title,url,author,baseRefName,headRefName,baseRefOid,headRefOid,updatedAt,state,isDraft,additions,deletions,changedFiles,labels,reviewDecision,reviewRequests'], expect.objectContaining({ timeout: 30_000 }))
  })

  it('maps review and change metadata and requests the exact supported gh JSON fields', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: 'PR_482', number: 482, title: 'Add session ownership', url: 'https://github.com/example/backend/pull/482',
          author: { login: 'developer' }, baseRefName: 'main', headRefName: 'feature/session', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40),
          updatedAt: '2026-08-04T20:00:00Z', state: 'OPEN', isDraft: true, additions: 42, deletions: 7, changedFiles: 5,
          labels: [{ name: 'security' }, { name: 'agent-generated' }], reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'reviewer' }],
        },
        {
          id: 'PR_481', number: 481, title: 'Refresh documentation', url: 'https://github.com/example/backend/pull/481',
          author: { login: 'maintainer' }, baseRefName: 'main', headRefName: 'docs/refresh', baseRefOid: 'c'.repeat(40), headRefOid: 'd'.repeat(40),
          updatedAt: '2026-08-03T20:00:00Z', state: 'OPEN', isDraft: false, additions: 4, deletions: 1, changedFiles: 1,
          labels: [], reviewDecision: null, reviewRequests: [],
        },
      ]),
      stderr: '',
    })
    const client = new GithubClient({ run })

    const pullRequests = await client.listPullRequests('example/backend')

    expect(pullRequests).toHaveLength(2)
    expect(pullRequests[0]).toMatchObject({
      id: 'PR_482', number: 482, isDraft: true, additions: 42, deletions: 7, changedFiles: 5,
      labels: ['agent-generated', 'security'], reviewDecision: 'REVIEW_REQUIRED', reviewRequested: false,
    })
    expect(pullRequests[1]).toMatchObject({
      id: 'PR_481', number: 481, isDraft: false, additions: 4, deletions: 1, changedFiles: 1,
      labels: [], reviewDecision: null, reviewRequested: false,
    })
    expect(run).toHaveBeenCalledWith('gh', [
      'pr', 'list', '--repo', 'example/backend', '--state', 'open', '--limit', '100', '--json',
      'id,number,title,url,author,baseRefName,headRefName,baseRefOid,headRefOid,updatedAt,state,isDraft,additions,deletions,changedFiles,labels,reviewDecision,reviewRequests',
    ], expect.objectContaining({ timeout: 30_000 }))
  })

  it('marks review requested only for the viewer direct user or a team the viewer belongs to', async () => {
    const pullRequests = [
      { id: 'PR_direct', number: 1, title: 'Direct', url: 'https://github.com/example/backend/pull/1', author: { login: 'other' }, baseRefName: 'main', headRefName: 'direct', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40), updatedAt: '2026-08-05T03:00:00Z', state: 'OPEN', isDraft: false, additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewDecision: null, reviewRequests: [{ login: 'viewer', type: 'User' }] },
      { id: 'PR_team', number: 2, title: 'Team', url: 'https://github.com/example/backend/pull/2', author: { login: 'other' }, baseRefName: 'main', headRefName: 'team', baseRefOid: 'c'.repeat(40), headRefOid: 'd'.repeat(40), updatedAt: '2026-08-05T02:00:00Z', state: 'OPEN', isDraft: false, additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewDecision: null, reviewRequests: [{ login: 'platform-reviewers', type: 'Team', slug: 'platform-reviewers', organization: { login: 'example' } }] },
      { id: 'PR_other', number: 3, title: 'Other', url: 'https://github.com/example/backend/pull/3', author: { login: 'other' }, baseRefName: 'main', headRefName: 'other', baseRefOid: 'e'.repeat(40), headRefOid: 'f'.repeat(40), updatedAt: '2026-08-05T01:00:00Z', state: 'OPEN', isDraft: false, additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewDecision: null, reviewRequests: [{ login: 'someone-else', type: 'User' }] },
      { id: 'PR_other_team', number: 4, title: 'Other org team', url: 'https://github.com/example/backend/pull/4', author: { login: 'other' }, baseRefName: 'main', headRefName: 'other-org-team', baseRefOid: 'g'.repeat(40), headRefOid: 'h'.repeat(40), updatedAt: '2026-08-05T00:00:00Z', state: 'OPEN', isDraft: false, additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewDecision: null, reviewRequests: [{ login: 'platform-reviewers', type: 'Team', slug: 'platform-reviewers', organization: { login: 'different-org' } }] },
    ]
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'viewer', name: 'Viewer' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(pullRequests), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([[{ slug: 'platform-reviewers', name: 'Platform reviewers', organization: { login: 'example' } }]]), stderr: '' })
      .mockResolvedValue({ stdout: JSON.stringify([]), stderr: '' })
    const client = new GithubClient({ run })

    await client.bootstrap()
    await expect(client.listPullRequests('example/backend')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 1, reviewRequested: true }),
      expect.objectContaining({ number: 2, reviewRequested: true }),
      expect.objectContaining({ number: 3, reviewRequested: false }),
      expect.objectContaining({ number: 4, reviewRequested: false }),
    ]))
    expect(run).toHaveBeenCalledWith('gh', ['api', '--paginate', '--slurp', 'user/teams?per_page=100'], expect.objectContaining({ timeout: 30_000 }))
  })

  it('uses an injected runner and never shells out in the client itself', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'reviewer', name: 'Local Reviewer' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]), stderr: '' })
    const client = new GithubClient({ run })

    await expect(client.bootstrap()).resolves.toMatchObject({ account: { login: 'reviewer', name: 'Local Reviewer' } })
    expect(run).toHaveBeenCalledWith('gh', ['api', 'user'], expect.any(Object))
  })

  it('falls back to a deterministic safe result when the runner fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('gh: auth failed token=super-secret'))
    const client = new GithubClient({ run })

    await expect(client.bootstrap()).resolves.toMatchObject({ account: null, repositories: [], warnings: [expect.stringMatching(/not authenticated/i)] })
  })

  it('sanitizes command errors before exposing them to renderer diagnostics', () => {
    const safe = sanitizeGhError(new Error('gh: API failed with token=super-secret\\nAuthorization: Bearer abc123'))

    expect(safe).not.toContain('super-secret')
    expect(safe).not.toContain('abc123')
    expect(safe).toMatch(/github|cli|request|authentication|failed/i)
  })
})
