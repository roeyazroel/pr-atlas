import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapResult, PrAtlasApi, RepositoryDTO } from '../../shared/contracts'
import App from '../../src/App'

const repository: RepositoryDTO = {
  source: 'github',
  id: 'roeyazroel/pr-atlas',
  name: 'pr-atlas',
  fullName: 'roeyazroel/pr-atlas',
  owner: 'roeyazroel',
  private: false,
  defaultBranch: 'main',
  updatedAt: '2026-08-05T08:00:00.000Z',
  url: 'https://github.com/roeyazroel/pr-atlas',
}

function installEmptyRepositoryApi() {
  const api: PrAtlasApi = {
    bootstrap: vi.fn(async (): Promise<BootstrapResult> => ({
      account: { source: 'github', login: 'roeyazroel', name: 'Roey Azroel', avatarUrl: null },
      repositories: [repository],
      warnings: [],
    })),
    listProviders: vi.fn(async () => []),
    listPullRequests: vi.fn(async () => []),
    startAnalysis: vi.fn(async () => { throw new Error('unused in empty repository state') }),
    cancelAnalysis: vi.fn(async () => true),
    listAnalysisRuns: vi.fn(async () => []),
    loadAnalysisRun: vi.fn(async () => null),
    openExternal: vi.fn(async () => true),
    subscribeAnalysisProgress: vi.fn(() => () => undefined),
  }
  Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: api })
  return api
}

describe('renderer empty repository state', () => {
  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(window, 'prAtlas', { configurable: true, writable: true, value: undefined })
  })

  it('shows a repository-specific empty state when no open pull requests exist', async () => {
    const api = installEmptyRepositoryApi()

    render(<App />)

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledOnce())
    await waitFor(() => expect(api.listPullRequests).toHaveBeenCalledWith(repository.fullName))

    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { name: 'No open pull requests' })).toBeInTheDocument()
    expect(within(main).getByText(repository.fullName)).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Refresh pull requests' })).toBeInTheDocument()
    expect(within(main).queryByText('Select a pull request to open its walkthrough.')).not.toBeInTheDocument()
  })
})
