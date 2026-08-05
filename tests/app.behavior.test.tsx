import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'

describe('PR Atlas desktop workflow', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to the system theme and exposes accessible theme controls in settings', async () => {
    const user = userEvent.setup()
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)

    render(<App />)

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    await user.click(screen.getByRole('button', { name: /open settings/i }))
    expect(screen.getByRole('group', { name: /theme/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^system$/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^light$/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^dark$/i })).toBeInTheDocument()
  })

  it('persists explicit theme choices and applies them to the document', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', () => ({ matches: false, media: '(prefers-color-scheme: dark)', addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    render(<App />)

    await user.click(screen.getByRole('button', { name: /open settings/i }))
    await user.click(screen.getByRole('radio', { name: /^dark$/i }))

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(JSON.parse(window.localStorage.getItem('atlas:theme') ?? 'null')).toBe('dark')

    await user.click(screen.getByRole('radio', { name: /^light$/i }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(JSON.parse(window.localStorage.getItem('atlas:theme') ?? 'null')).toBe('light')
  })

  it('tracks operating-system theme changes while System is selected', async () => {
    const user = userEvent.setup()
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback },
      removeEventListener: vi.fn(),
    }))
    render(<App />)

    await user.click(screen.getByRole('button', { name: /open settings/i }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    act(() => listener?.({ matches: true } as MediaQueryListEvent))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')

    await user.click(screen.getByRole('radio', { name: /^light$/i }))
    act(() => listener?.({ matches: false } as MediaQueryListEvent))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('opens with the demo repository and a selected pull request', () => {
    render(<App />)

    expect(screen.getByText('PR Atlas', { exact: true })).toBeInTheDocument()
    expect(document.querySelector('.brand-mark')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /select repository/i })).toHaveTextContent('runway/atlas')
    const list = screen.getByRole('list', { name: /pull request list/i })
    expect(list).toBeInTheDocument()
    expect(within(list).getByRole('listitem', { name: /#482/i })).toHaveClass('selected')
  })

  it('renders the PR Atlas wordmark with an accessible text label', () => {
    render(<App />)

    expect(screen.getByText('PR Atlas', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('LOCAL MVP')).not.toBeInTheDocument()
  })

  it('filters the pull-request list without losing the selected item', async () => {
    const user = userEvent.setup()
    render(<App />)

    const list = screen.getByRole('list', { name: /pull request list/i })
    const initialCards = within(list).getAllByRole('listitem')
    expect(initialCards.length).toBeGreaterThan(1)

    await user.click(screen.getByRole('tab', { name: /^ready$/i }))

    const filteredCards = within(list).getAllByRole('listitem')
    expect(filteredCards.length).toBeLessThan(initialCards.length)
    expect(within(list).getByRole('listitem', { name: /#482/i })).toHaveClass('selected')
  })

  it('switches the selected PR between overview and walkthrough', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByRole('button', { name: /^overview$/i })).toHaveClass('active')

    await user.click(screen.getByRole('button', { name: /^walkthrough$/i }))

    expect(screen.getByRole('button', { name: /^walkthrough$/i })).toHaveClass('active')
    expect(screen.getByText(/guided review/i)).toBeInTheDocument()
  })

  it('shows analysis progress and returns to idle when cancelled', async () => {
    const user = userEvent.setup()
    render(<App />)

    const list = screen.getByRole('list', { name: /pull request list/i })
    await user.click(within(list).getByRole('listitem', { name: /#455/i }))
    expect(screen.getAllByRole('button', { name: /^analyze$/i })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: /^analyze$/i }))

    expect(screen.getByText(/building your walkthrough/i)).toBeInTheDocument()
    expect(screen.getByText(/stage 1 of 5/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(screen.getByText(/walkthrough not generated yet/i)).toBeInTheDocument()
  })

  it('completes local analysis into a rendered walkthrough', async () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      const list = screen.getByRole('list', { name: /pull request list/i })
      fireEvent.click(within(list).getByRole('listitem', { name: /#455/i }))
      fireEvent.click(screen.getByRole('button', { name: /^analyze$/i }))

      await act(async () => { vi.advanceTimersByTime(5200) })

      expect(screen.getByRole('heading', { name: /session ownership/i })).toBeInTheDocument()
      expect(screen.queryByText(/walkthrough not generated yet/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live provider analysis running while the IPC request is pending', async () => {
    vi.useFakeTimers()
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    }
    const repository = {
      source: 'github', id: 'repo-live', name: 'atlas', fullName: 'runway/atlas', owner: 'runway', private: true,
      defaultBranch: 'main', updatedAt: '2026-08-04T08:00:00.000Z', url: 'https://github.com/runway/atlas',
    }
    const pullRequest = {
      source: 'github', id: 'pr-live', repository: repository.fullName, number: 42, title: 'Pending live analysis',
      url: 'https://github.com/runway/atlas/pull/42', state: 'open', author: 'maya', baseRef: 'main', headRef: 'feature/live',
      baseSha: 'base-sha', headSha: 'head-sha', updatedAt: '2026-08-04T08:30:00.000Z', isDraft: false,
      additions: 2, deletions: 1, changedFiles: 1, labels: [], reviewDecision: null, reviewRequested: false,
    }
    const startAnalysis = vi.fn(() => new Promise<never>(() => undefined))
    const api = {
      bootstrap: vi.fn(async () => ({ account: null, repositories: [repository], warnings: [] })),
      listProviders: vi.fn(async () => [{ provider: 'claude', displayName: 'Claude Code', executable: 'claude', installed: true, version: '1.2.3', capabilities }]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis,
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => []),
      loadAnalysisRun: vi.fn(async () => null),
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn(() => () => undefined),
    }
    Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: api })
    try {
      render(<App />)
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
      expect(api.bootstrap).toHaveBeenCalled()
      expect(api.listProviders).toHaveBeenCalled()
      expect(api.listPullRequests).toHaveBeenCalled()
      const list = screen.getByRole('list', { name: /pull request list/i })
      fireEvent.click(within(list).getByRole('listitem', { name: /#42 pending live analysis/i }))
      expect(screen.getAllByRole('button', { name: /^analyze$/i })).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: /^analyze$/i }))
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      expect(startAnalysis).toHaveBeenCalledTimes(1)

      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve() })

      expect(screen.getByText(/building your walkthrough/i)).toBeInTheDocument()
      expect(screen.getByText(/stage 1 of 5/i)).toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: undefined })
      vi.useRealTimers()
    }
  })

  it('offers same-head reruns for a ready live pull request with the selected provider', async () => {
    const user = userEvent.setup()
    const capabilities = {
      structuredOutput: true,
      streaming: true,
      sessionContinuation: false,
      readOnly: true,
      toolAllowlist: true,
      modelSelection: true,
      authenticationState: true,
    }
    const repository = {
      source: 'github', id: 'repo-rerun', name: 'atlas', fullName: 'runway/atlas', owner: 'runway', private: true,
      defaultBranch: 'main', updatedAt: '2026-08-04T08:00:00.000Z', url: 'https://github.com/runway/atlas',
    }
    const pullRequest = {
      source: 'github', id: 'pr-rerun', repository: repository.fullName, number: 43, title: 'Ready live walkthrough',
      url: 'https://github.com/runway/atlas/pull/43', state: 'open', author: 'maya', baseRef: 'main', headRef: 'feature/rerun',
      baseSha: 'base-sha-rerun', headSha: 'head-sha-rerun', updatedAt: '2026-08-04T08:30:00.000Z', isDraft: false,
      additions: 4, deletions: 2, changedFiles: 2, labels: [], reviewDecision: null, reviewRequested: false,
    }
    const graph = (id: string) => ({ id, nodes: [], edges: [], guidedTours: [] })
    const document = {
      schemaVersion: '1.0.0',
      run: { id: 'run-rerun', createdAt: '2026-08-04T08:35:00.000Z', provider: 'codex', model: 'codex-test', skillVersion: 'test' },
      pullRequest: { host: 'github.com', repository: repository.fullName, number: pullRequest.number, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha },
      summary: { intent: 'Ready live walkthrough', behavioralChanges: [], architecturalImpact: [], limitations: [] },
      changeGroups: [], walkthrough: [], graphs: { systemOverview: graph('system-overview'), dataFlow: graph('data-flow'), codeDependency: graph('code-dependency'), userAction: graph('user-action') },
      tests: [], reviewThreads: [], reviewInsights: [], evidence: [],
    }
    const runResult = {
      runId: 'run-rerun', status: 'ready', document,
      manifest: { runId: 'run-rerun', repository: repository.fullName, pullNumber: pullRequest.number, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha, provider: 'codex', status: 'ready', createdAt: '2026-08-04T08:35:00.000Z', schemaVersion: '1.0.0', artifactDirectory: '/tmp/run-rerun' },
      artifactDirectory: '/tmp/run-rerun',
    }
    const startAnalysis = vi.fn(async () => runResult)
    const api = {
      bootstrap: vi.fn(async () => ({ account: null, repositories: [repository], warnings: [] })),
      listProviders: vi.fn(async () => [
        { provider: 'claude', displayName: 'Claude Code', executable: 'claude', installed: true, version: '1.2.3', capabilities },
        { provider: 'codex', displayName: 'Codex CLI', executable: 'codex', installed: true, version: '0.9.0', capabilities },
      ]),
      listPullRequests: vi.fn(async () => [pullRequest]),
      startAnalysis,
      cancelAnalysis: vi.fn(async () => true),
      listAnalysisRuns: vi.fn(async () => []),
      loadAnalysisRun: vi.fn(async () => null),
      openExternal: vi.fn(async () => true),
      subscribeAnalysisProgress: vi.fn(() => () => undefined),
    }
    Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: api })
    try {
      render(<App />)
      await user.click(await screen.findByRole('listitem', { name: /#43 ready live walkthrough/i }))
      await user.click(screen.getByRole('button', { name: /open settings/i }))
      await user.click(screen.getByRole('radio', { name: /codex cli/i }))
      await user.click(screen.getByRole('button', { name: /open settings/i }))

      await user.click(screen.getByRole('button', { name: /^analyze$/i }))
      expect(screen.getByRole('heading', { name: /send repository context to codex cli/i })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /continue/i }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })

      expect(startAnalysis).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: /analyze again/i })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /analyze again/i }))
      expect(screen.getByRole('heading', { name: /send repository context to codex cli/i })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /continue/i }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })

      expect(startAnalysis).toHaveBeenCalledTimes(2)
      expect(startAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', headSha: pullRequest.headSha }))
    } finally {
      Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: undefined })
    }
  })

  it('persists the reviewed state while moving around the walkthrough', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /^walkthrough$/i }))
    await user.click(screen.getByRole('button', { name: /mark reviewed/i }))
    expect(screen.getByRole('button', { name: /reviewed/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^overview$/i }))
    await user.click(screen.getByRole('button', { name: /^walkthrough$/i }))

    expect(screen.getByRole('button', { name: /reviewed/i })).toBeInTheDocument()
  })

  it('does not bleed review progress between pull requests sharing group ids', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /^walkthrough$/i }))
    await user.click(screen.getByRole('button', { name: /mark reviewed/i }))
    expect(screen.getByRole('button', { name: /reviewed/i })).toBeInTheDocument()

    const list = screen.getByRole('list', { name: /pull request list/i })
    await user.click(within(list).getByRole('listitem', { name: /#476/i }))
    await user.click(screen.getByRole('button', { name: /^walkthrough$/i }))

    expect(screen.getByRole('button', { name: /mark reviewed/i })).toBeInTheDocument()
  })

  it.each([
    ['system', /system/i, 'Request lifecycle'],
    ['data', /data/i, 'Refresh token data'],
    ['dependency', /dependency/i, 'Module dependencies'],
    ['user', /user/i, 'User sign-in'],
  ])('changes the flow view to %s', async (_, label, expectedTitle) => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /^flows$/i }))
    const flowTab = screen.getByRole('tab', { name: label })
    await user.click(flowTab)

    expect(flowTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: expectedTitle })).toBeInTheDocument()
  })
})
