import { copyFile, lstat, open, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { UpdateCheckResult, UpdateDownloadProgress, UpdateDownloadResult } from '../../shared/contracts.js'
import { compareVersions, expectedAssetName, isSha256Digest, safeArtifactName, safeArtifactUrl } from './update.js'

const DEFAULT_MAX_UPDATE_BYTES = 1_024 * 1_024 * 1_024
const DEFAULT_UPDATE_STALL_TIMEOUT_MS = 30_000
const UNKNOWN_TOTAL_PROGRESS_INTERVAL = 256 * 1024
const SAFE_REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'release-assets.githubusercontent.com'])
const GENERIC_DOWNLOAD_ERROR = 'Could not download the update.'

interface UpdateDownloadOptions {
  downloadsPath: string
  platform: NodeJS.Platform
  arch: string
  fetcher?: typeof fetch
  maxBytes?: number
  onProgress?: (event: UpdateDownloadProgress) => void
  stallTimeoutMs?: number
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

function parseContentLength(value: string | null, maxBytes: number): number | undefined {
  if (value === null) return undefined
  const candidate = value.trim()
  if (!/^\d+$/.test(candidate)) throw new Error('Invalid update content length.')
  const parsed = Number(candidate)
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid update content length.')
  if (parsed > maxBytes) throw new Error('Update exceeds the maximum size.')
  return parsed
}

function normalizedStallTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_UPDATE_STALL_TIMEOUT_MS
}

async function withStallTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout() } catch { /* Aborting is best effort; the timeout still fails closed. */ }
      reject(new Error('Update download stalled.'))
    }, timeoutMs)
  })
  try { return await Promise.race([operation, timeout]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

interface ProgressReporter {
  initial(): void;
  update(downloadedBytes: number): void;
  complete(downloadedBytes: number): void;
}

function createProgressReporter(totalBytes: number | undefined, onProgress: ((event: UpdateDownloadProgress) => void) | undefined): ProgressReporter {
  let lastPercent: number | undefined
  let lastUnknownBytes = 0
  const emit = (downloadedBytes: number, percent?: number) => {
    if (!onProgress) return
    const event: UpdateDownloadProgress = { downloadedBytes }
    if (totalBytes !== undefined) {
      event.totalBytes = totalBytes
      event.percent = percent
    }
    try { onProgress(event) } catch { /* Progress listeners must never change download outcome. */ }
  }
  return {
    initial() {
      lastPercent = 0
      lastUnknownBytes = 0
      emit(0, totalBytes === undefined ? undefined : 0)
    },
    update(downloadedBytes) {
      if (totalBytes !== undefined) {
        const percent = totalBytes > 0
          ? Math.max(0, Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)))
          : 0
        if (percent === lastPercent) return
        lastPercent = percent
        emit(downloadedBytes, percent)
        return
      }
      if (downloadedBytes - lastUnknownBytes < UNKNOWN_TOTAL_PROGRESS_INTERVAL) return
      lastUnknownBytes = downloadedBytes
      emit(downloadedBytes)
    },
    complete(downloadedBytes) {
      if (totalBytes !== undefined) {
        if (lastPercent === 100) return
        lastPercent = 100
        emit(downloadedBytes, 100)
        return
      }
      if (downloadedBytes === lastUnknownBytes) return
      lastUnknownBytes = downloadedBytes
      emit(downloadedBytes)
    },
  }
}

interface WriteResponseOptions {
  maxBytes: number;
  stallTimeoutMs: number;
  controller: AbortController;
  progress: ProgressReporter;
}

async function writeResponse(response: Response, temporaryPath: string, options: WriteResponseOptions): Promise<{ bytes: number; digest: string }> {
  const file = await open(temporaryPath, 'wx')
  let total = 0
  const hash = createHash('sha256')
  try {
    if (response.body) {
      const reader = response.body.getReader()
      let lastDataAt = Date.now()
      try {
        while (true) {
          const remainingTimeout = Math.max(1, options.stallTimeoutMs - (Date.now() - lastDataAt))
          const next = await withStallTimeout(reader.read(), remainingTimeout, () => {
            options.controller.abort()
            void reader.cancel().catch(() => undefined)
          })
          if (next.done) break
          const chunk = Buffer.from(next.value)
          if (chunk.byteLength === 0) {
            if (Date.now() - lastDataAt >= options.stallTimeoutMs) {
              options.controller.abort()
              void reader.cancel().catch(() => undefined)
              throw new Error('Update download stalled.')
            }
            continue
          }
          lastDataAt = Date.now()
          total += chunk.byteLength
          if (total > options.maxBytes) throw new Error('Update exceeds the maximum size.')
          hash.update(chunk)
          await file.write(chunk)
          options.progress.update(total)
        }
      } finally {
        try { reader.releaseLock() } catch { /* A stalled reader may already have been released by the stream. */ }
      }
    } else {
      const body = Buffer.from(await withStallTimeout(response.arrayBuffer(), options.stallTimeoutMs, () => options.controller.abort()))
      if (body.byteLength > options.maxBytes) throw new Error('Update exceeds the maximum size.')
      total = body.byteLength
      hash.update(body)
      await file.write(body)
      options.progress.update(total)
    }
    await file.sync()
  } finally { await file.close() }
  return { bytes: total, digest: `sha256:${hash.digest('hex')}` }
}

async function hashRegularFile(path: string): Promise<string | null> {
  try {
    const expected = await lstat(path)
    if (!expected.isFile()) return null
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) return null
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(1024 * 1024)
      while (true) {
        const result = await file.read(buffer, 0, buffer.length, null)
        if (result.bytesRead === 0) break
        hash.update(buffer.subarray(0, result.bytesRead))
      }
      return `sha256:${hash.digest('hex')}`
    } finally { await file.close() }
  } catch { return null }
}

/** Finalizes a verified download without replacing a file created by another process. */
async function finalizeWithoutOverwrite(source: string, target: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_EXCL)
}

/** Downloads only an update result previously validated by checkForUpdate. */
export async function downloadUpdateArtifact(update: UpdateCheckResult, options: UpdateDownloadOptions): Promise<UpdateDownloadResult> {
  const version = update.latestVersion
  const artifactName = update.artifactName
  const platform = options.platform
  const arch = options.arch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPDATE_BYTES
  const stallTimeoutMs = normalizedStallTimeout(options.stallTimeoutMs)
  if (!update.available || !version || !artifactName || !safeArtifactName(artifactName) || !isSha256Digest(update.digest) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return failed()
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
    let target = await chooseTarget(directory, artifactName)
    const temporaryPath = join(directory, `.${artifactName}.${randomUUID()}.part`)
    let temporaryCreated = false
    let targetCreated = false
    const controller = new AbortController()
    let completed = false
    try {
      const response = await withStallTimeout(
        Promise.resolve().then(() => (options.fetcher ?? fetch)(canonicalUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: { Accept: 'application/octet-stream', 'User-Agent': 'PR-Atlas update' },
          signal: controller.signal,
        })),
        stallTimeoutMs,
        () => controller.abort(),
      )
      if (response.status !== 200 || !response.ok) { controller.abort(); return failed() }
      if (response.url && !validRedirect(response.url, canonicalUrl)) { controller.abort(); return failed() }
      const totalBytes = parseContentLength(response.headers.get('content-length'), maxBytes)
      const progress = createProgressReporter(totalBytes, options.onProgress)
      progress.initial()
      temporaryCreated = true
      const written = await writeResponse(response, temporaryPath, {
        maxBytes,
        stallTimeoutMs,
        controller,
        progress,
      })
      if (written.bytes === 0 || written.digest !== update.digest) return failed()
      const temporaryInfo = await stat(temporaryPath)
      if (!temporaryInfo.isFile() || temporaryInfo.size !== written.bytes || temporaryInfo.size > maxBytes) return failed()
      while (true) {
        try {
          await finalizeWithoutOverwrite(temporaryPath, target)
          targetCreated = true
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          target = await chooseTarget(directory, artifactName)
        }
      }
      await unlink(temporaryPath)
      temporaryCreated = false
      const targetInfo = await lstat(target)
      if (!targetInfo.isFile() || targetInfo.size !== written.bytes || await hashRegularFile(target) !== update.digest) return failed()
      progress.complete(written.bytes)
      targetCreated = false
      completed = true
      return { success: true, artifactName, path: target, digest: update.digest }
    } finally {
      if (!completed) controller.abort()
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

export async function openDownloadedArtifact(downloadedPath: string | null, expectedDigest: string | null, openPath: (path: string) => Promise<string>): Promise<boolean> {
  if (!downloadedPath || !isSha256Digest(expectedDigest)) return false
  try {
    return (await hashRegularFile(downloadedPath)) === expectedDigest && (await openPath(downloadedPath)) === ''
  } catch { return false }
}
