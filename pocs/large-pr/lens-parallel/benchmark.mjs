import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildLensPlan, mergeLensResults, replayLensResults } from './lens-parallel.mjs';

function readFlag(name, args) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readJson(directory, file) {
  return JSON.parse(await readFile(resolve(directory, file), 'utf8'));
}

export async function loadArtifactInput(directory) {
  return {
    pullRequest: await readJson(directory, 'pull-request.json'),
    files: await readJson(directory, 'files.json'),
    commits: await readJson(directory, 'commits.json'),
    reviews: await readJson(directory, 'reviews.json'),
    reviewThreads: await readJson(directory, 'review-threads.json'),
    issueComments: await readJson(directory, 'issue-comments.json'),
    reviewComments: await readJson(directory, 'review-comments.json'),
    diff: await readFile(resolve(directory, 'diff.patch'), 'utf8'),
  };
}

export async function benchmark(directory) {
  const input = await loadArtifactInput(directory);
  const plan = buildLensPlan(input);
  const candidate = mergeLensResults(plan, replayLensResults(plan));
  return {
    schemaVersion: 'poc-lens-parallel-report/v1',
    input: { directory: resolve(directory), pullNumber: plan.sharedFacts.pullRequest.number },
    plan: {
      sharedFactsDigest: plan.tasks[0]?.sharedFactsDigest ?? '',
      lenses: plan.tasks.map(({ id, promptBytes, scopeFiles, estimatedWorkUnits }) => ({ id, promptBytes, scopedFiles: scopeFiles.length, estimatedWorkUnits })),
    },
    candidate,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node benchmark.mjs <artifact-input-directory> [--out report.json]');
  const report = await benchmark(directory);
  const output = readFlag('--out', process.argv.slice(3));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(resolve(output), serialized, 'utf8');
  else process.stdout.write(serialized);
}
