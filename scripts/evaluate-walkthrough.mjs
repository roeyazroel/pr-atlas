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
const text = (value) => typeof value === 'string' && value.trim().length > 0
const strings = (value) => Array.isArray(value) && value.every(text)
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const canonicalDimensions = ['intent', 'changeGroups', 'reviewOrder', 'evidenceTraceability', 'limitations', 'flows', 'testMapping', 'reviewClustering', 'threadStates', 'hallucinationControl']

/**
 * The corpus is a compact projection of ReviewDocument graphs, so this
 * dependency-free evaluator validates its canonical schema-2 review model:
 * story shape, exact group ownership, primary-first order, dependencies, and
 * grounded test mappings. Production uses the stricter shared AJV validator.
 */
function canonicalReviewErrors(actual) {
  const errors = []
  if (!record(actual) || actual.schemaVersion !== '2.0.0') return ['schemaVersion must be 2.0.0.']
  if (!record(actual.summary) || !text(actual.summary.intent) || !strings(actual.summary.behavioralChanges) || !strings(actual.summary.architecturalImpact) || !strings(actual.summary.limitations)) errors.push('summary must contain canonical text and list fields.')
  const groups = Array.isArray(actual.changeGroups) ? actual.changeGroups : null
  const stories = Array.isArray(actual.stories) ? actual.stories : null
  const plan = Array.isArray(actual.reviewPlan) ? actual.reviewPlan : null
  if (!groups?.length || !stories?.length || !plan?.length || !text(actual.primaryStoryId)) return [...errors, 'changeGroups, stories, primaryStoryId, and reviewPlan are required.']
  const groupIds = new Set()
  for (const [index, group] of groups.entries()) {
    if (!record(group) || !text(group.id) || !text(group.title) || !text(group.summary) || !strings(group.evidenceIds) || group.evidenceIds.length === 0) errors.push(`changeGroups[${index}] is missing canonical fields.`)
    else if (groupIds.has(group.id)) errors.push(`changeGroups contains duplicate id '${group.id}'.`)
    else groupIds.add(group.id)
  }
  const storyFields = ['id', 'title', 'summary', 'relationshipToPrimary', 'relationshipRationale', 'reviewReason']
  const storyIds = new Set()
  const owner = new Set()
  let primaryCount = 0
  for (const [index, story] of stories.entries()) {
    if (!record(story) || !storyFields.every((field) => text(story[field])) || !['primary', 'supporting', 'adjacent', 'independent'].includes(story.relationshipToPrimary) || !strings(story.changeGroupIds) || story.changeGroupIds.length === 0 || !strings(story.dependsOnStoryIds)) {
      errors.push(`stories[${index}] is missing required schema-2 story fields.`)
      continue
    }
    if (storyIds.has(story.id)) errors.push(`stories contains duplicate id '${story.id}'.`)
    storyIds.add(story.id)
    if (story.relationshipToPrimary === 'primary') primaryCount++
    for (const groupId of story.changeGroupIds) {
      if (!groupIds.has(groupId)) errors.push(`story '${story.id}' references unknown change group '${groupId}'.`)
      else if (owner.has(groupId)) errors.push(`change group '${groupId}' belongs to more than one story.`)
      else owner.add(groupId)
    }
  }
  if (plan.length !== stories.length || !strings(plan) || new Set(plan).size !== plan.length || plan.some((id) => !storyIds.has(id))) errors.push('reviewPlan must contain every story exactly once.')
  else if (plan[0] !== actual.primaryStoryId) errors.push('reviewPlan must begin with primaryStoryId.')
  if (primaryCount !== 1 || !stories.some((story) => record(story) && story.id === actual.primaryStoryId && story.relationshipToPrimary === 'primary')) errors.push('primaryStoryId must identify exactly one primary story.')
  groupIds.forEach((id) => { if (!owner.has(id)) errors.push(`change group '${id}' must belong to exactly one story.`) })
  for (const story of stories) {
    if (!record(story) || !text(story.id) || !strings(story.dependsOnStoryIds)) continue
    for (const dependency of story.dependsOnStoryIds) {
      const current = plan?.indexOf(story.id) ?? -1
      const previous = plan?.indexOf(dependency) ?? -1
      if (!storyIds.has(dependency)) errors.push(`story '${story.id}' depends on unknown story '${dependency}'.`)
      else if (dependency === story.id || previous >= current) errors.push(`story '${story.id}' must depend only on an earlier reviewPlan story.`)
    }
  }
  if (!Array.isArray(actual.tests) || !Array.isArray(actual.reviewThreads) || !Array.isArray(actual.reviewInsights) || !Array.isArray(actual.risks) || !Array.isArray(actual.dependencies) || !Array.isArray(actual.unchangedInteractions) || !Array.isArray(actual.evidence)) errors.push('canonical relationship and evidence collections are required arrays.')
  const tests = Array.isArray(actual.tests) ? actual.tests : []
  const reviewThreads = Array.isArray(actual.reviewThreads) ? actual.reviewThreads : []
  const reviewInsights = Array.isArray(actual.reviewInsights) ? actual.reviewInsights : []
  const risks = Array.isArray(actual.risks) ? actual.risks : []
  const dependencies = Array.isArray(actual.dependencies) ? actual.dependencies : []
  const unchangedInteractions = Array.isArray(actual.unchangedInteractions) ? actual.unchangedInteractions : []
  const evidence = Array.isArray(actual.evidence) ? actual.evidence : []
  const evidenceIds = new Set()
  for (const [index, item] of evidence.entries()) {
    if (!record(item) || !text(item.id) || !text(item.path)) errors.push(`evidence[${index}] is missing canonical evidence fields.`)
    else if (evidenceIds.has(item.id)) errors.push(`evidence contains duplicate id '${item.id}'.`)
    else evidenceIds.add(item.id)
  }
  const semanticIds = new Map()
  for (const [collection, items] of [
    ['changeGroups', groups], ['stories', stories], ['tests', tests], ['reviewThreads', reviewThreads], ['reviewInsights', reviewInsights], ['risks', risks], ['dependencies', dependencies], ['unchangedInteractions', unchangedInteractions], ['evidence', evidence],
  ]) {
    for (const [index, item] of items.entries()) {
      if (!record(item) || !text(item.id)) continue
      const previous = semanticIds.get(item.id)
      if (previous) errors.push(`duplicate semantic id '${item.id}' in ${collection}[${index}] and ${previous}.`)
      else semanticIds.set(item.id, `${collection}[${index}]`)
    }
  }
  for (const [index, group] of groups.entries()) {
    if (record(group) && strings(group.evidenceIds) && group.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push(`changeGroups[${index}] references an unknown evidence id.`)
  }
  for (const [index, test] of tests.entries()) {
    if (!record(test) || !text(test.id) || !text(test.title) || !text(test.behavior) || !strings(test.changeGroupIds) || test.changeGroupIds.length === 0 || !strings(test.evidenceIds) || test.evidenceIds.length === 0) errors.push(`tests[${index}] is missing canonical mapping fields.`)
    else {
      if (test.changeGroupIds.some((id) => !groupIds.has(id))) errors.push(`tests[${index}] references an unknown change group.`)
      if (test.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push(`tests[${index}] references an unknown evidence id.`)
    }
  }
  const relationshipCollections = [
    ['risks', risks, false],
    ['dependencies', dependencies, true],
    ['unchangedInteractions', unchangedInteractions, false],
  ]
  for (const [name, items, hasDependencies] of relationshipCollections) {
    for (const [index, item] of items.entries()) {
      const path = `${name}[${index}]`
      if (!record(item) || !text(item.id) || !text(item.title) || !text(item.detail) || !strings(item.changeGroupIds) || item.changeGroupIds.length === 0 || !strings(item.evidenceIds) || item.evidenceIds.length === 0 || (hasDependencies && !strings(item.dependsOnIds))) {
        errors.push(`${path} is missing canonical relationship fields.`)
        continue
      }
      if (item.changeGroupIds.some((id) => !groupIds.has(id))) errors.push(`${path} references an unknown change group.`)
      if (item.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push(`${path} references an unknown evidence id.`)
    }
  }
  const dependencyIds = new Set(dependencies.filter(record).map((item) => item.id).filter(text))
  const dependencyById = new Map(dependencies.filter(record).filter((item) => text(item.id)).map((item) => [item.id, item]))
  for (const [index, dependency] of dependencies.entries()) {
    if (!record(dependency) || !strings(dependency.dependsOnIds)) continue
    for (const target of dependency.dependsOnIds) {
      if (!dependencyIds.has(target)) errors.push(`dependencies[${index}].dependsOnIds references an unknown dependency '${target}'.`)
      else if (target === dependency.id) errors.push(`dependency '${dependency.id}' cannot depend on itself.`)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visitDependency = (id) => {
    if (visiting.has(id)) { errors.push(`dependencies contain a cycle through '${id}'.`); return }
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of dependencyById.get(id)?.dependsOnIds ?? []) if (dependencyById.has(target)) visitDependency(target)
    visiting.delete(id)
    visited.add(id)
  }
  dependencyIds.forEach(visitDependency)
  return errors
}

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
  const canonicalErrors = canonicalReviewErrors(actual)
  if (canonicalErrors.length) {
    const dimensions = Object.fromEntries(canonicalDimensions.map((name) => [name, 0]))
    return { id: fixture.id, title: fixture.title, score: 0, threshold: fixture.threshold ?? 0.9, passed: false, dimensions, failures: [`Canonical ReviewDocument invalid: ${canonicalErrors.join(' ')}`] }
  }
  const groups = Array.isArray(actual.changeGroups) ? actual.changeGroups : []
  const stories = Array.isArray(actual.stories) ? actual.stories : []
  const storyById = new Map(stories.map((story) => [story.id, story]))
  const reviewPlan = Array.isArray(actual.reviewPlan) ? actual.reviewPlan : []
  const orderedGroupIds = reviewPlan.flatMap((storyId) => storyById.get(storyId)?.changeGroupIds ?? [])
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
  const reviewOrder = orderScore(expected.reviewOrder ?? [], orderedGroupIds)

  const referencedEvidence = new Set(unique([
    ...groups.flatMap((group) => group.evidenceIds ?? []),
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
  if (evidenceTraceability < 1) failures.push('Expected evidence was missing or not linked from the review document.')
  if (limitations < 1) failures.push('Expected analysis limitations were not disclosed.')
  if (flows < 1) failures.push('Expected flow relationships were missing or inaccurate.')
  if (testMapping < 1) failures.push('Expected behavior-to-test mappings were missing or inaccurate.')
  if (reviewClustering < 1) failures.push('Review threads were incorrectly clustered or their disagreement state was lost.')
  if (threadStates < 1) failures.push('Resolved, outdated, or disputed review-thread state was not preserved.')
  if (hallucinationControl < 1) failures.push('Review document referenced hallucinated or disallowed evidence.')

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
