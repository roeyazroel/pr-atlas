import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import App from '../../src/App'
import { calculateFitZoom, FlowsView, mapReviewDocument, matchesRelationshipFilter, OverviewFull, ReviewView } from '../../src/App'
import type { PullRequest } from '../../src/types'
import type { ReviewDocument } from '../../shared/contracts'

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

const document: ReviewDocument = {
  schemaVersion: '2.0.0',
  run: { id: 'run-1', createdAt: '2026-08-05T00:00:00Z', provider: 'codex', model: 'codex', skillVersion: '1' },
  pullRequest: { host: 'github.com', repository: 'acme/repo', number: 1, baseSha: 'base', headSha: 'head' },
  summary: { intent: 'Trace exact evidence', behavioralChanges: [], architecturalImpact: [], limitations: [] },
  changeGroups: [{ id: 'group-1', title: 'Evidence', summary: 'Summary', motivation: 'Why', previousBehavior: 'Before', newBehavior: 'After', attention: 'high', evidenceIds: ['ev-1'] }],
  stories: [{ id: 'story-1', title: 'Read evidence', summary: 'Inspect the linked source evidence.', relationshipToPrimary: 'primary', relationshipRationale: 'Central behavior.', reviewReason: 'The evidence anchors the review.', changeGroupIds: ['group-1'], dependsOnStoryIds: [] }],
  primaryStoryId: 'story-1',
  reviewPlan: ['story-1'],
  graphs: { systemOverview: graph('system-overview'), dataFlow: graph('data-flow'), codeDependency: graph('code-dependency'), userAction: graph('user-action') },
  tests: [{ id: 'test-1', title: 'evidence test', behavior: 'opens evidence', status: 'covered', evidenceIds: ['ev-1'], changeGroupIds: ['group-1'] }],
  reviewThreads: [],
  reviewInsights: [],
  risks: [],
  dependencies: [],
  unchangedInteractions: [],
  evidence: [{ id: 'ev-1', kind: 'file', title: 'App source', path: 'src/App.tsx', line: 42, url: 'https://github.com/acme/repo/blob/head/src/App.tsx#L42' }],
}

const richThreadDocument: ReviewDocument = {
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

  it('scopes Flows to a selected story across all of its change groups', async () => {
    const user = userEvent.setup()
    const flowDocument = {
      ...document,
      changeGroups: [
        ...document.changeGroups,
        { ...document.changeGroups[0], id: 'group-2', title: 'Second group' },
        { ...document.changeGroups[0], id: 'group-3', title: 'Other group' },
      ],
      stories: [
        { ...document.stories[0], title: 'Primary story', changeGroupIds: ['group-1', 'group-2'] },
        { id: 'story-2', title: 'Other story', summary: 'Other.', relationshipToPrimary: 'independent', relationshipRationale: 'Separate.', reviewReason: 'Review separately.', changeGroupIds: ['group-3'], dependsOnStoryIds: [] },
      ],
      reviewPlan: ['story-1', 'story-2'],
      graphs: {
        ...document.graphs,
        dataFlow: {
          ...document.graphs.dataFlow,
          nodes: [
            { id: 'primary-one', label: 'Primary one', explanation: 'Primary group one.', changed: true, changeGroupIds: ['group-1'], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] },
            { id: 'other', label: 'Other story node', explanation: 'Other group.', changed: true, changeGroupIds: ['group-3'], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] },
            { id: 'primary-two', label: 'Primary two', explanation: 'Primary group two.', changed: true, changeGroupIds: ['group-2'], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] },
            { id: 'context', label: 'Shared context', explanation: 'Context endpoint.', changed: false, changeGroupIds: [], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] },
          ],
          edges: [
            { id: 'primary-edge', source: 'primary-one', target: 'context', label: 'feeds', evidenceIds: [], changeGroupIds: ['group-1'], reviewThreadIds: [] },
            { id: 'second-edge', source: 'primary-two', target: 'primary-two', label: 'updates', evidenceIds: [], changeGroupIds: ['group-2'], reviewThreadIds: [] },
            { id: 'other-edge', source: 'other', target: 'other', label: 'unrelated', evidenceIds: [], changeGroupIds: ['group-3'], reviewThreadIds: [] },
          ],
          guidedTours: [{ id: 'story-tour', title: 'Story tour', steps: [
            { nodeId: 'primary-one', title: 'Primary one', explanation: 'Primary step.' },
            { nodeId: 'other', title: 'Other', explanation: 'Other step.' },
          ] }],
        },
      },
    } as ReviewDocument
    const mapped = mapReviewDocument(flowDocument, basePr, 'codex')

    const view = render(createElement(FlowsView, {
      flows: mapped.flows,
      flowType: 'data-flow',
      setFlowType: () => undefined,
      selectedFlowNodeId: null,
      evidence: mapped.evidence,
      stories: mapped.stories ?? [],
      threads: mapped.threads,
      openEvidence: () => undefined,
    }))

    await user.click(screen.getByRole('button', { name: 'Filter by story' }))
    await user.click(screen.getByRole('option', { name: 'Primary story' }))

    expect(screen.getByRole('button', { name: /Primary one:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Primary two:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Shared context:/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Other story node:/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Primary two:/ })).toHaveStyle({ left: '280px', top: '70px' })
    expect(screen.getByText(/Step 1 \/ 1/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText(/Step 1 \/ 1/)).toBeInTheDocument()

    const search = screen.getByRole('textbox', { name: 'Search flow nodes' })
    await user.type(search, 'does-not-exist')
    expect(screen.getByRole('status', { name: 'Story flow empty' })).toHaveTextContent('No flow nodes are linked to this story in this view.')
    await user.clear(search)

    await user.click(screen.getByRole('button', { name: 'Filter by story' }))
    await user.click(screen.getByRole('option', { name: 'All stories' }))
    expect(screen.getByRole('button', { name: /Other story node:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Primary two:/ })).toHaveStyle({ left: '470px', top: '70px' })

    view.rerender(createElement(FlowsView, {
      flows: mapped.flows,
      flowType: 'data-flow',
      setFlowType: () => undefined,
      selectedFlowNodeId: null,
      evidence: mapped.evidence,
      stories: (mapped.stories ?? []).filter((story) => story.id === 'story-2'),
      threads: mapped.threads,
      openEvidence: () => undefined,
    }))
    expect(screen.getByRole('button', { name: 'Filter by story' })).toHaveTextContent('All stories')
    expect(screen.getByRole('button', { name: /Other story node:/ })).toBeInTheDocument()
  })

  it('renders one recommended-order row per story with aggregate group attention', () => {
    const overviewDocument = {
      ...document,
      changeGroups: [
        ...document.changeGroups,
        { ...document.changeGroups[0], id: 'group-2', title: 'Second group', attention: 'low' },
        { ...document.changeGroups[0], id: 'group-3', title: 'Independent group', attention: 'medium' },
      ],
      stories: [
        { ...document.stories[0], title: 'Primary story', reviewReason: 'Review the primary story.', changeGroupIds: ['group-1', 'group-2'] },
        { id: 'story-2', title: 'Independent story', summary: 'Independent.', relationshipToPrimary: 'independent', relationshipRationale: 'Separate.', reviewReason: 'Review the independent story.', changeGroupIds: ['group-3'], dependsOnStoryIds: [] },
      ],
      reviewPlan: ['story-1', 'story-2'],
    } as ReviewDocument
    const mapped = mapReviewDocument(overviewDocument, basePr, 'codex')

    render(createElement(OverviewFull, { pr: mapped }))

    const rows = Array.from(window.document.querySelectorAll<HTMLElement>('.change-row'))
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getAllByText('Primary story')).toHaveLength(1)
    expect(within(rows[0]!).getByText('Review the primary story.')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('2 change groups')).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('high attention')
    expect(within(rows[1]!).getAllByText('Independent story')).toHaveLength(1)
    expect(within(rows[1]!).getByText('1 change group')).toBeInTheDocument()
  })

  it('resolves evidence IDs to exact paths and does not fabricate absent review threads', () => {
    const mapped = mapReviewDocument(document, basePr, 'codex')
    expect(mapped.evidence).toContainEqual(expect.objectContaining({ id: 'ev-1', path: 'src/App.tsx', line: 42 }))
    expect(mapped.tests[0].evidence).toBe('src/App.tsx:42')
    expect(mapped.threads).toEqual([])
  })

  it('maps rich review-thread metadata and preserves every reply', () => {
    const mapped = mapReviewDocument(richThreadDocument, basePr, 'codex')
    expect(mapped.threads).toHaveLength(1)
    expect(mapped.threads[0]).toEqual(expect.objectContaining({
      author: 'octocat', body: 'Please preserve the exact source location.', file: 'src/App.tsx', line: 42,
      authorAssociation: 'CONTRIBUTOR', url: 'https://github.com/acme/repo/pull/1#discussion_r1', resolvedBy: 'maintainer',
      commitSha: 'head', originalCommitSha: 'base', createdAt: '2026-08-05T00:00:00Z',
      replies: [expect.objectContaining({ author: 'maintainer', body: 'Done; the renderer now keeps every reply.', authorAssociation: 'MEMBER', path: 'src/App.tsx', line: 43, originalLine: 43, side: 'RIGHT', createdAt: '2026-08-05T00:01:00Z', updatedAt: '2026-08-05T00:01:00Z', commitSha: 'head', originalCommitSha: 'base', url: 'https://github.com/acme/repo/pull/1#discussion_r2' })],
      replyCount: 1,
    }))
  })

  it('shows scoped coordinator context and resolved dependency chains for the active Review chapter', async () => {
    const user = userEvent.setup()
    const coordinatorDocument = {
      ...document,
      changeGroups: [...document.changeGroups, { ...document.changeGroups[0], id: 'group-2', title: 'Second group' }],
      stories: [{ ...document.stories[0], changeGroupIds: ['group-1'] }, { id: 'story-2', title: 'Review second group', summary: 'Second story.', relationshipToPrimary: 'supporting', relationshipRationale: 'Supports the primary.', reviewReason: 'Review the second group.', changeGroupIds: ['group-2'], dependsOnStoryIds: ['story-1'] }],
      risks: [
        { id: 'risk-1', title: 'Clean CI ordering', detail: 'Tests must not depend on build output.', changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'risk-2', title: 'Second-group risk', detail: 'Only the second step should show this.', changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
      dependencies: [
        { id: 'dependency-1', title: 'Bridge packaging', detail: 'The provider bootstrap needs the emitted bridge.', dependsOnIds: [], changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'dependency-2', title: 'Second-group dependency', detail: 'Only the second step should show this.', dependsOnIds: ['dependency-1'], changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
      unchangedInteractions: [
        { id: 'unchanged-1', title: 'Stable workspace handoff', detail: 'The existing workspace contract remains stable.', changeGroupIds: ['group-1'], evidenceIds: ['ev-1'] },
        { id: 'unchanged-2', title: 'Stable callback boundary', detail: 'The callback boundary remains stable for this group.', changeGroupIds: ['group-2'], evidenceIds: ['ev-1'] },
      ],
    } as ReviewDocument
    const mapped = mapReviewDocument(coordinatorDocument, basePr, 'codex')

    render(createElement(ReviewView, {
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
    expect(screen.getByText('No story prerequisites.')).toBeInTheDocument()
    expect(screen.getByText('Stable workspace handoff')).toBeInTheDocument()
    expect(screen.queryByText('Stable callback boundary')).not.toBeInTheDocument()
    expect(screen.queryByText('Second-group risk')).not.toBeInTheDocument()
    expect(screen.queryByText('Second-group dependency')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /supporting story: review second group/i }))

    expect(screen.getByText('Second-group risk')).toBeInTheDocument()
    expect(screen.getByText('Second-group dependency')).toBeInTheDocument()
    expect(screen.getByText('Requires story: Read evidence')).toBeInTheDocument()
    expect(screen.getByText('Requires: Bridge packaging')).toBeInTheDocument()
    expect(screen.getByText('Stable callback boundary')).toBeInTheDocument()
    expect(screen.queryByText('Clean CI ordering')).not.toBeInTheDocument()
    expect(screen.queryByText('Bridge packaging')).not.toBeInTheDocument()
    expect(screen.queryByText('Stable workspace handoff')).not.toBeInTheDocument()
  })

  it('drops the previous Related flow trace when switching to a story with no trace', async () => {
    const user = userEvent.setup()
    const coordinatorDocument = {
      ...document,
      graphs: {
        ...document.graphs,
        dataFlow: {
          ...document.graphs.dataFlow,
          nodes: [
            { ...document.graphs.dataFlow.nodes[0], id: 'first-node', label: 'First flow', changeGroupIds: ['group-1'] },
            { ...document.graphs.dataFlow.nodes[0], id: 'context-node', label: 'Context flow', changeGroupIds: ['group-1'] },
          ],
          edges: [
            { ...document.graphs.dataFlow.edges[0], id: 'first-edge', source: 'first-node', target: 'first-node', label: 'runs', changeGroupIds: ['group-1'] },
            { ...document.graphs.dataFlow.edges[0], id: 'stale-edge', source: 'context-node', target: 'context-node', label: 'stale', changeGroupIds: ['group-2'] },
          ],
        },
      },
      changeGroups: [...document.changeGroups, { ...document.changeGroups[0], id: 'group-2', title: 'Second group' }],
      stories: [
        { ...document.stories[0], changeGroupIds: ['group-1'] },
        { id: 'story-2', title: 'Review second group', summary: 'Second story.', relationshipToPrimary: 'supporting', relationshipRationale: 'Supports the primary.', reviewReason: 'Review the second group.', changeGroupIds: ['group-2'], dependsOnStoryIds: ['story-1'] },
      ],
      reviewPlan: ['story-1', 'story-2'],
    } as ReviewDocument
    const mapped = mapReviewDocument(coordinatorDocument, basePr, 'codex')

    render(createElement(ReviewView, {
      pr: mapped,
      markGroup: () => undefined,
      reviewed: {},
      progress: {},
      updateProgress: () => undefined,
      openEvidence: () => undefined,
      openFlow: () => undefined,
    }))

    expect(screen.getByText('Related flow trace')).toBeInTheDocument()
    expect(screen.getAllByText('First flow → runs').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /supporting story: review second group/i }))

    expect(screen.queryByText('Related flow trace')).not.toBeInTheDocument()
    expect(screen.queryByText('First flow → runs')).not.toBeInTheDocument()
    expect(screen.queryByText('Context flow → stale')).not.toBeInTheDocument()
  })

  it('preserves per-group review notes and exposes every terminal status control', async () => {
    const user = userEvent.setup()
    const workflowDocument = {
      ...document,
      changeGroups: [
        ...document.changeGroups,
        { ...document.changeGroups[0], id: 'group-2', title: 'Second group' },
      ],
      stories: [
        { ...document.stories[0], changeGroupIds: ['group-1'] },
        {
          id: 'story-2',
          title: 'Review second group',
          summary: 'Second story.',
          relationshipToPrimary: 'supporting',
          relationshipRationale: 'Supports the primary.',
          reviewReason: 'Review the second group.',
          changeGroupIds: ['group-2'],
          dependsOnStoryIds: ['story-1'],
        },
      ],
      reviewPlan: ['story-1', 'story-2'],
    } as ReviewDocument
    const mapped = mapReviewDocument(workflowDocument, basePr, 'codex')
    const writes: Array<[string, string, string]> = []

    render(createElement(ReviewView, {
      pr: mapped,
      markGroup: () => undefined,
      reviewed: {},
      progress: {
        'run-1:group-1': { runId: 'run-1', changeGroupId: 'group-1', status: 'pending', note: 'Saved note', updatedAt: 'now' },
      },
      updateProgress: (groupId, status, note) => writes.push([groupId, status, note]),
      openEvidence: () => undefined,
      openFlow: () => undefined,
    }))

    const note = screen.getByRole('textbox', { name: 'Review note' })
    expect(note).toHaveValue('Saved note')
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs follow-up' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mark reviewed/i })).toBeInTheDocument()

    await user.clear(note)
    await user.type(note, 'Draft one')
    await user.click(screen.getByRole('button', { name: 'Needs follow-up' }))
    expect(writes.at(-1)).toEqual(['group-1', 'follow-up', 'Draft one'])

    await user.click(screen.getByRole('button', { name: /supporting story: review second group/i }))
    const secondNote = screen.getByRole('textbox', { name: 'Review note' })
    expect(secondNote).toHaveValue('')
    await user.type(secondNote, 'Draft two')
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(writes.at(-1)).toEqual(['group-2', 'skipped', 'Draft two'])

    await user.click(screen.getByRole('button', { name: /primary story: read evidence/i }))
    expect(screen.getByRole('textbox', { name: 'Review note' })).toHaveValue('Draft one')
    await user.click(screen.getByRole('button', { name: 'Pending' }))
    expect(writes.at(-1)).toEqual(['group-1', 'pending', 'Draft one'])
  })

  it('treats skipped groups as complete while follow-up takes precedence over pending', async () => {
    const user = userEvent.setup()
    const workflowDocument = {
      ...document,
      changeGroups: [
        ...document.changeGroups,
        { ...document.changeGroups[0], id: 'group-2', title: 'Second group' },
      ],
      stories: [
        { ...document.stories[0], changeGroupIds: ['group-1', 'group-2'] },
        {
          id: 'story-2',
          title: 'Review second group',
          summary: 'Second story.',
          relationshipToPrimary: 'supporting',
          relationshipRationale: 'Supports the primary.',
          reviewReason: 'Review the second group.',
          changeGroupIds: ['group-2'],
          dependsOnStoryIds: ['story-1'],
        },
      ],
      reviewPlan: ['story-1', 'story-2'],
    } as ReviewDocument
    const mapped = mapReviewDocument(workflowDocument, basePr, 'codex')
    const view = render(createElement(ReviewView, {
      pr: mapped,
      markGroup: () => undefined,
      reviewed: {},
      progress: {
        'run-1:group-1': { runId: 'run-1', changeGroupId: 'group-1', status: 'reviewed', note: '', updatedAt: 'now' },
        'run-1:group-2': { runId: 'run-1', changeGroupId: 'group-2', status: 'skipped', note: '', updatedAt: 'now' },
      },
      updateProgress: () => undefined,
      openEvidence: () => undefined,
      openFlow: () => undefined,
    }))

    expect(screen.getAllByText('reviewed').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: /supporting story: review second group/i }))
    expect(screen.getAllByText('skipped').length).toBeGreaterThan(0)

    view.rerender(createElement(ReviewView, {
      pr: mapped,
      markGroup: () => undefined,
      reviewed: {},
      progress: {
        'run-1:group-1': { runId: 'run-1', changeGroupId: 'group-1', status: 'follow-up', note: '', updatedAt: 'now' },
        'run-1:group-2': { runId: 'run-1', changeGroupId: 'group-2', status: 'pending', note: '', updatedAt: 'now' },
      },
      updateProgress: () => undefined,
      openEvidence: () => undefined,
      openFlow: () => undefined,
    }))
    await user.click(screen.getByRole('button', { name: /primary story: read evidence/i }))
    expect(screen.getAllByText('follow-up').length).toBeGreaterThan(0)
  })
})
