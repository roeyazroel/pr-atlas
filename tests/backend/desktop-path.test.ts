import { describe, expect, it, vi } from 'vitest'
import { discoverNvmVersionBinPaths, normalizeDesktopPath } from '../../electron/backend/desktop-path'

describe('desktop PATH normalization', () => {
  it('adds macOS CLI locations ahead of an undefined PATH', () => {
    expect(normalizeDesktopPath(undefined, 'darwin')).toBe('/opt/homebrew/bin:/usr/local/bin')
  })

  it('prepends only missing macOS CLI locations while preserving PATH order', () => {
    expect(normalizeDesktopPath('/usr/bin:/usr/local/bin:/bin', 'darwin')).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin')
    expect(normalizeDesktopPath('/usr/bin:/opt/homebrew/bin:/bin', 'darwin')).toBe('/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin')
    expect(normalizeDesktopPath('/usr/local/bin:/usr/bin:/opt/homebrew/bin', 'darwin')).toBe('/usr/local/bin:/usr/bin:/opt/homebrew/bin')
  })

  it('does not duplicate existing PATH entries when normalizing macOS PATH', () => {
    expect(normalizeDesktopPath('/usr/bin:/usr/bin:/usr/local/bin:/usr/bin', 'darwin')).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin')
  })

  it('returns non-macOS PATH values unchanged and defaults undefined to an empty string', () => {
    expect(normalizeDesktopPath('/custom/bin:/usr/bin', 'linux')).toBe('/custom/bin:/usr/bin')
    expect(normalizeDesktopPath('/custom/bin:/usr/bin', 'win32')).toBe('/custom/bin:/usr/bin')
    expect(normalizeDesktopPath(undefined, 'linux')).toBe('')
  })

  it('adds the user local bin and newest-first NVM bins on macOS', () => {
    const homePath = '/Users/alice'
    expect(normalizeDesktopPath('/usr/bin', 'darwin', {
      homePath,
      nvmVersionPaths: [
        `${homePath}/.nvm/versions/node/v20.9.0/bin`,
        `${homePath}/.nvm/versions/node/v22.1.0/bin`,
        `${homePath}/.nvm/versions/node/v20.10.0/bin`,
      ],
    })).toBe([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${homePath}/.local/bin`,
      '/usr/bin',
      `${homePath}/.nvm/versions/node/v22.1.0/bin`,
      `${homePath}/.nvm/versions/node/v20.10.0/bin`,
      `${homePath}/.nvm/versions/node/v20.9.0/bin`,
    ].join(':'))
  })

  it('deduplicates user and NVM bins against existing PATH entries', () => {
    const homePath = '/Users/alice'
    const localBin = `${homePath}/.local/bin`
    const nvmBin = `${homePath}/.nvm/versions/node/v22.1.0/bin`
    expect(normalizeDesktopPath(`${localBin}:${nvmBin}:${nvmBin}:/usr/bin`, 'darwin', {
      homePath,
      nvmVersionPaths: [nvmBin, nvmBin],
    })).toBe(`/opt/homebrew/bin:/usr/local/bin:${localBin}:${nvmBin}:/usr/bin`)
  })

  it('keeps an existing user-local CLI ahead of a discovered NVM fallback bin', () => {
    const homePath = '/Users/alice'
    const localBin = `${homePath}/.local/bin`
    const olderNvmBin = `${homePath}/.nvm/versions/node/v20.13.1/bin`

    expect(normalizeDesktopPath(`${localBin}:/usr/bin`, 'darwin', {
      homePath,
      nvmVersionPaths: [olderNvmBin],
    })).toBe([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      localBin,
      '/usr/bin',
      olderNvmBin,
    ].join(':'))
  })

  it('discovers readable NVM version bins, ignores failures, and sorts semver versions newest first', () => {
    const homePath = '/Users/alice'
    const nodeRoot = `${homePath}/.nvm/versions/node`
    const readable = new Set([
      `${nodeRoot}/v18.20.4/bin`,
      `${nodeRoot}/v20.10.0/bin`,
      `${nodeRoot}/v20.9.0/bin`,
    ])
    const readDirectory = vi.fn((directory: string): string[] => {
      if (directory === nodeRoot) return ['v18.20.4', 'v20.9.0', 'v22.1.0', 'v20.10.0', 'not-a-version']
      if (readable.has(directory)) return []
      throw new Error('unreadable')
    })

    expect(discoverNvmVersionBinPaths(homePath, readDirectory)).toEqual([
      `${nodeRoot}/v20.10.0/bin`,
      `${nodeRoot}/v20.9.0/bin`,
      `${nodeRoot}/v18.20.4/bin`,
    ])
    expect(readDirectory).toHaveBeenCalledWith(nodeRoot)
  })

  it('returns no discovered NVM bins when the version directory is missing or unreadable', () => {
    const readDirectory = vi.fn(() => { throw new Error('missing') })
    expect(discoverNvmVersionBinPaths('/Users/alice', readDirectory)).toEqual([])
  })
})
