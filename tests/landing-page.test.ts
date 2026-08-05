// @vitest-environment node

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd())
const siteRoot = resolve(repoRoot, 'site')
const indexPath = resolve(siteRoot, 'index.html')
const workflowPath = resolve(repoRoot, '.github/workflows/pages.yml')

const readHtml = () => readFile(indexPath, 'utf8')
const readWorkflow = () => readFile(workflowPath, 'utf8')

function referencedUrls(html: string) {
  return [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(
    ([, url]) => url,
  )
}

function localAssetUrls(html: string) {
  return referencedUrls(html).filter((url) =>
    !/^(?:https?:|mailto:|#|data:|javascript:)/i.test(url),
  )
}

function sectionMarkup(html: string, id: string) {
  return html.match(new RegExp(`<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i'))?.[1] ?? ''
}

function visibleText(markup: string) {
  return markup
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('PR Atlas landing page', () => {
  it('keeps the product promise and review narrative visible in static HTML', async () => {
    const html = await readHtml()

    expect(html).toContain('Understand the changed system, not just the changed files.')
    expect(html).toContain('https://github.com/roeyazroel/pr-atlas/releases/latest')
    expect(html).toContain('https://github.com/roeyazroel/pr-atlas')

    for (const anchor of [
      /Files are implementation containers/i,
      /Comprehension before judgment/i,
      /Logical change groups/i,
      /Behavior flows/i,
      /Review insights/i,
      /Test coverage/i,
      /Local-first/i,
      /Explicit provider consent/i,
      /validated UI/i,
      /read-oriented GitHub access/i,
      /automatic approval(?: or code-review)? verdict/i,
      /Codex CLI/i,
      /Cursor Agent/i,
      /Claude Code/i,
    ]) {
      expect(html).toMatch(anchor)
    }
  })

  it('uses semantic landmarks for the page structure', async () => {
    const html = await readHtml()

    expect(html).toMatch(/<header\b/i)
    expect(html).toMatch(/<nav\b/i)
    expect(html).toMatch(/<main\b/i)
    expect(html).toMatch(/<footer\b/i)
    expect(html).toMatch(/<h1\b/i)
    expect((html.match(/<section\b/gi) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('references local assets relatively and has no remote runtime dependencies', async () => {
    const html = await readHtml()
    const urls = referencedUrls(html)

    expect(urls).toEqual(expect.arrayContaining([
      expect.stringMatching(/(?:^|\/)assets\/pr-atlas-overview\.webp$/),
      expect.stringMatching(/(?:^|\/)assets\/pr-atlas-logo\.png$/),
      expect.stringMatching(/(?:^|\/)assets\/(?:favicon\.png|pr-atlas-favicon\.png)$/),
    ]))

    const remoteUrls = urls.filter((url) => /^https?:\/\//i.test(url))
    expect(remoteUrls).toEqual(expect.arrayContaining([
      'https://github.com/roeyazroel/pr-atlas/releases/latest',
      'https://github.com/roeyazroel/pr-atlas',
    ]))
    expect(remoteUrls.every((url) => url.startsWith('https://github.com/roeyazroel/pr-atlas'))).toBe(true)

    const localUrls = urls.filter((url) => !/^(?:https?:|mailto:|#|data:|javascript:)/i.test(url))
    expect(localUrls.every((url) => !url.startsWith('/'))).toBe(true)
    expect(localUrls.every((url) => /^(?:\.\/)?(?:assets\/[^?#]+|styles?\.css(?:[?#].*)?|script\.js(?:[?#].*)?)$/i.test(url))).toBe(true)

    for (const url of localAssetUrls(html)) {
      const localPath = url.split(/[?#]/, 1)[0]
      expect((await stat(resolve(siteRoot, localPath))).isFile()).toBe(true)
    }
  })

  it('ships the referenced static assets with the page', async () => {
    for (const asset of [
      'assets/pr-atlas-overview.webp',
      'assets/pr-atlas-groups.webp',
      'assets/pr-atlas-flows.webp',
      'assets/pr-atlas-demo.mp4',
      'assets/pr-atlas-logo.png',
      'assets/favicon.png',
    ]) {
      const info = await stat(resolve(siteRoot, asset))
      expect(info.isFile()).toBe(true)
    }
  })

  it('shows each supported runtime with a local, accessibly named logo and no repeated command slug', async () => {
    const html = await readHtml()
    const runtimeRow = html.match(/<div\b[^>]*class=["'][^"']*\bruntime-row\b[^"']*["'][^>]*>([\s\S]*?)(?=<section\b|<\/main>)/i)?.[1] ?? ''
    const runtimeText = visibleText(runtimeRow)

    expect(runtimeRow).not.toBe('')
    expect(runtimeText).toMatch(/Codex CLI/i)
    expect(runtimeText).toMatch(/Cursor Agent/i)
    expect(runtimeText).toMatch(/Claude Code/i)

    const logoTags = [...runtimeRow.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => tag)
    expect(logoTags).toHaveLength(3)

    for (const imageTag of logoTags) {
      const logoUrl = imageTag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''
      const accessibleName = imageTag.match(/\b(?:alt|aria-label)\s*=\s*["']([^"']+)["']/i)?.[1]?.trim() ?? ''

      expect(logoUrl).toMatch(/^(?:\.\/)?assets\/[^?#]+$/i)
      expect((await stat(resolve(siteRoot, logoUrl.split(/[?#]/, 1)[0]))).isFile()).toBe(true)
      expect(accessibleName.length).toBeGreaterThan(0)
    }

    // The visible row should show each provider name once; its CLI command
    // slugs must not be repeated as right-aligned labels.
    const providerNamesRemoved = runtimeText.replace(/\b(?:Codex CLI|Cursor Agent|Claude Code)\b/gi, '')
    expect(providerNamesRemoved).not.toMatch(/\b(?:codex|cursor-agent|claude)\b/i)
  })

  it('makes the ordinary-user quickstart a release download and launch path', async () => {
    const html = await readHtml()
    const quickstart = sectionMarkup(html, 'quickstart')
    const quickstartText = visibleText(quickstart)

    expect(quickstart).not.toBe('')
    expect(quickstart).toContain('https://github.com/roeyazroel/pr-atlas/releases/latest')
    expect(quickstartText).toMatch(/download/i)
    expect(quickstartText).toMatch(/latest release/i)
    expect(quickstartText).toMatch(/(?:launch|open|use)\b/i)
    expect(quickstartText).toMatch(/PR Atlas/i)
    expect(quickstartText).not.toMatch(/\bnpm\s+install\b|\bnpm\s+run\s+dev\b/i)

    const developmentSections = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)]
      .map(([, section]) => section)
      .filter((section) => /\bnpm\s+install\b|\bnpm\s+run\s+dev\b/i.test(section))
    expect(developmentSections.every((section) => /contributor|development|extension/i.test(section))).toBe(true)
  })

  it('keeps labelled landmarks and reveal content accessible without JavaScript', async () => {
    const html = await readHtml()
    const css = await readFile(resolve(siteRoot, 'styles.css'), 'utf8')
    const script = await readFile(resolve(siteRoot, 'script.js'), 'utf8')
    const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(([, id]) => id))

    for (const [, labelledBy] of html.matchAll(/aria-labelledby\s*=\s*["']([^"']+)["']/gi)) {
      for (const id of labelledBy.split(/\s+/)) expect(ids.has(id)).toBe(true)
    }

    expect(html).toContain('id="product-title"')
    expect(css).toMatch(/\.reveal\s*\{[^}]*opacity:\s*1[^}]*transform:\s*none/i)
    expect(css).toMatch(/\.motion-ready\s+\.reveal\s*\{[^}]*opacity:\s*0[^}]*transform:/i)
    expect(script).toMatch(/IntersectionObserver[\s\S]*?document\.documentElement\.classList\.add\(['"]motion-ready['"]\)/i)
  })
})

describe('GitHub Pages workflow', () => {
  it('uses official Pages actions, least-privilege permissions, and serialized deploys', async () => {
    const workflow = await readWorkflow()

    for (const action of [
      'actions/checkout@v6',
      'actions/configure-pages@v5',
      'actions/upload-pages-artifact@v4',
      'actions/deploy-pages@v4',
    ]) {
      expect(workflow).toContain(action)
    }

    expect(workflow).toMatch(/permissions:\s*\n(?:\s+[^\n]+\n)*\s+contents:\s*read\b/)
    expect(workflow).toContain('pages: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toMatch(/concurrency:\s*[\s\S]*?group:/)
    expect(workflow).toContain('cancel-in-progress: true')
  })

  it('scopes Pages metadata and deployment permissions to their jobs', async () => {
    const workflow = await readWorkflow()

    expect(workflow).toMatch(/build:[\s\S]*?permissions:\s*\n\s+contents:\s*read\s*\n\s+pages:\s*read\b/)
    expect(workflow).toMatch(/deploy:[\s\S]*?permissions:\s*\n\s+pages:\s*write\s*\n\s+id-token:\s*write\b/)
  })

  it('uploads the static site artifact and deploys that artifact through Pages', async () => {
    const workflow = await readWorkflow()

    expect(workflow).toMatch(/uses:\s*actions\/upload-pages-artifact@[^\n]+\n(?:\s+[^\n]+\n)*\s+path:\s*['"]?\.?\/?site\/?['"]?/)
    expect(workflow).toMatch(/deploy-pages@[\w.-]+/)
    expect(workflow).toMatch(/needs:\s*(?:\n\s+-\s*)?build\b/)
    expect(workflow).toMatch(/environment:\s*\n\s+name:\s*github-pages/)
    expect(workflow).toContain('steps.deployment.outputs.page_url')
  })
})
