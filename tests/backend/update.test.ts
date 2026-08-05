import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, compareVersions } from '../../electron/backend/update'
import { downloadUpdateArtifact } from '../../electron/backend/update-download'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('desktop release update checks', () => {
  it('compares semantic versions including prereleases without lexical mistakes', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0-rc.2', '2.0.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('not-a-version', '2.0.0')).toBeNull()
  })

  it('reports a newer GitHub release with a safe release URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v9.4.0',
      html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
      draft: false,
      prerelease: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await checkForUpdate('0.1.0', { fetcher })

    expect(result).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '9.4.0',
      available: true,
      releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
    })
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/api\.github\.com\/repos\/roeyazroel\/pr-atlas\/releases\/latest/), expect.objectContaining({ method: 'GET' }))
  })

  it('selects the platform installer and returns only a safe GitHub download URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v9.4.0',
      html_url: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'PR-Atlas-9.4.0-mac-arm64.dmg', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-arm64.dmg' },
        { name: 'PR-Atlas-9.4.0-mac-x64.dmg', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-x64.dmg' },
        { name: 'PR-Atlas-9.4.0-win-x64.exe', browser_download_url: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-win-x64.exe' },
      ],
    }), { status: 200 }))

    const result = await checkForUpdate('0.1.0', { fetcher, platform: 'darwin', arch: 'arm64' })

    expect(result).toMatchObject({
      available: true,
      artifactName: 'PR-Atlas-9.4.0-mac-arm64.dmg',
      downloadUrl: 'https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/PR-Atlas-9.4.0-mac-arm64.dmg',
    })
  })

  it('fails closed for malformed versions, unsafe links, and remote errors', async () => {
    const unsafe = await checkForUpdate('0.1.0', {
      fetcher: async () => new Response(JSON.stringify({ tag_name: 'v9.4.0', html_url: 'https://attacker.example/release' }), { status: 200 }),
    })
    expect(unsafe).toMatchObject({ currentVersion: '0.1.0', available: false, error: expect.any(String) })
    expect(unsafe).not.toHaveProperty('releaseUrl')

    const failed = await checkForUpdate('0.1.0', { fetcher: async () => new Response('token=do-not-return', { status: 503 }) })
    expect(failed).toMatchObject({ currentVersion: '0.1.0', available: false, error: 'Could not check for a newer release.' })
    expect(JSON.stringify(failed)).not.toContain('do-not-return')
  })

  it('downloads the validated artifact into a collision-safe path and never overwrites an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-mac-arm64.dmg'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`,
      }
      await (await import('node:fs/promises')).writeFile(join(root, artifactName), 'keep me')
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'darwin', arch: 'arm64', fetcher: async () => new Response('new artifact', { status: 200 }) })
      expect(result).toMatchObject({ success: true, artifactName })
      expect(result.path).not.toBe(join(root, artifactName))
      await expect(readFile(join(root, artifactName), 'utf8')).resolves.toBe('keep me')
      await expect(readFile(result.path!, 'utf8')).resolves.toBe('new artifact')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('downloads the explicit Linux deb fallback when no AppImage is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-deb-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-linux-x64.deb'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`,
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'linux', arch: 'x64', fetcher: async () => new Response('deb artifact', { status: 200 }) })
      expect(result).toMatchObject({ success: true, artifactName })
      await expect(readFile(result.path!, 'utf8')).resolves.toBe('deb artifact')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an empty artifact and leaves no downloaded file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-atlas-update-empty-'))
    try {
      const artifactName = 'PR-Atlas-9.4.0-linux-x64.AppImage'
      const update = {
        currentVersion: '0.1.0', latestVersion: '9.4.0', available: true,
        releaseUrl: 'https://github.com/roeyazroel/pr-atlas/releases/tag/v9.4.0', checkedAt: new Date().toISOString(),
        artifactName, downloadUrl: `https://github.com/roeyazroel/pr-atlas/releases/download/v9.4.0/${artifactName}`,
      }
      const result = await downloadUpdateArtifact(update, { downloadsPath: root, platform: 'linux', arch: 'x64', fetcher: async () => new Response('', { status: 200 }) })
      expect(result).toMatchObject({ success: false, error: expect.any(String) })
      await expect(readFile(join(root, artifactName))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
