import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const MACOS_CLI_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'] as const
const NVM_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

interface SemanticVersion {
  core: [number, number, number]
  prerelease: string[]
}

interface DesktopPathOptions {
  /** Home directory to use for user-installed CLI locations. */
  homePath?: string
  /** Full NVM version bin paths, or version names when homePath is supplied. */
  nvmVersionPaths?: readonly string[]
  /** NVM version names such as v22.1.0, resolved under homePath. */
  nvmVersionNames?: readonly string[]
}

type ReadDirectory = (directory: string) => readonly string[]

function parseVersion(value: string): SemanticVersion | null {
  const match = value.trim().match(NVM_VERSION_PATTERN)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
    if (leftNumber !== null && rightNumber === null) return -1
    if (leftNumber === null && rightNumber !== null) return 1
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function versionNameFromPath(value: string): string {
  const segments = value.replaceAll('\\', '/').split('/').filter(Boolean)
  const binIndex = segments.lastIndexOf('bin')
  return binIndex > 0 ? segments[binIndex - 1] : segments.at(-1) ?? ''
}

/** Sorts valid NVM bin paths newest semantic version first and drops malformed paths. */
function sortNvmVersionBinPaths(paths: readonly string[]): string[] {
  return paths
    .map((path) => ({ path, version: parseVersion(versionNameFromPath(path)) }))
    .filter((candidate): candidate is { path: string; version: SemanticVersion } => candidate.version !== null)
    .sort((left, right) => {
      const versionOrder = compareVersions(right.version, left.version)
      if (versionOrder !== 0) return versionOrder
      return left.path === right.path ? 0 : left.path < right.path ? -1 : 1
    })
    .map(({ path }) => path)
}

/**
 * Discovers readable NVM version bin directories without invoking a shell.
 * Missing or unreadable version roots/bins are ignored and return no entries.
 */
export function discoverNvmVersionBinPaths(homePath: string | undefined, readDirectory: ReadDirectory = (directory) => readdirSync(directory)): string[] {
  if (!homePath) return []
  const nodeRoot = join(homePath, '.nvm', 'versions', 'node')
  let versions: readonly string[]
  try { versions = readDirectory(nodeRoot) } catch { return [] }

  const readableBins: string[] = []
  for (const version of versions) {
    if (!parseVersion(version)) continue
    const binPath = join(nodeRoot, version, 'bin')
    try { readDirectory(binPath); readableBins.push(binPath) } catch { /* Ignore missing or unreadable versions. */ }
  }
  return sortNvmVersionBinPaths(readableBins)
}

function resolvedNvmPaths(options: DesktopPathOptions): string[] {
  const homePath = options.homePath
  const supplied = [...(options.nvmVersionPaths ?? [])]
  if (homePath) {
    for (const version of options.nvmVersionNames ?? []) supplied.push(join(homePath, '.nvm', 'versions', 'node', version, 'bin'))
    for (let index = 0; index < supplied.length; index += 1) {
      if (!supplied[index].includes('/') && !supplied[index].includes('\\')) supplied[index] = join(homePath, '.nvm', 'versions', 'node', supplied[index], 'bin')
    }
  }
  return sortNvmVersionBinPaths(supplied)
}

/**
 * Returns the PATH a GUI-launched desktop process should use.
 *
 * macOS applications launched from Finder or the Dock do not inherit the
 * shell startup PATH, so include conventional system, user-local, and NVM
 * CLI locations. Other platforms retain the supplied PATH unchanged.
 */
export function normalizeDesktopPath(currentPath: string | undefined, platform: string, options: DesktopPathOptions = {}): string {
  if (platform !== 'darwin') return currentPath ?? ''

  const entries = currentPath ? currentPath.split(':').filter(Boolean) : []
  const existing = new Set<string>()
  const preserved = entries.filter((entry) => {
    if (existing.has(entry)) return false
    existing.add(entry)
    return true
  })
  const homePaths = options.homePath ? [join(options.homePath, '.local', 'bin')] : []
  const primaryAdditions = [...MACOS_CLI_PATHS, ...homePaths]
  const nvmFallbacks = resolvedNvmPaths(options)
  const missing = (additions: readonly string[]) => additions.filter(
    (entry, index) => !existing.has(entry) && additions.indexOf(entry) === index,
  )
  const missingPrimary = missing(primaryAdditions)
  const missingNvmFallbacks = missing(nvmFallbacks)
  return entries.length
    ? [...missingPrimary, ...preserved, ...missingNvmFallbacks].join(':')
    : [...missingPrimary, ...missingNvmFallbacks].join(':')
}
