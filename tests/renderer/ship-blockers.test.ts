import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import App from '../../src/App'
import { calculateFitZoom, mapWalkthroughDocument, matchesRelationshipFilter, WalkthroughRich } from '../../src/App'
import type { PullRequest } from '../../src/types'
import type { WalkthroughDocument } from '../../shared/contracts'

const basePr: PullRequest = {
  source: 'github', id: 'pr-1', number: 1, repositoryId: 'acme/repo', repositoryFullName: 'acme/repo',
  title: 'Fix evidence', author: 'octocat', initials: 'OC', branch: 'fix', base: 'main', baseSha: 'base', headSha: 'head',
  updated: 'now', additions: 1, deletions: 1, files: 1, status: 'ready', labels: [], summary: '', changedAreas: [],
  groups: [], insights: [], flows: [], tests: [], threads: [], evidence: [], history: [],
  authoredByViewer: true, reviewRequested: false, reviewedByViewer: true,
}

const graph = (id: 'system-overview' | 'data-flow' | 'code-dependency' | 'user-action') => ({
  id,
  description: `${id} description`,
  nodes: [{ id: `${id}-node`, label: 'Node', explanation: 'Node explanation', changed: id !== 'system-overview', changeGroupIds: id === 'system-overview' ? [] : ['group-1'], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: id === 'system-overview' ? [] : ['ev-1'] }],
  edges: id === 'system-overview' ? [] : [{ id: `${id}-edge`, source: `${id}-node`, target: `${id}-node`, label: 'loops', evidenceIds: ['ev-1'], changeGroupIds: ['group-1'], reviewThreadIds: [] }],
  guidedTours: [{ id: `${id}-tour`, title: 'Tour', steps: [{ nodeId: `${id}-node`, title: 'Inspect', explanation: 'Read it', evidenceIds: id === 'system-overview' ? [] : ['ev-1'] }] }],
})

const document: WalkthroughDocument = {
  schemaVersion: '1.1.0',
  run: { id: 'run-1', createdAt: '2026-08-05T00:00:00Z', provider: 'codex', model: 'codex', skillVersion: '1' },
  pullRequest: { host: 'github.com', repository: 'acme/repo', number: 1, baseSha: 'base', headSha: 'head' },
  summary: { intent: 'Trace exact evidence', behavioralChanges: [], architecturalImpact: [], limitations: [] },
  changeGroups: [{ id: 'group-1', title: 'Evidence', summary: 'Summary', motivation: 'Why', previousBehavior: 'Before', newBehavior: 'After', attention: 'high', evidenceIds: ['ev-1'] }],
  walkthrough: [{ id: 'step-1', title: 'Read evidence', reason: 'The evidence anchors the review.', summary: 'Inspect the linked source evidence.', limitations: [], dependsOnStepIds: [], changeGroupId: 'group-1', flowNodeIds: ['data-flow-node'], evidenceIds: ['ev-1'], testIds: ['test-1'], reviewInsightIds: [] }],
  graphs: { systemOverview: graph('system-overview'), dataFlow: graph('data-flow'), codeDependency: graph('code-dependency'), userAction: graph('user-action') },
  tests: [{ id: 'test-1', title: 'evidence test', behavior: 'opens evidence', status: 'covered', evidenceIds: ['ev-1'], changeGroupIds: ['group-1'] }],
  reviewThreads: [],
  reviewInsights: [],
  evidence: [{ id: 'ev-1', kind: 'file', title: 'App source', path: 'src/App.tsx', line: 42, url: 'https://github.com/acme/repo/blob/head/src/App.tsx#L42' }],
}

const richThreadDocument: WalkthroughDocument = {
  ...document,
  reviewThreads: [{
    id: 'thread-1', status: 'resolved', provenance: 'github', evidenceIds: ['ev-1'], author: 'octocat', body: 'Please preserve the exact source location.',
    replies: [{ id: 'reply-1', author: 'maintainer', body: 'Done; the renderer now keeps every reply.', authorAssociation: 'MEMBER', createdAt: '2026-08-05T00:01:00Z', updatedAt: '2026-08-05T00:01:00Z', url: 'https://github.com/acme/repo/pull/1#discussion_r2', path: 'src/App.tsx', line: 43, originalLine: 43, side: 'RIGHT', commitSha: 'head', originalCommitSha: 'base' }],
    replyCount: 1, url: 'https://github.com/acme/repo/pull/1#discussion_r1', resolvedBy: 'maintainer', authorAssociation: 'CONTRIBUTOR', path: 'src/App.tsx', line: 42, originalLine: 41, side: 'RIGHT', startLine: null, originalStartLine: null, commitSha: 'head', originalCommitSha: 'base', createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:02:00Z', changeGroupIds: ['group-1'], graphNodeIds: ['data-flow-node'], reviewInsightIds: [],
  }],
}

describe('ship-blocker renderer contracts', () => {
  it('fits graph content to the viewport instead of aliasing reset', () => {
    expect(calculateFitZoom(700, 450)).toBe(80)
    expect(calculateFitZoom(700, 700)).toBe(51)
    expect(calculateFitZoom(700, 1_100)).toBe(32)
  })

  it('searches repositories by owner and name', async () => {
    const user = userEvent.setup()
    render(createElement(App))
    await user.type(screen.getByRole('searchbox', { name: /search repositories/i }), 'harbor')
    await user.click(screen.getByRole('button', { name: /select repository/i }))
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('runway/harbor')
    expect(options).not.toContain('runway/orbit-cli')
  })

  it('uses GitHub relationship facts instead of generated walkthrough state', () => {
    expect(matchesRelationshipFilter(basePr, 'mine')).toBe(true)
    expect(matchesRelationshipFilter(basePr, 'review')).toBe(false)
    expect(matchesRelationshipFilter(basePr, 'reviewed')).toBe(true)
    expect(matchesRelationshipFilter({ ...basePr, authoredByViewer: false, reviewRequested: true, reviewedByViewer: false }, 'review')).toBe(true)
  })

  it('resolves evidence IDs to exact paths and does not fabricate absent review threads', () => {
    const mapped = mapWalkthroughDocument(document, basePr, 'codex')
    expect(mapped.evidence).toContainEqual(expect.objectContaining({ id: 'ev-1', path: 'src/App.tsx', line: 42 }))
    expect(mapped.tests[0].evidence).toBe('src/App.tsx:42')
    expect(mapped.threads).toEqual([])
  })

  it('maps rich review-thread metadata and preserves every reply', () => {
    const mapped = mapWalkthroughDocument(richThreadDocument, basePr, 'codex')
    expect(mapped.threads).toHaveLength(1)
    expect(mapped.threads[0]).toEqual(expect.objectContaining({
      author: 'octocat', body: 'Please preserve the exact source location.', file: 'src/App.tsx', line: 42,
      authorAssociation: 'CONTRIBUTOR', url: 'https://github.com/acme/repo/pull/1#discussion_r1', resolvedBy: 'maintainer',
      commitSha: 'head', originalCommitSha: 'base', createdAt: '2026-08-05T00:00:00Z',
      replies: [expect.objectContaining({ author: 'maintainer', body: 'Done; the renderer now keeps every reply.', authorAssociation: 'MEMBER', path: 'src/App.tsx', line: 43, originalLine: 43, side: 'RIGHT', createdAt: '2026-08-05T00:01:00Z', updatedAt: '2026-08-05T00:01:00Z', commitSha: 'head', originalCommitSha: 'base', url: 'https://github.com/acme/repo/pull/1#discussion_r2' })],
      replyCount: 1,
    }))
  })

  it('shows coordinator context only for the active walkthrough change group', async () => {
    const user = userEvent.setup()
    const coordinatorDocument = {
      ...document,
      changeGroups: [...document.changeGroups, { ...document.changeGroups[0], id: 'group-2', title: 'Second group' }],
      walkthrough: [...document.walkthrough, { ...document.walkthrough[0], id: 'step-2', title: 'Review second group', changeGroupId: 'group-2', dependsOnStepIds: ['step-1'] }],
      risks: [
        { id: 'risk-1', title: 'Clean CI ordering', detail: 'Tests must not depend on build output.', changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'risk-2', title: 'Second-group risk', detail: 'Only the second step should show this.', changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
      dependencies: [
        { id: 'dependency-1', title: 'Bridge packaging', detail: 'The provider bootstrap needs the emitted bridge.', dependsOnIds: ['step-1'], changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'dependency-2', title: 'Second-group dependency', detail: 'Only the second step should show this.', dependsOnIds: ['step-1'], changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
      unchangedInteractions: [
        { id: 'unchanged-1', title: 'Existing workflow order', detail: 'The quality workflow still runs tests before build.', changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'unchanged-2', title: 'Second-group context', detail: 'Only the second step should show this.', changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
    } as WalkthroughDocument
    const mapped = mapWalkthroughDocument(coordinatorDocument, basePr, 'codex')

    render(createElement(WalkthroughRich, {
      pr: mapped,
      markGroup: () => undefined,
      reviewed: {},
      progress: {},
      updateProgress: () => undefined,
      openEvidence: () => undefined,
      openFlow: () => undefined,
    }))

    expect(screen.getByText('Clean CI ordering')).toBeInTheDocument()
    expect(screen.getByText('Bridge packaging')).toBeInTheDocument()
    expect(screen.getByText('Existing workflow order')).toBeInTheDocument()
    expect(screen.queryByText('Second-group risk')).not.toBeInTheDocument()
    expect(screen.queryByText('Second-group dependency')).not.toBeInTheDocument()
    expect(screen.queryByText('Second-group context')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Step 2: Review second group' }))

    expect(screen.getByText('Second-group risk')).toBeInTheDocument()
    expect(screen.getByText('Second-group dependency')).toBeInTheDocument()
    expect(screen.getByText('Second-group context')).toBeInTheDocument()
    expect(screen.queryByText('Clean CI ordering')).not.toBeInTheDocument()
    expect(screen.queryByText('Bridge packaging')).not.toBeInTheDocument()
    expect(screen.queryByText('Existing workflow order')).not.toBeInTheDocument()
  })
})
