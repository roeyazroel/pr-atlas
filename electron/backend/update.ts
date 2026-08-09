import type { UpdateCheckResult } from '../../shared/contracts.js'
import { commandRunner, type CommandRunner } from './github.js'

/** Authenticated GitHub API path resolved through `gh` (avoids anonymous rate limits). */
export const DEFAULT_UPDATE_API_PATH = 'repos/roeyazroel/pr-atlas/releases/latest'
const RELEASE_PATH_PREFIX = '/roeyazroel/pr-atlas/releases/tag/'
const MAX_RELEASE_BODY_BYTES = 1_000_000

type ParsedVersion = { core: [number, number, number]; prerelease: string[] }

/** Parses a strict semver-ish version string used by PR Atlas release tags. */
function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

/** Compares a single prerelease identifier per semver rules. */
function compareIdentifier(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

/** Compares two version strings; returns null when either side is unparsable. */
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

/** Strips a leading `v` and build metadata while keeping a parseable core version. */
function normalizedVersion(value: string): string | null {
  return parseVersion(value) ? value.trim().replace(/^v/, '').replace(/\+.*/, '') : null
}

/** Accepts only the canonical HTTPS release page for this repository and tag. */
function safeReleaseUrl(value: unknown, tagName: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const expectedPath = `${RELEASE_PATH_PREFIX}${tagName}`
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === expectedPath ? url.toString() : null
  } catch { return null }
}

export interface UpdateCheckOptions {
  /** Injectable command runner; production uses authenticated `gh`. */
  runner?: CommandRunner
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

/** Validates installer file names before using them in download paths. */
export function safeArtifactName(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_NAME.test(value) && value !== '.' && value !== '..' && !value.includes('..\\')
}

/** Validates GitHub release asset digests in the `sha256:<hex>` form. */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

/** Builds the exact release-matrix artifact name for a platform/arch pair. */
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

/** Accepts only the canonical HTTPS GitHub release download URL for an artifact. */
export function safeArtifactUrl(value: unknown, version: string, name: string): string | null {
  if (typeof value !== 'string' || !safeArtifactName(name)) return null
  try {
    const url = new URL(value)
    const expectedPath = `${REPOSITORY_PATH}/releases/download/v${version}/${name}`
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) return null
    return url.toString()
  } catch { return null }
}

/** Picks the matching platform installer when name, URL, and digest are all safe. */
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

/**
 * Checks for a newer desktop release through authenticated `gh api`.
 * Fails closed on auth/CLI errors, malformed payloads, or unsafe asset metadata.
 */
export async function checkForUpdate(currentVersion: string, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString()
  const current = normalizedVersion(currentVersion)
  const failed = (): UpdateCheckResult => ({ currentVersion: current ?? currentVersion, available: false, checkedAt, error: 'Could not check for a newer release.' })
  if (!current) return failed()

  try {
    const { stdout } = await (options.runner ?? commandRunner).run('gh', ['api', DEFAULT_UPDATE_API_PATH], {
      timeout: options.timeoutMs ?? 5_000,
    })
    if (typeof stdout !== 'string' || stdout.length > MAX_RELEASE_BODY_BYTES) return failed()
    const release = JSON.parse(stdout) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
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
}
