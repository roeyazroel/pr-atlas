import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, compareVersions, DEFAULT_UPDATE_API_PATH } from '../../electron/backend/update'
import { downloadUpdateArtifact, openDownloadedArtifact } from '../../electron/backend/update-download'
import type { CommandRunner } from '../../electron/backend/github'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const digestFor = (body: string): string => `sha256:${createHash('sha256').update(body).digest('hex')}`
const VALID_DIGEST = `sha256:${'a'.repeat(64)}`

/** Builds a CommandRunner that returns a fixed `gh api` release payload. */
function ghReleaseRunner(payload: unknown, options: { throwMessage?: string; stdout?: string } = {}): CommandRunner {
  return {
    run: vi.fn(async (file, args) => {
      expect(file).toBe('gh')
      expect(args).toEqual(['api', DEFAULT_UPDATE_API_PATH])
      if (options.throwMessage) throw new Error(options.throwMessage)
      return { stdout: options.stdout ?? JSON.stringify(payload) }
    }),
  }
}

describe('desktop release update checks', () => {
  it('compares semantic versions including prereleases without lexical mistakes', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0-rc.2', '2.0.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('not-a-version', '2.0.0')).toBeNull()
  })

  it('reports a newer GitHub release with a safe release URL through gh api', async () => {
    const runner = ghReleaseRunner({
      tag_name: 'v9.4.0',
      html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
      draft: false,
      prerelease: false,
    })

    const result = await checkForUpdate('0.1.0', { runner })

    expect(result).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '9.4.0',
      available: true,
      releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
    })
    expect(runner.run).toHaveBeenCalledWith('gh', ['api', DEFAULT_UPDATE_API_PATH], expect.objectContaining({ timeout: 5_000 }))
  })

  it('selects the platform installer and returns only a safe GitHub download URL', async () => {
    const runner = ghReleaseRunner({
      tag_name: 'v9.4.0',
      html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'PR-Atlas-9.4.0-mac-arm64.dmg', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-arm64.dmg', digest: VALID_DIGEST },
        { name: 'PR-Atlas-9.4.0-mac-x64.dmg', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-x64.dmg', digest: VALID_DIGEST },
        { name: 'PR-Atlas-9.4.0-win-x64.exe', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-win-x64.exe', digest: VALID_DIGEST },
      ],
    })

    const result = await checkForUpdate('0.1.0', { runner, platform: 'darwin', arch: 'arm64' })

    expect(result).toMatchObject({
      available: true,
      artifactName: 'PR-Atlas-9.4.0-mac-arm64.dmg',
      downloadUrl: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-arm64.dmg',
      digest: VALID_DIGEST,
    })
  })

  it('fails closed for malformed versions, unsafe links, and gh errors without leaking stdout', async () => {
    const unsafe = await checkForUpdate('0.1.0', {
      runner: ghReleaseRunner({ tag_name: 'v9.4.0', html_url: 'https://attacker.example/release' }),
    })
    expect(unsafe).toMatchObject({ currentVersion: '0.1.0', available: false, error: expect.any(String) })
    expect(unsafe).not.toHaveProperty('releaseUrl')

    const failed = await checkForUpdate('0.1.0', {
      runner: ghReleaseRunner(null, { throwMessage: 'token=do-not-return HTTP 403' }),
    })
    expect(failed).toMatchObject({ currentVersion: '0.1.0', available: false, error: 'Could not check for a newer release.' })
    expect(JSON.stringify(failed)).not.toContain('do-not-return')
  })

  it('fails closed when gh returns an oversized release payload', async () => {
    const oversized = `${'{"tag_name":"v9.4.0","html_url":"https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0","draft":false,"assets":['}${'0'.repeat(1_000_001)}`
    const result = await checkForUpdate('0.1.0', { runner: ghReleaseRunner(null, { stdout: oversized }) })
    expect(result).toMatchObject({ available: false, error: 'Could not check for a newer release.' })
  })

  it('selects the release-matrix Linux x86_64 AppImage for x64', async () => {
    const artifactName = 'PR-Atlas-9.4.0-linux-x86_64.AppImage'
    const runner = ghReleaseRunner({
      tag_name: 'v9.4.0', html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', draft: false,
      assets: [{ name: artifactName, browser_download_url: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: VALID_DIGEST }],
    })
    await expect(checkForUpdate('0.1.0', { runner, platform: 'linux', arch: 'x64' })).resolves.toMatchObject({ available: true, artifactName, digest: VALID_DIGEST })
  })

  it('fails closed when the selected asset digest is missing or malformed', async () => {
    const artifactName = 'PR-Atlas-9.4.0-linux-x86_64.AppImage'
    const fallbackName = 'PR-Atlas-9.4.0-linux-amd64.deb'
    for (const digest of [undefined, 'sha256:ABC', `sha256:${'a'.repeat(63)}g`]) {
      const runner = ghReleaseRunner({
        tag_name: 'v9.4.0', html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', draft: false,
        assets: [
          { name: artifactName, browser_download_url: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, ...(digest === undefined ? {} : { digest }) },
          { name: fallbackName, browser_download_url: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${fallbackName}`, digest: VALID_DIGEST },
        ],
      })
      await expect(checkForUpdate('0.1.0', { runner, platform: 'linux', arch: 'x64' })).resolves.toMatchObject({ available: false, error: expect.any(String) })
    }
  })

  it('downloads the validated artifact into a collision-safe path and never overwrites an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const body = 'new artifact'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: digestFor(body),
      }
      await (await import('node:fs/promises')).writeFile(join(root, artifactName), 'keep me')
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'darwin', arch: 'arm64', fetcher: async () => new Response(body, { status: 200 }) })
      expect(result).toMatchObject({ success: true, artifactName })
      expect(result.path).not.toBe(join(root, artifactName))
      await expect(readFile(join(root, artifactName), 'utf8')).resolves.toBe('keep me')
      await expect(readFile(result.path!, 'utf8')).resolves.toBe(body)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reports monotonic byte and percentage progress while streaming an installer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-progress-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const first = new TextEncoder().encode('first half')
      const second = new TextEncoder().encode('second half')
      const body = Buffer.concat([first, second])
      const progress: Array<{ downloadedBytes: number; totalBytes?: number; percent?: number }> = []
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(first); controller.enqueue(second); controller.close() },
      })

      const result = await downloadUpdateArtifact(update, {
        downloadsPath: root,
        platform: 'darwin',
        arch: 'arm64',
        fetcher: async () => new Response(stream, { status: 200, headers: { 'content-length': String(body.byteLength) } }),
        onProgress: (event) => progress.push(event),
      })

      expect(result).toMatchObject({ success: true, artifactName })
      expect(progress[0]).toEqual({ downloadedBytes: 0, totalBytes: body.byteLength, percent: 0 })
      expect(progress.at(-1)).toEqual({ downloadedBytes: body.byteLength, totalBytes: body.byteLength, percent: 100 })
      expect(progress.some((event) => event.percent && event.percent > 0 && event.percent < 100)).toBe(true)
      expect(progress.map((event) => event.downloadedBytes)).toEqual([...progress].map((event) => event.downloadedBytes).sort((a, b) => a - b))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails and removes the partial installer when the response body stalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-stall-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: VALID_DIGEST,
      }
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) } })

      const result = await downloadUpdateArtifact(update, {
        downloadsPath: root,
        platform: 'darwin',
        arch: 'arm64',
        stallTimeoutMs: 20,
        fetcher: async () => new Response(stream, { status: 200, headers: { 'content-length': '100' } }),
      })

      expect(result).toEqual({ success: false, error: 'Could not download the update.' })
      await expect(readdir(root)).resolves.toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('aborts the response signal when a post-header validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-abort-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: VALID_DIGEST,
      }
      const captured: { signal?: AbortSignal } = {}
      const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) captured.signal = init.signal
        return new Response('too large', { status: 200, headers: { 'content-length': '100' } })
      }

      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'darwin', arch: 'arm64', maxBytes: 10, fetcher })

      expect(result).toEqual({ success: false, error: 'Could not download the update.' })
      expect(captured.signal?.aborted).toBe(true)
      await expect(readdir(root)).resolves.toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not overwrite a target created after collision checking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-race-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const body = 'new artifact'
      const target = join(root, artifactName)
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: digestFor(body),
      }
      const fetcher = async () => {
        await writeFile(target, 'created by another process')
        return new Response(body, { status: 200 })
      }

      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'darwin', arch: 'arm64', fetcher })

      expect(result).toMatchObject({ success: true, artifactName })
      expect(result.path).not.toBe(target)
      await expect(readFile(target, 'utf8')).resolves.toBe('created by another process')
      await expect(readFile(result.path!, 'utf8')).resolves.toBe(body)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('downloads the explicit Linux deb fallback when no AppImage is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-deb-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-linux-amd64.deb'
      const body = 'deb artifact'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: digestFor(body),
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'linux', arch: 'x64', fetcher: async () => new Response(body, { status: 200 }) })
      expect(result).toMatchObject({ success: true, artifactName })
      await expect(readFile(result.path!, 'utf8')).resolves.toBe(body)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an empty artifact and leaves no downloaded file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-empty-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-linux-x86_64.AppImage'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: digestFor(''),
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'linux', arch: 'x64', fetcher: async () => new Response('', { status: 200 }) })
      expect(result).toMatchObject({ success: false, error: expect.any(String) })
      await expect(readFile(join(root, artifactName))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a digest mismatch and leaves no temporary or target artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-mismatch-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-linux-x86_64.AppImage'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: VALID_DIGEST,
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'linux', arch: 'x64', fetcher: async () => new Response('wrong bytes', { status: 200 }) })
      expect(result).toMatchObject({ success: false, error: expect.any(String) })
      await expect(readdir(root)).resolves.toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses to open an artifact that was tampered with after download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-tamper-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const body = 'verified bytes'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`, digest: digestFor(body),
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'darwin', arch: 'arm64', fetcher: async () => new Response(body, { status: 200 }) })
      await writeFile(result.path!, 'tampered bytes')
      const openPath = vi.fn(async () => '')
      await expect(openDownloadedArtifact(result.path!, digestFor(body), openPath)).resolves.toBe(false)
      expect(openPath).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
