import { createHash } from 'node:crypto';

const LENSES = [
  {
    id: 'behavior-architecture',
    focus: 'Explain changed behavior, ownership boundaries, and important dependencies.',
    maxObservations: 6,
  },
  {
    id: 'tests',
    focus: 'Assess test intent, gaps, and the highest-value verification paths.',
    maxObservations: 5,
  },
  {
    id: 'risk-reviews',
    focus: 'Identify review risk, unresolved feedback, and assumptions needing confirmation.',
    maxObservations: 5,
  },
  {
    id: 'files-flows',
    focus: 'Map changed files into review flows and propose a readable review order.',
    maxObservations: 8,
  },
];

const LENS_ORDER = new Map(LENSES.map(({ id }, index) => [id, index]));
const encoder = new TextEncoder();

function flatten(value) {
  return Array.isArray(value) ? value.flatMap(flatten) : value == null ? [] : [value];
}

function first(value) {
  return flatten(value)[0] ?? {};
}

function text(value, max = 280) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function groupDirectories(files) {
  const groups = new Map();
  for (const file of files) {
    const parts = file.filename.split('/');
    const directory = parts.length > 1 ? `${parts[0]}/` : '(root)';
    const group = groups.get(directory) ?? { directory, files: 0, additions: 0, deletions: 0 };
    group.files += 1;
    group.additions += file.additions;
    group.deletions += file.deletions;
    groups.set(directory, group);
  }
  return [...groups.values()].sort((left, right) =>
    right.files - left.files || right.additions + right.deletions - (left.additions + left.deletions) || compareText(left.directory, right.directory),
  );
}

function parseDiffFiles(diff) {
  return [...String(diff ?? '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
    .map((match) => match[2])
    .sort(compareText);
}

function normalizeFiles(files) {
  return flatten(files)
    .filter((file) => typeof file?.filename === 'string')
    .map((file) => ({
      filename: file.filename,
      status: text(file.status, 32) || 'modified',
      additions: number(file.additions),
      deletions: number(file.deletions),
      changes: number(file.changes ?? number(file.additions) + number(file.deletions)),
    }))
    .sort((left, right) => compareText(left.filename, right.filename));
}

function selectFiles(files, predicate, max = 12) {
  return files
    .filter(predicate)
    .sort((left, right) => right.changes - left.changes || compareText(left.filename, right.filename))
    .slice(0, max)
    .map((file) => file.filename);
}

/** Derives a provider-safe, compact shared context; it intentionally excludes raw diff bodies. */
export function deriveSharedFacts(input) {
  const pr = first(input.pullRequest);
  const files = normalizeFiles(input.files);
  const reviews = flatten(input.reviews);
  const threads = flatten(input.reviewThreads);
  const issueComments = flatten(input.issueComments);
  const reviewComments = flatten(input.reviewComments);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const notableFiles = [...files]
    .sort((left, right) => right.changes - left.changes || compareText(left.filename, right.filename))
    .slice(0, 24);

  return {
    pullRequest: {
      number: number(pr.number),
      title: text(pr.title, 180),
      summary: text(pr.body, 360),
      base: text(pr.base?.sha, 12),
      head: text(pr.head?.sha, 12),
    },
    changeStats: {
      files: files.length,
      additions,
      deletions,
      commits: flatten(input.commits).length,
      diffFiles: parseDiffFiles(input.diff).length,
    },
    directories: groupDirectories(files).slice(0, 12),
    notableFiles,
    reviewState: {
      reviews: reviews.length,
      approvals: reviews.filter((review) => String(review.state).toUpperCase() === 'APPROVED').length,
      changesRequested: reviews.filter((review) => String(review.state).toUpperCase() === 'CHANGES_REQUESTED').length,
      reviewThreads: threads.length,
      unresolvedThreads: threads.filter((thread) => thread.isResolved === false).length,
      issueComments: issueComments.length,
      reviewComments: reviewComments.length,
    },
  };
}

function promptFacts(sharedFacts, level) {
  const bodyLimit = [360, 180, 80, 0][level] ?? 0;
  const directoryLimit = [8, 5, 3, 1][level] ?? 1;
  const notableLimit = [8, 5, 3, 1][level] ?? 1;
  return {
    pullRequest: {
      number: sharedFacts.pullRequest.number,
      title: text(sharedFacts.pullRequest.title, [180, 120, 72, 40][level] ?? 40),
      summary: text(sharedFacts.pullRequest.summary, bodyLimit),
    },
    changeStats: sharedFacts.changeStats,
    directories: sharedFacts.directories.slice(0, directoryLimit),
    notableFiles: sharedFacts.notableFiles.slice(0, notableLimit),
    reviewState: sharedFacts.reviewState,
  };
}

function boundedPrompt(lens, sharedFacts, scopeFiles, maxPromptBytes) {
  for (let level = 0; level < 4; level += 1) {
    for (let count = Math.min(scopeFiles.length, 12); count >= 0; count -= 1) {
      const prompt = JSON.stringify({
        role: 'Pull-request review lens. Work only from the supplied facts and evidence IDs; do not invent source details.',
        lens: lens.id,
        focus: lens.focus,
        limits: { maxObservations: lens.maxObservations, sourceQuotes: 0 },
        sharedFacts: promptFacts(sharedFacts, level),
        scopedFiles: scopeFiles.slice(0, count),
        output: 'Return observations with key, summary, files, evidence [{id, kind, detail}], and explicit uncertainty.',
      });
      if (encoder.encode(prompt).byteLength <= maxPromptBytes) return prompt;
    }
  }
  throw new Error(`maxPromptBytes (${maxPromptBytes}) is too small for the minimum lens contract.`);
}

function lensScope(id, files) {
  if (id === 'tests') return selectFiles(files, (file) => /(^|\/)(test|tests|__tests__)\b|\.(test|spec)\.[^.]+$/i.test(file.filename));
  if (id === 'risk-reviews') return selectFiles(files, (file) => /auth|security|store|schema|agent|backend|electron/i.test(file.filename));
  if (id === 'files-flows') return selectFiles(files, () => true, 18);
  return selectFiles(files, (file) => !/(^|\/)(test|tests|__tests__)\b|\.(test|spec)\.[^.]+$/i.test(file.filename));
}

export function buildLensPlan(input, options = {}) {
  const maxPromptBytes = options.maxPromptBytes ?? 12_000;
  if (!Number.isInteger(maxPromptBytes) || maxPromptBytes < 512) throw new Error('maxPromptBytes must be an integer of at least 512.');
  const sharedFacts = deriveSharedFacts(input);
  const files = normalizeFiles(input.files);
  const sharedFactsDigest = digest(sharedFacts);
  const tasks = LENSES.map((lens) => {
    const scopeFiles = lensScope(lens.id, files);
    const prompt = boundedPrompt(lens, sharedFacts, scopeFiles, maxPromptBytes);
    return {
      id: lens.id,
      focus: lens.focus,
      maxObservations: lens.maxObservations,
      sharedFactsDigest,
      scopeFiles,
      prompt,
      promptBytes: encoder.encode(prompt).byteLength,
      estimatedWorkUnits: Math.max(1, Math.ceil(encoder.encode(prompt).byteLength / 4_000)),
    };
  });
  return {
    schemaVersion: 'poc-lens-parallel/v1',
    sharedFacts,
    fileInventory: files.map((file) => file.filename),
    tasks,
  };
}

function normalizeObservation(lensId, observation) {
  const evidence = flatten(observation?.evidence)
    .filter((item) => typeof item?.id === 'string' && item.id.length > 0)
    .map((item) => ({ id: item.id, kind: text(item.kind, 40), detail: text(item.detail, 240) }))
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.kind, right.kind) || compareText(left.detail, right.detail));
  return {
    key: text(observation?.key, 160) || digest({ lensId, observation }),
    summary: text(observation?.summary, 800),
    files: [...new Set(flatten(observation?.files).filter((file) => typeof file === 'string'))].sort(compareText),
    evidence,
    sourceLenses: [lensId],
    uncertainty: text(observation?.uncertainty, 300),
  };
}

function canonicalObservationKey(observation) {
  return `${observation.key}\u0000${observation.summary}`;
}

export function mergeLensResults(plan, lensResults) {
  const allowed = new Set(plan.tasks.map((task) => task.id));
  const raw = flatten(lensResults)
    .filter((result) => allowed.has(result?.lensId))
    .sort((left, right) => (LENS_ORDER.get(left.lensId) ?? 99) - (LENS_ORDER.get(right.lensId) ?? 99))
    .flatMap((result) => flatten(result.observations).slice(0, plan.tasks.find((task) => task.id === result.lensId).maxObservations)
      .map((observation) => normalizeObservation(result.lensId, observation)));

  const duplicateEvidence = new Map();
  for (const observation of raw) {
    for (const evidence of observation.evidence) {
      const entry = duplicateEvidence.get(evidence.id) ?? { id: evidence.id, occurrences: 0, lenses: new Set() };
      entry.occurrences += 1;
      entry.lenses.add(observation.sourceLenses[0]);
      duplicateEvidence.set(evidence.id, entry);
    }
  }

  const merged = new Map();
  for (const observation of raw) {
    const key = canonicalObservationKey(observation);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, observation);
      continue;
    }
    existing.files = [...new Set([...existing.files, ...observation.files])].sort(compareText);
    existing.evidence = [...existing.evidence, ...observation.evidence]
      .filter((item, index, list) => index === list.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)))
      .sort((left, right) => compareText(left.id, right.id) || compareText(left.kind, right.kind) || compareText(left.detail, right.detail));
    existing.sourceLenses = [...new Set([...existing.sourceLenses, ...observation.sourceLenses])]
      .sort((left, right) => (LENS_ORDER.get(left) ?? 99) - (LENS_ORDER.get(right) ?? 99));
    existing.uncertainty = [existing.uncertainty, observation.uncertainty].filter(Boolean).sort(compareText).join(' | ');
  }

  const observations = [...merged.values()].sort((left, right) => compareText(left.key, right.key) || compareText(left.summary, right.summary));
  const byKey = new Map();
  for (const observation of observations) {
    const entries = byKey.get(observation.key) ?? [];
    entries.push(observation);
    byKey.set(observation.key, entries);
  }
  const conflicts = [...byKey.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.summary)).size > 1)
    .map(([key, entries]) => ({
      key,
      alternatives: entries.map((entry) => ({ summary: entry.summary, lenses: entry.sourceLenses })).sort((left, right) => compareText(left.summary, right.summary)),
      resolution: 'Needs reviewer confirmation; neither alternative is discarded.',
    }))
    .sort((left, right) => compareText(left.key, right.key));

  const coveredFiles = new Set(observations.flatMap((observation) => observation.files));
  const duplicateEvidenceReport = [...duplicateEvidence.values()]
    .filter((entry) => entry.occurrences > 1)
    .map((entry) => ({ id: entry.id, occurrences: entry.occurrences, lenses: [...entry.lenses].sort((left, right) => (LENS_ORDER.get(left) ?? 99) - (LENS_ORDER.get(right) ?? 99)) }))
    .sort((left, right) => compareText(left.id, right.id));
  const taskPromptBytes = plan.tasks.map((task) => ({ id: task.id, bytes: task.promptBytes }));
  const estimatedWork = plan.tasks.map((task) => task.estimatedWorkUnits);

  return {
    schemaVersion: 'poc-rich-walkthrough-candidate/v1',
    sharedFacts: plan.sharedFacts,
    walkthrough: {
      title: plan.sharedFacts.pullRequest.title,
      observations,
      reviewOrder: plan.tasks.map((task) => ({ lens: task.id, files: task.scopeFiles })),
      evidence: observations.flatMap((observation) => observation.evidence)
        .filter((item, index, list) => index === list.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)))
        .sort((left, right) => compareText(left.id, right.id) || compareText(left.kind, right.kind) || compareText(left.detail, right.detail)),
    },
    diagnostics: {
      taskPromptBytes,
      totalTaskPromptBytes: taskPromptBytes.reduce((total, task) => total + task.bytes, 0),
      duplicateEvidence: duplicateEvidenceReport,
      conflicts,
      uncoveredFiles: plan.fileInventory.filter((file) => !coveredFiles.has(file)).sort(compareText),
      estimatedParallelCriticalPath: Math.max(...estimatedWork, 0),
      estimatedSerialWork: estimatedWork.reduce((total, work) => total + work, 0),
    },
  };
}

/** A deterministic stand-in for provider output, suitable for repeatable benchmark runs. */
export function replayLensResults(plan) {
  return plan.tasks.map((task) => {
    const files = task.scopeFiles.slice(0, Math.min(2, task.maxObservations));
    return {
      lensId: task.id,
      observations: files.length === 0 ? [] : [{
        key: `${task.id}-scope`,
        summary: `${task.focus} Scoped to ${files.join(', ')}.`,
        files,
        evidence: files.map((file) => ({ id: `file:${file}`, kind: 'file', detail: 'Changed file metadata.' })),
        uncertainty: 'Replay output is a deterministic placeholder, not a source-code finding.',
      }],
    };
  });
}
