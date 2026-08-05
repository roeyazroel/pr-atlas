import { open, lstat, rename, stat, unlink } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UpdateCheckResult } from '../../shared/contracts.js'
import { compareVersions, expectedAssetName, safeArtifactName, safeArtifactUrl } from './update.js'

export const DEFAULT_MAX_UPDATE_BYTES = 1_024 * 1_024 * 1_024
const SAFE_REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'release-assets.githubusercontent.com'])
const GENERIC_DOWNLOAD_ERROR = 'Could not download the update.'

export interface UpdateDownloadOptions {
  downloadsPath: string
  platform: NodeJS.Platform
  arch: string
  fetcher?: typeof fetch
  maxBytes?: number
}

export interface UpdateDownloadResult {
  success: boolean
  artifactName?: string
  path?: string
  error?: string
}

function failed(): UpdateDownloadResult { return { success: false, error: GENERIC_DOWNLOAD_ERROR } }

function validRedirect(value: string, expectedUrl: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !SAFE_REDIRECT_HOSTS.has(url.hostname)) return false
    if (url.hostname === 'github.com') {
      const expected = new URL(expectedUrl)
      return url.pathname === expected.pathname
    }
    return true
  } catch { return false }
}

async function chooseTarget(directory: string, artifactName: string): Promise<string> {
  const parsed = parse(artifactName)
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const name = `${parsed.name}${suffix}${parsed.ext}`
    const candidate = resolve(directory, name)
    try { await lstat(candidate) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('No safe update destination available.')
}

async function writeResponse(response: Response, temporaryPath: string, maxBytes: number): Promise<number> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) throw new Error('Update exceeds the maximum size.')
  }
  const file = await open(temporaryPath, 'wx')
  let total = 0
  try {
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const chunk = Buffer.from(next.value)
          total += chunk.byteLength
          if (total > maxBytes) throw new Error('Update exceeds the maximum size.')
          await file.write(chunk)
        }
      } finally { reader.releaseLock() }
    } else {
      const body = Buffer.from(await response.arrayBuffer())
      if (body.byteLength > maxBytes) throw new Error('Update exceeds the maximum size.')
      total = body.byteLength
      await file.write(body)
    }
    await file.sync()
  } finally { await file.close() }
  return total
}

/** Downloads only an update result previously validated by checkForUpdate. */
export async function downloadUpdateArtifact(update: UpdateCheckResult, options: UpdateDownloadOptions): Promise<UpdateDownloadResult> {
  const version = update.latestVersion
  const artifactName = update.artifactName
  const platform = options.platform
  const arch = options.arch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPDATE_BYTES
  if (!update.available || !version || !artifactName || !safeArtifactName(artifactName) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return failed()
  if (compareVersions(version, version) !== 0) return failed()
  const expected = expectedAssetName(version, platform, arch)
  const fallback = platform === 'linux' ? expectedAssetName(version, platform, arch, true) : null
  if ((!expected || artifactName !== expected) && (!fallback || artifactName !== fallback)) return failed()
  const canonicalUrl = safeArtifactUrl(update.downloadUrl, version, artifactName)
  if (!canonicalUrl) return failed()
  try {
    const directory = resolve(options.downloadsPath)
    const directoryInfo = await stat(directory)
    if (!directoryInfo.isDirectory()) return failed()
    const target = await chooseTarget(directory, artifactName)
    const temporaryPath = join(directory, `.${artifactName}.${randomUUID()}.part`)
    let temporaryCreated = false
    let targetCreated = false
    try {
      const response = await (options.fetcher ?? fetch)(canonicalUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'PR-Atlas update' },
      })
      if (response.status !== 200 || !response.ok) return failed()
      if (response.url && !validRedirect(response.url, canonicalUrl)) return failed()
      temporaryCreated = true
      const bytes = await writeResponse(response, temporaryPath, maxBytes)
      if (bytes === 0) return failed()
      const temporaryInfo = await stat(temporaryPath)
      if (!temporaryInfo.isFile() || temporaryInfo.size !== bytes || temporaryInfo.size > maxBytes) return failed()
      await rename(temporaryPath, target)
      targetCreated = true
      const targetInfo = await stat(target)
      if (!targetInfo.isFile() || targetInfo.size !== bytes) return failed()
      temporaryCreated = false
      targetCreated = false
      return { success: true, artifactName, path: target }
    } finally {
      if (temporaryCreated) {
        try { await unlink(temporaryPath) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (targetCreated) {
        try { await unlink(target) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  } catch { return failed() }
}

export async function openDownloadedArtifact(downloadedPath: string | null, openPath: (path: string) => Promise<string>): Promise<boolean> {
  if (!downloadedPath) return false
  try {
    const info = await lstat(downloadedPath)
    if (!info.isFile()) return false
    return (await openPath(downloadedPath)) === ''
  } catch { return false }
}
