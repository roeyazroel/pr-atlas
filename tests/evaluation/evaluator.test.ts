// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateCase, evaluateCorpus } from '../../scripts/evaluate-walkthrough.mjs'

const corpusRoot = resolve(process.cwd(), 'evaluation/corpus')

describe('semantic walkthrough evaluation', () => {
  it('scores a semantically aligned walkthrough across every rubric dimension', async () => {
    const fixture = JSON.parse(await readFile(resolve(corpusRoot, 'session-ownership.json'), 'utf8'))

    const result = evaluateCase(fixture)

    expect(result.score).toBe(1)
    expect(result.dimensions).toMatchObject({
      intent: 1,
      changeGroups: 1,
      reviewOrder: 1,
      evidenceTraceability: 1,
      limitations: 1,
      flows: 1,
      testMapping: 1,
      reviewClustering: 1,
      threadStates: 1,
      hallucinationControl: 1,
    })
  })

  it('reports actionable semantic misses instead of accepting schema-valid noise', async () => {
    const fixture = JSON.parse(await readFile(resolve(corpusRoot, 'session-ownership.json'), 'utf8'))
    fixture.actual.summary.intent = 'Update several files.'
    fixture.actual.changeGroups = fixture.actual.changeGroups.slice(0, 1)
    fixture.actual.walkthrough = [...fixture.actual.walkthrough].reverse()
    fixture.actual.summary.limitations = []
    fixture.actual.evidence.push({ id: 'invented', path: 'missing/invented.ts' })
    fixture.actual.changeGroups[0].evidenceIds.push('invented')

    const result = evaluateCase(fixture)

    expect(result.score).toBeLessThan(0.8)
    expect(result.failures.join('\n')).toMatch(/intent|change group|review order|limitation|hallucinated/i)
  })

  it('keeps the checked-in corpus above its declared quality gate', async () => {
    const files = (await readdir(corpusRoot)).filter((file) => file.endsWith('.json')).sort()
    const fixtures = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(corpusRoot, file), 'utf8'))))

    const report = evaluateCorpus(fixtures)

    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(report.passed).toBe(true)
    expect(report.score).toBeGreaterThanOrEqual(report.threshold)
    expect(report.cases.every((item: { failures: string[] }) => item.failures.length === 0)).toBe(true)
  })
})
