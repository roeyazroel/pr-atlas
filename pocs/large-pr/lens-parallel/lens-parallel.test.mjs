import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildLensPlan,
  mergeLensResults,
} from './lens-parallel.mjs';

const input = {
  pullRequest: [{
    number: 9,
    title: 'Add deterministic review walkthroughs',
    body: 'Introduces a richer walkthrough and a quality gate.',
    additions: 80,
    deletions: 20,
    changed_files: 3,
  }],
  files: [[
    { filename: 'src/cache.ts', status: 'modified', additions: 20, deletions: 5, changes: 25 },
    { filename: 'tests/cache.test.ts', status: 'added', additions: 30, deletions: 0, changes: 30 },
    { filename: 'README.md', status: 'modified', additions: 30, deletions: 15, changes: 45 },
  ]],
  commits: [{ sha: 'abc123', commit: { message: 'add walkthroughs' } }],
  reviews: [{ state: 'APPROVED' }],
  reviewThreads: [{ isResolved: false, path: 'src/cache.ts' }],
  issueComments: [],
  reviewComments: [],
  diff: 'diff --git a/src/cache.ts b/src/cache.ts\n@@ -1 +1 @@\n-old\n+new\n',
};

test('buildLensPlan derives compact facts once and creates four bounded independent lenses', () => {
  const plan = buildLensPlan(input, { maxPromptBytes: 1_200 });

  assert.equal(plan.sharedFacts.pullRequest.number, 9);
  assert.equal(plan.tasks.length, 4);
  assert.deepEqual(plan.tasks.map((task) => task.id), [
    'behavior-architecture',
    'tests',
    'risk-reviews',
    'files-flows',
  ]);
  assert.ok(plan.tasks.every((task) => task.promptBytes <= 1_200));
  assert.ok(plan.tasks.every((task) => task.maxObservations > 0));
  assert.ok(plan.tasks.every((task) => !task.prompt.includes('old\n+new')));
  assert.equal(new Set(plan.tasks.map((task) => task.sharedFactsDigest)).size, 1);
});

test('mergeLensResults is deterministic and reports duplicate evidence, conflicts, and uncovered files', () => {
  const plan = buildLensPlan(input);
  const results = [
    {
      lensId: 'tests',
      observations: [{
        key: 'cache-behavior',
        summary: 'Cache results are stored before returning.',
        files: ['src/cache.ts'],
        evidence: [{ id: 'file:src/cache.ts', kind: 'file', detail: 'modified' }],
      }],
    },
    {
      lensId: 'risk-reviews',
      observations: [{
        key: 'cache-behavior',
        summary: 'Cache results are not stored before returning.',
        files: ['src/cache.ts'],
        evidence: [{ id: 'file:src/cache.ts', kind: 'file', detail: 'modified' }],
      }],
    },
    {
      lensId: 'behavior-architecture',
      observations: [{
        key: 'cache-behavior',
        summary: 'Cache results are stored before returning.',
        files: ['src/cache.ts'],
        evidence: [{ id: 'diff:src/cache.ts', kind: 'diff', detail: 'one hunk' }],
      }],
    },
    { lensId: 'files-flows', observations: [] },
  ];

  const first = mergeLensResults(plan, results);
  const second = mergeLensResults(plan, [...results].reverse());

  assert.deepEqual(first, second);
  assert.equal(first.diagnostics.duplicateEvidence.length, 1);
  assert.equal(first.diagnostics.conflicts.length, 1);
  assert.deepEqual(first.diagnostics.uncoveredFiles, ['README.md', 'tests/cache.test.ts']);
  assert.equal(first.walkthrough.observations.length, 2);
  assert.equal(first.diagnostics.estimatedParallelCriticalPath, 1);
});
