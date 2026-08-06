import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const service = {
    listPullRequestComments: vi.fn(async () => []),
    createPullRequestComment: vi.fn(async () => ({
      id: 1,
      nodeId: 'IC_1',
      body: 'hello',
      author: 'viewer',
      authorAvatarUrl: null,
      authorAssociation: null,
      createdAt: '2026-08-06T12:00:00Z',
      updatedAt: '2026-08-06T12:00:00Z',
      url: 'https://github.com/example/backend/issues/42#issuecomment-1',
      viewerDidAuthor: true,
    })),
  }
  return { handlers, service }
})

vi.mock('../../electron/backend/service.js', () => ({
  AnalysisService: vi.fn(() => mocks.service),
}))

vi.mock('electron', () => ({
  app: {
    whenReady: () => Promise.resolve(),
    getPath: () => '/tmp/pr-atlas',
    getVersion: () => '0.7.0',
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows = vi.fn(() => [])
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() }
    loadURL = vi.fn()
    loadFile = vi.fn()
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn(async () => '') },
}))

describe('main-process pull request comment IPC', () => {
  beforeAll(async () => {
    await import('../../electron/main.js')
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  beforeEach(() => {
    mocks.service.listPullRequestComments.mockClear()
    mocks.service.createPullRequestComment.mockClear()
  })

  afterAll(() => {
    vi.resetModules()
  })

  it('registers narrow handlers that delegate validated payloads', async () => {
    const list = mocks.handlers.get('pr-atlas:list-pr-comments')
    const create = mocks.handlers.get('pr-atlas:create-pr-comment')
    expect(list).toBeTypeOf('function')
    expect(create).toBeTypeOf('function')

    await list?.({}, { repository: 'example/backend', pullNumber: 42 })
    await create?.({}, { repository: 'example/backend', pullNumber: 42, body: '  hello  ' })
    expect(mocks.service.listPullRequestComments).toHaveBeenCalledWith('example/backend', 42)
    expect(mocks.service.createPullRequestComment).toHaveBeenCalledWith('example/backend', 42, '  hello  ')
  })

  it('rejects invalid repository, pull number, and body payloads before service execution', async () => {
    const list = mocks.handlers.get('pr-atlas:list-pr-comments')!
    const create = mocks.handlers.get('pr-atlas:create-pr-comment')!

    for (const payload of [
      { repository: '../secrets', pullNumber: 42 },
      { repository: 'example/backend', pullNumber: 0 },
      { repository: 'example/backend', pullNumber: '42' },
    ]) {
      await expect(list({}, payload)).rejects.toThrow('Invalid pull request comments request.')
    }
    for (const payload of [
      { repository: '../secrets', pullNumber: 42, body: 'secret' },
      { repository: 'example/backend', pullNumber: 0, body: 'secret' },
      { repository: 'example/backend', pullNumber: 42, body: '' },
      { repository: 'example/backend', pullNumber: 42, body: '   ' },
      { repository: 'example/backend', pullNumber: 42, body: 'x'.repeat(65_537) },
    ]) {
      await expect(create({}, payload)).rejects.toThrow('Invalid pull request comment request.')
    }
    expect(mocks.service.listPullRequestComments).not.toHaveBeenCalled()
    expect(mocks.service.createPullRequestComment).not.toHaveBeenCalled()
  })
})
