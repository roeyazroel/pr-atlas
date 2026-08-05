import type { UpdateCheckResult } from '../../shared/contracts.js'

export const DEFAULT_UPDATE_FEED_URL = 'https://api.github.com/repos/roeyazroel/pr-atlas/releases/latest'
const RELEASE_PATH_PREFIX = '/roeyazroel/pr-atlas/releases/tag/'

type ParsedVersion = { core: [number, number, number]; prerelease: string[] }

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index])
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const compared = compareIdentifier(a.prerelease[index], b.prerelease[index])
    if (compared !== 0) return compared
  }
  return 0
}

function normalizedVersion(value: string): string | null {
  return parseVersion(value) ? value.trim().replace(/^v/, '').replace(/\+.*/, '') : null
}

function safeReleaseUrl(value: unknown, tagName: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const expectedPath = `${RELEASE_PATH_PREFIX}${tagName}`
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === expectedPath ? url.toString() : null
  } catch { return null }
}

function allowedFeedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.toString() === DEFAULT_UPDATE_FEED_URL) return true
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch { return false }
}

export interface UpdateCheckOptions {
  fetcher?: typeof fetch
  feedUrl?: string
  timeoutMs?: number
  /** The target runtime is explicit so checks can be tested without mutating process globals. */
  platform?: NodeJS.Platform
  arch?: string
}

interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
  digest?: unknown
}

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/
const REPOSITORY_PATH = '/roeyazroel/pr-atlas'

export function safeArtifactName(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_NAME.test(value) && value !== '.' && value !== '..' && !value.includes('..\\')
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function expectedAssetName(version: string, platform: NodeJS.Platform, arch: string, fallbackDeb = false): string | null {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : null
  if (!os) return null
  if (platform === 'darwin' && arch !== 'x64' && arch !== 'arm64') return null
  if (platform === 'win32' && arch !== 'x64') return null
  if (platform === 'linux' && arch !== 'x64') return null
  if (platform === 'linux') {
    return fallbackDeb ? `PR-Atlas-${version}-linux-amd64.deb` : `PR-Atlas-${version}-linux-x86_64.AppImage`
  }
  const extension = platform === 'darwin' ? 'dmg' : 'exe'
  return `PR-Atlas-${version}-${os}-${arch}.${extension}`
}

export function safeArtifactUrl(value: unknown, version: string, name: string): string | null {
  if (typeof value !== 'string' || !safeArtifactName(name)) return null
  try {
    const url = new URL(value)
    const expectedPath = `${REPOSITORY_PATH}/releases/download/v${version}/${name}`
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) return null
    return url.toString()
  } catch { return null }
}

function selectAsset(assets: unknown, version: string, platform: NodeJS.Platform, arch: string): { name: string; downloadUrl: string; digest: string } | null {
  if (!Array.isArray(assets)) return null
  const candidates = assets.filter((asset): asset is ReleaseAsset => Boolean(asset && typeof asset === 'object'))
  const names = platform === 'linux'
    ? [expectedAssetName(version, platform, arch), expectedAssetName(version, platform, arch, true)]
    : [expectedAssetName(version, platform, arch)]
  for (const expected of names) {
    if (!expected) continue
    const asset = candidates.find((candidate) => candidate.name === expected)
    if (!asset) continue
    if (!safeArtifactName(asset.name)) return null
    const downloadUrl = safeArtifactUrl(asset.browser_download_url, version, asset.name)
    if (!downloadUrl || !isSha256Digest(asset.digest)) return null
    return { name: asset.name, downloadUrl, digest: asset.digest }
  }
  return null
}

export async function checkForUpdate(currentVersion: string, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString()
  const current = normalizedVersion(currentVersion)
  const feedUrl = options.feedUrl ?? DEFAULT_UPDATE_FEED_URL
  const failed = (): UpdateCheckResult => ({ currentVersion: current ?? currentVersion, available: false, checkedAt, error: 'Could not check for a newer release.' })
  if (!current || !allowedFeedUrl(feedUrl)) return failed()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const response = await (options.fetcher ?? fetch)(feedUrl, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `PR-Atlas/${current}` },
      signal: controller.signal,
    })
    if (!response.ok) return failed()
    const body = await response.text()
    if (body.length > 1_000_000) return failed()
    const release = JSON.parse(body) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
    const rawTag = typeof release.tag_name === 'string' ? release.tag_name.trim() : null
    const latest = rawTag ? normalizedVersion(rawTag) : null
    const releaseUrl = rawTag ? safeReleaseUrl(release.html_url, rawTag) : null
    const compared = latest ? compareVersions(latest, current) : null
    if (!latest || !releaseUrl || compared === null || release.draft === true) return failed()
    if (compared <= 0) return { currentVersion: current, latestVersion: latest, available: false, checkedAt }
    const selected = options.platform && options.arch ? selectAsset(release.assets, latest, options.platform, options.arch) : null
    if (options.platform && options.arch && !selected) return failed()
    return {
      currentVersion: current,
      latestVersion: latest,
      available: true,
      releaseUrl,
      ...(selected ? { downloadUrl: selected.downloadUrl, artifactName: selected.name, digest: selected.digest } : {}),
      checkedAt,
    }
  } catch { return failed() }
  finally { clearTimeout(timer) }
}
