// @vitest-environment node

import { readFile, stat, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('production index references local assets relatively for Electron file URLs', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'pr-atlas-vite-'))

  await build({
    configFile: join(repoRoot, 'vite.config.ts'),
    root: repoRoot,
    build: {
      emptyOutDir: true,
      outDir: outputDir,
    },
  })

  const indexPath = join(outputDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  const assetUrls = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(
    ([, url]) => url,
  )

  expect(assetUrls.length).toBeGreaterThan(0)

  const indexUrl = pathToFileURL(indexPath)
  for (const assetUrl of assetUrls) {
    expect(assetUrl).toMatch(/^\.\//)

    const resolvedAssetUrl = new URL(assetUrl, indexUrl)
    expect(resolvedAssetUrl.protocol).toBe('file:')
    await expect(stat(fileURLToPath(resolvedAssetUrl))).resolves.toBeDefined()
  }
})
