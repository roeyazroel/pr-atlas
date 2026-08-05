import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve(), getPath: () => '/tmp/pr-atlas', on: vi.fn() },
  BrowserWindow: class {
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    loadURL = vi.fn()
    loadFile = vi.fn()
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(async () => '') },
}))

import { openEvidenceInEditor } from '../../electron/main'

describe('main-process evidence opening', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('passes an exact file:line location to the preferred Cursor CLI', async () => {
    vi.stubEnv('PR_ATLAS_EDITOR', 'cursor')
    const launchEditor = vi.fn(async () => true)
    const openPath = vi.fn(async () => '')

    await expect(openEvidenceInEditor('/tmp/worktree/src/App.tsx', 42, { launchEditor, openPath })).resolves.toBe(true)
    expect(launchEditor).toHaveBeenCalledWith('cursor', ['--goto', '/tmp/worktree/src/App.tsx:42'])
    expect(openPath).not.toHaveBeenCalled()
  })

  it('falls back to Electron path opening when supported editor CLIs are unavailable', async () => {
    vi.stubEnv('PR_ATLAS_EDITOR', 'cursor')
    const launchEditor = vi.fn(async () => false)
    const openPath = vi.fn(async () => '')

    await expect(openEvidenceInEditor('/tmp/worktree/src/App.tsx', undefined, { launchEditor, openPath })).resolves.toBe(true)
    expect(launchEditor).toHaveBeenNthCalledWith(1, 'cursor', ['--goto', '/tmp/worktree/src/App.tsx'])
    expect(launchEditor).toHaveBeenNthCalledWith(2, 'code', ['--goto', '/tmp/worktree/src/App.tsx'])
    expect(openPath).toHaveBeenCalledWith('/tmp/worktree/src/App.tsx')
  })
})
