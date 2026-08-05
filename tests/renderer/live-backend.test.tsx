import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AnalysisRunResult,
  AnalysisRunSummary,
  AgentCapabilities,
  AgentInstallationStatus,
  BootstrapResult,
  Graph,
  GraphNode,
  PrAtlasApi,
  PullRequestDTO,
  RepositoryDTO,
  WalkthroughDocument,
} from '../../shared/contracts'
import App from '../../src/App'

const repository: RepositoryDTO = {
  source: 'github',
  id: 'repo-atlas',
  name: 'atlas',
  fullName: 'runway/atlas',
  owner: 'runway',
  private: true,
  defaultBranch: 'main',
  updatedAt: '2026-08-04T08:00:00.000Z',
  url: 'https://github.com/runway/atlas',
}

const pullRequest: PullRequestDTO = {
  source: 'github',
  id: 'pr-42',
  repository: repository.fullName,
  number: 42,
  title: 'Persist local walkthrough history',
  url: 'https://github.com/runway/atlas/pull/42',
  state: 'open',
  author: 'maya',
  baseRef: 'main',
  headRef: 'feature/history',
  baseSha: 'base-sha-42',
  headSha: 'head-sha-42',
  updatedAt: '2026-08-04T08:30:00.000Z',
  isDraft: false,
  additions: 32,
  deletions: 8,
  changedFiles: 3,
  labels: ['desktop'],
  reviewDecision: null,
  reviewRequested: true,
  authoredByViewer: true,
  reviewedByViewer: true,
}

function graph(id: Graph['id'], title: string, nodeId: string): Graph {
  const node: GraphNode = {
    id: nodeId,
    explanation: `${title} explanation`,
    label: title,
    changed: true,
    evidenceIds: ['evidence-store'],
    changeGroupIds: ['group-history'],
    testIds: ['test-history'],
    reviewThreadIds: ['thread-history'],
    reviewInsightIds: [],
  }
  const contextNode: GraphNode = {
    id: `${nodeId}-context`,
    explanation: `${title} unchanged context`,
    label: `${title} context`,
    changed: false,
    evidenceIds: ['evidence-store'],
    changeGroupIds: [],
    testIds: [],
    reviewThreadIds: [],
    reviewInsightIds: [],
  }
  return {
    id,
    description: `${title} graph description`,
    nodes: [node, contextNode],
    edges: id === 'system-overview' ? [] : [{ id: `${id}-edge`, source: nodeId, target: contextNode.id, label: 'continues', evidenceIds: ['evidence-store'], changeGroupIds: ['group-history'], reviewThreadIds: ['thread-history'] }],
    guidedTours: [{ id: `${id}-tour`, title: `Tour ${title}`, steps: [{ nodeId, title: `Inspect ${title}`, explanation: `${title} tour step`, evidenceIds: ['evidence-store'] }] }],
  }
}

const document: WalkthroughDocument = {
  schemaVersion: '1.0.0',
  run: {
    id: 'run-42',
    createdAt: '2026-08-04T08:35:00.000Z',
    provider: 'claude',
    model: 'claude-test',
    skillVersion: 'test',
  },
  pullRequest: {
    host: 'github.com',
    repository: repository.fullName,
    number: pullRequest.number,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
  },
  summary: {
    intent: 'Loaded live analysis content from the Electron run store.',
    behavioralChanges: [],
    architecturalImpact: [],
    limitations: [],
  },
  changeGroups: [{ id: 'group-history', title: 'History persistence', summary: 'Persist local walkthrough history.', motivation: 'Keep prior runs available.', previousBehavior: 'History was discarded.', newBehavior: 'History is stored locally.', attention: 'high', evidenceIds: ['evidence-store'] }],
  walkthrough: [{ id: 'walkthrough-history', title: 'Persist history', changeGroupId: 'group-history', evidenceIds: ['evidence-store'] }],
  graphs: {
    systemOverview: graph('system-overview', 'System overview node', 'system-node'),
    dataFlow: graph('data-flow', 'Data flow node', 'data-node'),
    codeDependency: graph('code-dependency', 'Code dependency node', 'dependency-node'),
    userAction: graph('user-action', 'User action node', 'user-node'),
  },
  tests: [{ id: 'test-history', title: 'history persistence test', status: 'covered', evidenceIds: ['evidence-store'], changeGroupIds: ['group-history'], behavior: 'History remains available.' }],
  reviewThreads: [{
    id: 'thread-history', status: 'active', provenance: 'human', evidenceIds: ['evidence-store'], author: 'reviewer', body: 'Keep the history write atomic.',
    replies: [{ id: 'reply-history-1', author: 'maya', body: 'Agreed — the write now commits before the renderer updates.', authorAssociation: 'OWNER', createdAt: '2026-08-04T08:36:00.000Z', updatedAt: '2026-08-04T08:36:00.000Z', url: 'https://github.com/runway/atlas/pull/42#discussion_r2', path: 'electron/backend/store.ts', line: 48, originalLine: 47, side: 'RIGHT', commitSha: 'head-sha-42', originalCommitSha: 'base-sha-42' }],
    replyCount: 1, url: 'https://github.com/runway/atlas/pull/42#discussion_r1', resolvedBy: null, authorAssociation: 'CONTRIBUTOR', path: 'electron/backend/store.ts', line: 45, originalLine: 44, side: 'RIGHT', startLine: null, originalStartLine: null, commitSha: 'head-sha-42', originalCommitSha: 'base-sha-42', createdAt: '2026-08-04T08:35:10.000Z', updatedAt: '2026-08-04T08:35:10.000Z', changeGroupIds: ['group-history'], graphNodeIds: ['data-node'], reviewInsightIds: [],
  }],
  reviewInsights: [],
  evidence: [{ id: 'evidence-store', kind: 'file', title: 'store.ts', path: 'electron/backend/store.ts', line: null, url: 'https://github.com/runway/atlas/blob/head/electron/backend/store.ts' }],
}

const runSummary: AnalysisRunSummary = {
  runId: 'run-42',
  repository: repository.fullName,
  pullNumber: pullRequest.number,
  baseSha: pullRequest.baseSha,
  headSha: pullRequest.headSha,
  provider: 'claude',
  status: 'ready',
  createdAt: '2026-08-04T08:35:00.000Z',
  completedAt: '2026-08-04T08:37:00.000Z',
  schemaVersion: '1.0.0',
  model: 'claude-test',
  artifactDirectory: '/tmp/pr-atlas/run-42',
}

const runResult: AnalysisRunResult = {
  runId: runSummary.runId,
  status: 'ready',
  document,
  manifest: runSummary,
  artifactDirectory: runSummary.artifactDirectory,
}

const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: true,
  sessionContinuation: false,
  readOnly: true,
  toolAllowlist: true,
  modelSelection: true,
  authenticationState: true,
}

const providers: AgentInstallationStatus[] = [
  { provider: 'claude', displayName: 'Claude Code', executable: 'claude', installed: true, version: '1.2.3', capabilities, models: [{ id: 'claude-sonnet', label: 'Claude Sonnet', isDefault: true }] },
  { provider: 'codex', displayName: 'Codex CLI', executable: 'codex', installed: true, version: '0.9.0', capabilities, models: [{ id: 'gpt-5.6', label: 'GPT-5.6', isDefault: true }, { id: 'gpt-5.6-mini', label: 'GPT-5.6 mini' }] },
  { provider: 'cursor', displayName: 'Cursor Agent', executable: 'cursor-agent', installed: false, capabilities, models: [], error: 'Cursor Agent was not found.' },
]

function installLiveApi() {
  const api: PrAtlasApi = {
    bootstrap: vi.fn(async (): Promise<BootstrapResult> => ({ account: { source: 'github', login: 'maya', name: 'Maya Chen', avatarUrl: null }, repositories: [repository], warnings: [] })),
    listProviders: vi.fn(async () => providers),
    listPullRequests: vi.fn(async (name: string) => name === repository.fullName ? [pullRequest] : []),
    startAnalysis: vi.fn(async () => runResult),
    cancelAnalysis: vi.fn(async () => true),
    listAnalysisRuns: vi.fn(async () => [runSummary]),
    loadAnalysisRun: vi.fn(async () => runResult),
    openExternal: vi.fn(async () => true),
    openEvidence: vi.fn(async () => true),
    checkForUpdate: vi.fn(async () => ({ currentVersion: '0.1.0', latestVersion: '0.1.0', available: false, checkedAt: '2026-08-05T08:00:00.000Z' })),
    downloadUpdate: vi.fn(async () => ({ success: true, artifactName: 'PR-Atlas-9.4.0-mac-arm64.dmg', path: '/Users/maya/Downloads/PR-Atlas-9.4.0-mac-arm64.dmg' })),
    openDownloadedUpdate: vi.fn(async () => true),
    subscribeAnalysisProgress: vi.fn(() => () => undefined),
  }
  Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: api })
  return api
}

describe('live Electron renderer contract', () => {
  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: undefined })
  })

  it('bootstraps discovery and renders the selected pull request from the Electron API', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    window.localStorage.setItem('atlas:selected-repo', JSON.stringify('atlas'))

    render(<App />)

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.listPullRequests).toHaveBeenCalledWith(repository.fullName))
    await waitFor(() => expect(api.listAnalysisRuns).toHaveBeenCalledWith(repository.fullName, pullRequest.number, pullRequest.headSha))
    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))

    const repositorySelect = screen.getByRole('button', { name: /select repository/i })
    expect(repositorySelect).toHaveTextContent(repository.fullName)
    await user.click(repositorySelect)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([repository.fullName])
    await user.keyboard('{Escape}')
    expect(screen.getByLabelText('GitHub account Maya Chen')).toHaveTextContent('MC')
    expect(screen.queryByText('LOCAL MVP')).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /#42 persist local walkthrough history/i })).toBeInTheDocument()
    expect(screen.getByText(document.summary.intent)).toBeInTheDocument()
  })

  it('falls back to the GitHub login when the account has no display name', async () => {
    const api = installLiveApi()
    vi.mocked(api.bootstrap).mockResolvedValue({
      account: { source: 'github', login: 'singleword', name: null, avatarUrl: null },
      repositories: [repository],
      warnings: [],
    })

    render(<App />)

    expect(await screen.findByLabelText('GitHub account singleword')).toHaveTextContent('S')
  })

  it('downloads and opens a newer installer inside the client while retaining a release-page fallback', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    vi.mocked(api.checkForUpdate!).mockResolvedValue({
      currentVersion: '0.1.0',
      latestVersion: '9.4.0',
      available: true,
      releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
      artifactName: 'PR-Atlas-9.4.0-mac-arm64.dmg',
      downloadUrl: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-arm64.dmg',
      checkedAt: '2026-08-05T08:00:00.000Z',
    })

    render(<App />)

    const notification = await screen.findByLabelText(/new version available.*9\.4\.0/i)
    expect(notification).toBeInTheDocument()
    expect(screen.getByText(/current version 0\.1\.0/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /download update 9\.4\.0/i }))
    expect(api.downloadUpdate).toHaveBeenCalledOnce()
    await user.click(await screen.findByRole('button', { name: /open downloaded update 9\.4\.0/i }))
    expect(api.openDownloadedUpdate).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /view release 9\.4\.0/i }))
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0')
  })

  it('uses tool-reported models, persists supplemental guidance, and auto-starts consent for an unprocessed PR', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    vi.mocked(api.listAnalysisRuns).mockResolvedValue([])

    render(<App />)

    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /codex cli/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/active provider: codex cli/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open settings/i }))
    expect(screen.getByRole('radio', { name: /codex cli/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /cursor agent/i })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /claude code/i }))
    await user.click(screen.getByRole('radio', { name: /codex cli/i }))
    expect(JSON.parse(window.localStorage.getItem('atlas:provider') ?? 'null')).toBe('codex')
    const model = screen.getByRole('button', { name: /model for codex cli/i })
    expect(model).toHaveTextContent('GPT-5.6')
    await user.click(model)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['GPT-5.6', 'GPT-5.6 mini'])
    await user.click(screen.getByRole('option', { name: 'GPT-5.6 mini' }))
    await user.type(screen.getByRole('textbox', { name: /supplemental collection guidance/i }), 'Collect more migration and rollback evidence.')
    expect(screen.getByLabelText(/active provider: codex cli/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open settings/i }))
    await user.click(screen.getByRole('listitem', { name: /#42 persist local walkthrough history/i }))
    expect(screen.getByRole('heading', { name: /send repository context to codex cli/i })).toBeInTheDocument()
    expect(screen.getByText(/configured model service/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(api.startAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5.6-mini',
      customPrompt: 'Collect more migration and rollback evidence.',
    })))
  })

  it('does not leak demo pull request content into an empty live repository', async () => {
    const api = installLiveApi()
    vi.mocked(api.listPullRequests).mockResolvedValue([])

    render(<App />)

    await waitFor(() => expect(api.listPullRequests).toHaveBeenCalledWith(repository.fullName))
    expect(await screen.findByText('No open pull requests.')).toBeInTheDocument()
    expect(screen.queryByText('Rotate refresh tokens at the session boundary')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No open pull requests' })).toBeInTheDocument()
    expect(screen.queryByText('Select a pull request to open its walkthrough.')).not.toBeInTheDocument()
  })

  it('does not show Ready when a saved artifact fails strict loading', async () => {
    const api = installLiveApi()
    vi.mocked(api.loadAnalysisRun).mockResolvedValue(null)
    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))
    expect(screen.queryByRole('button', { name: /analyze again/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry analysis/i })).toBeInTheDocument()
  })

  it('uses the ready run manifest provider when a loaded document has stale legacy provenance', async () => {
    const api = installLiveApi()
    const manifest = { ...runSummary, provider: 'codex' as const }
    const staleDocument = { ...document, run: { ...document.run, provider: 'OpenAI' } }
    vi.mocked(api.listAnalysisRuns).mockResolvedValue([manifest])
    vi.mocked(api.loadAnalysisRun).mockResolvedValue({ ...runResult, document: staleDocument, manifest })

    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, manifest.runId))
    expect(await screen.findByText('Validated Codex CLI walkthrough')).toBeInTheDocument()
    expect(screen.queryByText('Validated Claude Code walkthrough')).not.toBeInTheDocument()
  })

  it('shows each run provider and exact model separately and opens a historical Ready artifact', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    const historicalSummary: AnalysisRunSummary = {
      ...runSummary,
      runId: 'run-historical',
      headSha: 'old-head-sha-42',
      provider: 'codex',
      model: 'gpt-historical',
      createdAt: '2026-08-03T08:35:00.000Z',
      outdated: true,
      artifactDirectory: '/tmp/pr-atlas/run-historical',
    }
    const historicalDocument: WalkthroughDocument = {
      ...document,
      run: { ...document.run, id: historicalSummary.runId, provider: 'codex', model: 'gpt-historical' },
      pullRequest: { ...document.pullRequest, headSha: historicalSummary.headSha },
      summary: { ...document.summary, intent: 'Loaded the selected historical walkthrough.' },
    }
    vi.mocked(api.listAnalysisRuns).mockResolvedValue([runSummary, historicalSummary])
    vi.mocked(api.loadAnalysisRun).mockImplementation(async (_repository, _pullNumber, runId) => runId === historicalSummary.runId
      ? { runId, status: 'ready', document: historicalDocument, manifest: historicalSummary, artifactDirectory: historicalSummary.artifactDirectory }
      : runResult)

    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))
    await user.click(screen.getByRole('button', { name: /analysis details/i }))
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
    expect(screen.getAllByText('claude-test').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Codex CLI').length).toBeGreaterThan(0)
    expect(screen.getByText('gpt-historical')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open historical run.*codex cli.*gpt-historical/i }))
    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, historicalSummary.runId))
    expect(await screen.findByText('Loaded the selected historical walkthrough.')).toBeInTheDocument()
    expect(screen.getByText('Validated Codex CLI walkthrough')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /analysis details/i }))
    await user.click(screen.getByRole('button', { name: /electron\/backend\/store\.ts/i }))
    expect(api.openEvidence).toHaveBeenLastCalledWith(repository.fullName, historicalSummary.headSha, 'electron/backend/store.ts', undefined)
  })

  it('opens exact evidence in the managed worktree without checkout mapping controls', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))
    await user.click(screen.getByRole('button', { name: /analysis details/i }))
    await user.click(screen.getByRole('button', { name: /electron\/backend\/store\.ts/i }))
    expect(api.openEvidence).toHaveBeenCalledWith(repository.fullName, pullRequest.headSha, 'electron/backend/store.ts', undefined)
    expect(screen.queryByRole('button', { name: /map existing checkout/i })).not.toBeInTheDocument()
  })

  it('renders complete review threads with metadata and every reply', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))
    await user.click(screen.getByRole('button', { name: /review threads/i }))

    expect(screen.getByText('Keep the history write atomic.')).toBeInTheDocument()
    expect(screen.getByText('CONTRIBUTOR')).toBeInTheDocument()
    expect(screen.getByText(/electron\/backend\/store\.ts:45/)).toBeInTheDocument()
    expect(screen.getAllByText(/2026-08-04T08:35:10\.000Z/)).toHaveLength(2)
    expect(screen.getByText('Agreed — the write now commits before the renderer updates.')).toBeInTheDocument()
    expect(screen.getByText('OWNER')).toBeInTheDocument()
    expect(screen.getByText(/electron\/backend\/store\.ts:48/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open review thread/i })).toHaveAttribute('href', 'https://github.com/runway/atlas/pull/42#discussion_r1')
  })

  it('replaces a previously selected demo repository after live discovery', async () => {
    window.localStorage.setItem('atlas:selected-repo', JSON.stringify('atlas'))
    const api = installLiveApi()

    render(<App />)

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.listPullRequests).toHaveBeenCalledWith(repository.fullName))
    expect(screen.getByRole('button', { name: /select repository/i })).toHaveTextContent(repository.fullName)
    expect(screen.queryByText('Rotate refresh tokens at the session boundary')).not.toBeInTheDocument()
  })

  it('never falls back to demo repositories in Electron and recovers repository selection on refresh', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    vi.mocked(api.bootstrap).mockResolvedValueOnce({
      account: null,
      repositories: [],
      warnings: ['GitHub CLI is not authenticated.'],
    }).mockResolvedValueOnce({
      account: { source: 'github', login: 'maya', name: 'Maya Chen', avatarUrl: null },
      repositories: [repository],
      warnings: [],
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'GitHub repositories unavailable' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /select repository/i })).toHaveTextContent('Choose repository')
    expect(screen.queryByText('Rotate refresh tokens at the session boundary')).not.toBeInTheDocument()
    expect(screen.queryByText(/demo repository/i)).not.toBeInTheDocument()
    expect(screen.getByText('GitHub CLI offline')).not.toHaveAttribute('title', expect.stringMatching(/fixture/i))
    expect(api.listPullRequests).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Retry GitHub discovery' }))

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.listPullRequests).toHaveBeenCalledWith(repository.fullName))
    expect(screen.getByRole('button', { name: /select repository/i })).toHaveTextContent(repository.fullName)
    expect(screen.getByText('@maya')).toBeInTheDocument()
    expect(screen.getByLabelText('GitHub account Maya Chen')).toHaveTextContent('MC')
  })

  it('does not present a stored provider as active when no provider is installed', async () => {
    const api = installLiveApi()
    vi.mocked(api.listProviders!).mockResolvedValue(providers.map((status) => ({ ...status, installed: false })))

    render(<App />)

    await waitFor(() => expect(api.listProviders).toHaveBeenCalledOnce())
    expect(await screen.findByLabelText('Provider status: No provider available')).toHaveTextContent('No provider available')
    expect(screen.queryByLabelText(/active provider:/i)).not.toBeInTheDocument()
  })

  it('exposes four graph views with changed/context filters, group highlighting, comments, search, pan, zoom, and tours', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    render(<App />)

    await waitFor(() => expect(api.loadAnalysisRun).toHaveBeenCalledWith(repository.fullName, pullRequest.number, runSummary.runId))
    await waitFor(() => expect(screen.getByText(document.summary.intent)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /^flows$/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^flows$/i }))

    const flowTabs = [
      'System overview',
      'Data flow',
      'Code dependency',
      'User action',
    ].map((name) => screen.getByRole('tab', { name }))
    expect(flowTabs).toHaveLength(4)

    await user.click(screen.getByRole('tab', { name: 'Data flow' }))
    expect(screen.getByRole('tab', { name: 'Data flow' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('button', { name: /changed nodes/i }))
    expect(screen.queryByRole('button', { name: /data flow node context:/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /all nodes/i }))
    await user.click(screen.getByRole('button', { name: /highlight change group/i }))
    await user.click(screen.getByRole('option', { name: 'History persistence' }))
    expect(screen.getByRole('region', { name: /data flow graph/i }).querySelector('[data-change-group-highlight="true"]')).toBeTruthy()
    await user.click(screen.getByText('Data flow node', { selector: 'button' }))
    expect(screen.getByText(/keep the history write atomic/i)).toBeInTheDocument()

    const search = screen.getByRole('textbox', { name: /search flow nodes/i })
    await user.type(search, 'Data flow node')
    expect(screen.getByText('Data flow node', { selector: 'button' })).toBeInTheDocument()

    const zoomIn = screen.getByRole('button', { name: /zoom in/i })
    const zoomOut = screen.getByRole('button', { name: /zoom out/i })
    const fitToView = screen.getByRole('button', { name: /fit to view/i })
    const resetZoom = screen.getByRole('button', { name: /reset zoom/i })
    expect(zoomIn).toBeInTheDocument()
    expect(zoomOut).toBeInTheDocument()
    expect(fitToView).toBeInTheDocument()
    expect(resetZoom).toBeInTheDocument()

    await user.click(zoomIn)
    expect(screen.getByRole('status', { name: /zoom level/i })).toHaveTextContent('110%')
    await user.click(zoomOut)
    expect(screen.getByRole('status', { name: /zoom level/i })).toHaveTextContent('100%')
    await user.click(fitToView)
    await user.click(resetZoom)
    expect(screen.getByRole('status', { name: /zoom level/i })).toHaveTextContent('100%')

    vi.stubGlobal('PointerEvent', MouseEvent)
    const canvas = screen.getByRole('region', { name: /data flow graph/i })
    const grid = canvas.querySelector('.flow-grid') as HTMLElement
    fireEvent.pointerDown(grid, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 50, clientY: 40 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(canvas.querySelector('.flow-graph-surface')).toHaveAttribute('data-pan-x', '40')
    expect(canvas.querySelector('.flow-graph-surface')).toHaveAttribute('data-pan-y', '30')

    const tour = within(canvas)
    expect(tour.getByRole('button', { name: /next tour/i })).toBeInTheDocument()
    expect(tour.getByRole('button', { name: /restart tour/i })).toBeInTheDocument()
    await user.click(tour.getByRole('button', { name: /next tour/i }))
    await user.click(tour.getByRole('button', { name: /restart tour/i }))
  })

  it('sizes directed-edge geometry to the full surface for large graphs', async () => {
    const user = userEvent.setup()
    const api = installLiveApi()
    const manyNodes = Array.from({ length: 12 }, (_, index): GraphNode => ({
      id: `large-node-${index}`,
      label: `Large node ${index}`,
      explanation: `Large graph node ${index}`,
      changed: true,
      evidenceIds: ['evidence-store'],
      changeGroupIds: ['group-history'],
      testIds: [],
      reviewThreadIds: [],
      reviewInsightIds: [],
    }))
    const largeDocument: WalkthroughDocument = {
      ...document,
      graphs: {
        ...document.graphs,
        dataFlow: { ...document.graphs.dataFlow, nodes: manyNodes, edges: [] },
      },
    }
    vi.mocked(api.loadAnalysisRun).mockResolvedValue({ ...runResult, document: largeDocument })

    render(<App />)
    await waitFor(() => expect(screen.getByText(document.summary.intent)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^flows$/i }))
    await user.click(screen.getByRole('tab', { name: 'Data flow' }))

    const canvas = screen.getByRole('region', { name: /data flow graph/i })
    expect(canvas.querySelector('.flow-graph-surface')).toHaveStyle({ width: '700px', height: '540px' })
    expect(canvas.querySelector('.flow-edges')).toHaveStyle({ width: '700px', height: '540px' })
  })
})
