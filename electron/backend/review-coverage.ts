import { readFile } from 'node:fs/promises';

interface ReviewCoverageValidation {
  valid: boolean;
  errors: string[];
}

interface RawReviewThread {
  id: string;
  commentIds: string[];
  source: Record<string, unknown>;
  comments: Array<Record<string, unknown>>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeId(value: string): string {
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(value) ? value : '<redacted-id>';
}

function invalid(...errors: string[]): ReviewCoverageValidation {
  return { valid: false, errors };
}

function hasField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function field(value: Record<string, unknown>, name: string): unknown {
  return hasField(value, name) ? value[name] : undefined;
}

function nestedField(value: Record<string, unknown>, name: string, nestedName: string): unknown {
  if (!hasField(value, name)) return undefined;
  const nested = value[name];
  if (nested === null) return null;
  return field(asObject(nested), nestedName);
}

function firstField(primary: Record<string, unknown>, primaryName: string, fallback: Record<string, unknown>, fallbackName = primaryName): unknown {
  return hasField(primary, primaryName) ? primary[primaryName] : field(fallback, fallbackName);
}

function canonicalSide(source: Record<string, unknown>, fallback?: Record<string, unknown>): unknown {
  if (hasField(source, 'diffSide')) return source.diffSide;
  if (hasField(source, 'side')) return source.side;
  if (fallback) return canonicalSide(fallback);
  return undefined;
}

function canonicalStatus(source: Record<string, unknown>): unknown {
  const resolved = field(source, 'isResolved');
  const outdated = field(source, 'isOutdated');
  if (typeof resolved !== 'boolean' && typeof outdated !== 'boolean') return undefined;
  if (outdated === true) return 'outdated';
  if (resolved === true) return 'resolved';
  return 'active';
}

function canonicalThreadFields(raw: RawReviewThread): Record<string, unknown> {
  const source = raw.source;
  const original = raw.comments[0] ?? {};
  const fields: Record<string, unknown> = {};
  const add = (name: string, value: unknown): void => { if (value !== undefined) fields[name] = value; };

  add('status', canonicalStatus(source));
  add('author', nestedField(original, 'author', 'login'));
  add('body', field(original, 'body'));
  add('authorAssociation', field(original, 'authorAssociation'));
  add('createdAt', field(original, 'createdAt'));
  add('updatedAt', field(original, 'updatedAt'));
  add('url', field(original, 'url'));
  add('resolvedBy', nestedField(source, 'resolvedBy', 'login'));
  add('path', firstField(source, 'path', original));
  add('line', firstField(source, 'line', original));
  add('originalLine', firstField(source, 'originalLine', original));
  add('side', canonicalSide(source, original));
  add('startLine', firstField(source, 'startLine', original));
  add('originalStartLine', firstField(source, 'originalStartLine', original));
  add('commitSha', nestedField(original, 'commit', 'oid'));
  add('originalCommitSha', nestedField(original, 'originalCommit', 'oid'));
  return fields;
}

function canonicalReplyFields(comment: Record<string, unknown>, threadSource: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const add = (name: string, value: unknown): void => { if (value !== undefined) fields[name] = value; };
  add('author', nestedField(comment, 'author', 'login'));
  add('body', field(comment, 'body'));
  add('authorAssociation', field(comment, 'authorAssociation'));
  add('createdAt', field(comment, 'createdAt'));
  add('updatedAt', field(comment, 'updatedAt'));
  add('url', field(comment, 'url'));
  add('path', field(comment, 'path'));
  add('line', field(comment, 'line'));
  add('originalLine', field(comment, 'originalLine'));
  add('side', canonicalSide(comment, threadSource));
  add('commitSha', nestedField(comment, 'commit', 'oid'));
  add('originalCommitSha', nestedField(comment, 'originalCommit', 'oid'));
  return fields;
}

function compareCanonicalFields(
  output: Record<string, unknown>,
  expected: Record<string, unknown>,
  kind: 'thread' | 'reply',
  id: string,
  errors: string[],
): void {
  for (const [name, value] of Object.entries(expected)) {
    if (!Object.is(output[name], value)) errors.push(`Generated walkthrough review ${kind} '${safeId(id)}' altered GitHub ${name}.`);
  }
}

function rawThreads(value: unknown): { threads: RawReviewThread[]; errors: string[] } {
  const pages = Array.isArray(value) ? value : [value];
  if (pages.length === 0) return { threads: [], errors: [] };

  const threads: RawReviewThread[] = [];
  const errors: string[] = [];
  const seenThreadIds = new Set<string>();
  const seenCommentIds = new Set<string>();
  let foundReviewThreads = false;

  for (const page of pages) {
    const data = asObject(asObject(page).data);
    const repository = asObject(data.repository);
    const pullRequest = asObject(repository.pullRequest);
    const reviewThreads = pullRequest.reviewThreads;
    if (!reviewThreads || typeof reviewThreads !== 'object') continue;
    foundReviewThreads = true;
    const nodes = asObject(reviewThreads).nodes;
    if (!Array.isArray(nodes)) {
      errors.push('GitHub review-thread coverage input is malformed.');
      continue;
    }
    for (const node of nodes) {
      const thread = asObject(node);
      const id = text(thread.id);
      if (!id) {
        errors.push('GitHub review-thread coverage input contains a thread without an id.');
        continue;
      }
      if (seenThreadIds.has(id)) errors.push(`Duplicate GitHub review thread id '${safeId(id)}'.`);
      seenThreadIds.add(id);

      const comments = asObject(thread.comments);
      if (!Array.isArray(comments.nodes)) {
        errors.push(`GitHub review thread '${safeId(id)}' has malformed comments.`);
        threads.push({ id, commentIds: [], source: thread, comments: [] });
        continue;
      }
      const commentIds: string[] = [];
      const commentNodes: Array<Record<string, unknown>> = [];
      for (const comment of comments.nodes) {
        const commentNode = asObject(comment);
        const commentId = text(commentNode.id);
        if (!commentId) {
          errors.push(`GitHub review thread '${safeId(id)}' contains a comment without an id.`);
          continue;
        }
        if (seenCommentIds.has(commentId)) errors.push(`Duplicate GitHub review comment id '${safeId(commentId)}'.`);
        seenCommentIds.add(commentId);
        commentIds.push(commentId);
        commentNodes.push(commentNode);
      }
      threads.push({ id, commentIds, source: thread, comments: commentNodes });
    }
  }

  if (!foundReviewThreads) errors.push('GitHub review-thread coverage input is malformed.');
  return { threads, errors };
}

/**
 * Compares the provider's normalized review threads with the canonical content,
 * state, locations, and identifiers fetched into the deterministic GitHub input
 * artifact. Errors name only safe identifiers and field names, never comment
 * bodies or other untrusted review text.
 */
export function validateReviewCoverage(rawInput: unknown, document: unknown): ReviewCoverageValidation {
  const parsed = rawThreads(rawInput);
  if (parsed.errors.length) return invalid(...parsed.errors);

  const output = asObject(document);
  if (!Array.isArray(output.reviewThreads)) return invalid('Generated walkthrough review-thread coverage is missing.');
  const outputThreads = output.reviewThreads.map(asObject);
  const outputById = new Map<string, Record<string, unknown>>();
  const errors: string[] = [];
  for (const thread of outputThreads) {
    const id = text(thread.id);
    if (!id) {
      errors.push('Generated walkthrough contains a review thread without an id.');
      continue;
    }
    if (outputById.has(id)) errors.push(`Duplicate generated review thread id '${safeId(id)}'.`);
    outputById.set(id, thread);
  }

  const rawIds = new Set(parsed.threads.map((thread) => thread.id));
  for (const id of outputById.keys()) if (!rawIds.has(id)) errors.push(`Generated walkthrough contains an unknown review thread id '${safeId(id)}'.`);

  for (const rawThread of parsed.threads) {
    const outputThread = outputById.get(rawThread.id);
    if (!outputThread) {
      errors.push(`Generated walkthrough omitted GitHub review thread '${safeId(rawThread.id)}'.`);
      continue;
    }
    compareCanonicalFields(outputThread, canonicalThreadFields(rawThread), 'thread', rawThread.id, errors);
    const replies = outputThread.replies;
    if (!Array.isArray(replies)) {
      errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' has no replies array.`);
      continue;
    }
    const replyCount = outputThread.replyCount;
    if (!Number.isInteger(replyCount) || replyCount !== replies.length) {
      errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' has inconsistent replyCount.`);
    }
    const requiredReplyCount = Math.max(0, rawThread.commentIds.length - 1);
    if (replies.length < requiredReplyCount) {
      errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' truncated review comments.`);
    }

    const replyIds = new Set<string>();
    const rawReplyIds = new Set(rawThread.commentIds.slice(1));
    for (const reply of replies) {
      const replyObject = asObject(reply);
      const replyId = text(replyObject.id);
      if (!replyId) {
        errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' contains a reply without an id.`);
        continue;
      }
      if (replyIds.has(replyId)) errors.push(`Duplicate generated review reply id '${safeId(replyId)}'.`);
      if (!rawReplyIds.has(replyId)) errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' contains an unknown reply id '${safeId(replyId)}'.`);
      const rawReply = rawThread.comments.find((comment) => text(comment.id) === replyId);
      if (rawReply) compareCanonicalFields(replyObject, canonicalReplyFields(rawReply, rawThread.source), 'reply', replyId, errors);
      replyIds.add(replyId);
    }
    for (const commentId of rawThread.commentIds.slice(1)) {
      if (!replyIds.has(commentId)) errors.push(`Generated walkthrough review thread '${safeId(rawThread.id)}' omitted GitHub reply '${safeId(commentId)}'.`);
    }
  }

  return errors.length ? invalid(...errors) : { valid: true, errors: [] };
}

/** Read and validate the bounded deterministic review-thread input artifact. */
export async function validateReviewCoverageFile(path: string, document: unknown): Promise<ReviewCoverageValidation> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return validateReviewCoverage(raw, document);
  } catch {
    return invalid('GitHub review-thread coverage input could not be validated.');
  }
}
