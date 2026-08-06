#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const wordsMatch = (value, words = []) => {
  if (!words.length) return 1
  const text = normalize(value)
  return words.filter((word) => text.includes(normalize(word))).length / words.length
}
const allText = (value) => Object.values(value ?? {}).filter((entry) => typeof entry === 'string').join(' ')
const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value))]
const exactSet = (left = [], right = []) => [...left].sort().join('\0') === [...right].sort().join('\0')

function referencedEvidenceIds(value, key = '') {
  if (Array.isArray(value)) return value.flatMap((entry) => referencedEvidenceIds(entry, key))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([childKey, child]) => {
    if (childKey === 'evidence') return []
    if (childKey === 'evidenceId' && typeof child === 'string') return [child]
    if (childKey === 'evidenceIds' && Array.isArray(child)) return child.filter((entry) => typeof entry === 'string')
    return referencedEvidenceIds(child, childKey)
  })
}

function orderScore(expected, actual) {
  if (!expected.length) return 1
  const positions = expected.map((id) => actual.indexOf(id))
  const present = positions.filter((position) => position >= 0).length / expected.length
  const ordered = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))
  return ordered ? present : present * 0.5
}

export function evaluateCase(fixture) {
  const expected = fixture.expected ?? {}
  const actual = fixture.actual ?? {}
  const groups = Array.isArray(actual.changeGroups) ? actual.changeGroups : []
  const steps = Array.isArray(actual.walkthrough) ? actual.walkthrough : []
  const evidence = Array.isArray(actual.evidence) ? actual.evidence : []
  const summary = actual.summary ?? {}

  const intent = wordsMatch(summary.intent, expected.intentKeywords)
  const expectedGroups = expected.changeGroups ?? []
  const groupScores = expectedGroups.map((target) => {
    const group = groups.find((candidate) => candidate.id === target.id)
      ?? groups.find((candidate) => wordsMatch(candidate.title, target.titleKeywords) === 1)
    return group ? wordsMatch(allText(group), target.contentKeywords) : 0
  })
  const changeGroups = expectedGroups.length ? groupScores.reduce((sum, score) => sum + score, 0) / expectedGroups.length : 1
  const reviewOrder = orderScore(expected.reviewOrder ?? [], steps.map((step) => step.changeGroupId))

  const referencedEvidence = new Set(unique([
    ...groups.flatMap((group) => group.evidenceIds ?? []),
    ...steps.flatMap((step) => step.evidenceIds ?? []),
  ]))
  const expectedPaths = expected.evidencePaths ?? []
  const evidenceTraceability = expectedPaths.length ? expectedPaths.filter((path) => {
    const item = evidence.find((candidate) => candidate.path === path)
    return item && referencedEvidence.has(item.id)
  }).length / expectedPaths.length : 1

  const limitationText = (summary.limitations ?? []).join(' ')
  const limitations = wordsMatch(limitationText, expected.limitationKeywords)
  const graphs = actual.graphs ?? {}
  const expectedEdges = expected.flowEdges ?? []
  const flows = expectedEdges.length ? expectedEdges.filter((target) => {
    const graph = Object.values(graphs).find((candidate) => candidate?.id === target.graph) ?? graphs[target.graph]
    return graph?.edges?.some((edge) => edge.source === target.source && edge.target === target.target && wordsMatch(edge.label, target.labelKeywords) === 1)
  }).length / expectedEdges.length : 0

  const expectedTests = expected.tests ?? []
  const actualTests = actual.tests ?? []
  const testMapping = expectedTests.length ? expectedTests.filter((target) => actualTests.some((test) =>
    (test.id === target.id || wordsMatch(test.title, target.titleKeywords) === 1)
      && test.status === target.status
      && (test.changeGroupIds ?? []).includes(target.changeGroupId)
      && wordsMatch(test.behavior, target.behaviorKeywords) === 1,
  )).length / expectedTests.length : 0

  const expectedClusters = expected.reviewClusters ?? []
  const actualInsights = actual.reviewInsights ?? []
  const reviewClustering = expectedClusters.length ? expectedClusters.filter((target) => actualInsights.some((insight) =>
    insight.status === target.status && exactSet(insight.reviewThreadIds, target.threadIds),
  )).length / expectedClusters.length : 0

  const expectedStates = expected.threadStates ?? {}
  const actualThreads = actual.reviewThreads ?? []
  const stateEntries = Object.entries(expectedStates)
  const threadStates = stateEntries.length ? stateEntries.filter(([id, status]) => actualThreads.some((thread) => thread.id === id && thread.status === status)).length / stateEntries.length : 0

  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const allowedPaths = new Set(expected.allowedEvidencePaths ?? expectedPaths)
  const allReferences = unique(referencedEvidenceIds(actual))
  const safeReferences = allReferences.filter((id) => {
    const item = evidenceById.get(id)
    return item && allowedPaths.has(item.path)
  })
  const hallucinationControl = allReferences.length ? safeReferences.length / allReferences.length : 0

  const dimensions = { intent, changeGroups, reviewOrder, evidenceTraceability, limitations, flows, testMapping, reviewClustering, threadStates, hallucinationControl }
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0) / Object.keys(dimensions).length
  const failures = []
  if (intent < 1) failures.push('Intent omitted expected concepts.')
  if (changeGroups < 1) failures.push('One or more expected change groups were missing or incoherent.')
  if (reviewOrder < 1) failures.push('Recommended review order did not preserve the expected dependency sequence.')
  if (evidenceTraceability < 1) failures.push('Expected evidence was missing or not linked from the walkthrough.')
  if (limitations < 1) failures.push('Expected analysis limitations were not disclosed.')
  if (flows < 1) failures.push('Expected flow relationships were missing or inaccurate.')
  if (testMapping < 1) failures.push('Expected behavior-to-test mappings were missing or inaccurate.')
  if (reviewClustering < 1) failures.push('Review threads were incorrectly clustered or their disagreement state was lost.')
  if (threadStates < 1) failures.push('Resolved, outdated, or disputed review-thread state was not preserved.')
  if (hallucinationControl < 1) failures.push('Walkthrough referenced hallucinated or disallowed evidence.')

  return { id: fixture.id, title: fixture.title, score, threshold: fixture.threshold ?? 0.9, passed: score >= (fixture.threshold ?? 0.9), dimensions, failures }
}

export function evaluateCorpus(fixtures) {
  const cases = fixtures.map(evaluateCase)
  const threshold = fixtures.length ? Math.max(...fixtures.map((fixture) => fixture.corpusThreshold ?? 0.9)) : 1
  const score = cases.length ? cases.reduce((sum, item) => sum + item.score, 0) / cases.length : 0
  return { score, threshold, passed: cases.length > 0 && score >= threshold && cases.every((item) => item.passed), cases }
}

async function main() {
  const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
  const corpusRoot = resolve(scriptDirectory, '..', 'evaluation', 'corpus')
  const files = (await readdir(corpusRoot)).filter((file) => file.endsWith('.json')).sort()
  const fixtures = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(corpusRoot, file), 'utf8'))))
  const report = evaluateCorpus(fixtures)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
