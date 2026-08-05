import { Bot, ExternalLink, FileCode2, MessageSquare, UserRound } from 'lucide-react';
import type { PullRequest, ReviewReply, ReviewState, ReviewThread } from '../types';

export interface ThreadsViewProps {
  pr: Pick<PullRequest, 'threads'>;
  openEvidence: (path: string, line?: number) => void;
}

const display = (value: string | null | undefined, fallback = 'Unknown') => value && value.trim() ? value : fallback;

function Avatar({ initials, className = '' }: { initials: string; className?: string }) {
  return <span className={`avatar ${className}`} aria-hidden="true">{display(initials, '?').slice(0, 2).toUpperCase()}</span>;
}

function StateTag({ state }: { state: ReviewState }) {
  return <span className={`state-tag ${state}`}>{state}</span>;
}

function Location({ path, file, line, originalLine, side, startLine, originalStartLine, url, openEvidence, label }: {
  path: string | null;
  file?: string;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  startLine: number | null;
  originalStartLine: number | null;
  url: string | null;
  openEvidence: (path: string, line?: number) => void;
  label: string;
}) {
  const target = display(path, display(file, 'Repository evidence'));
  const lineLabel = line && line > 0 ? `${target}:${line}` : target;
  return <div className="thread-location">
    <button className="location-link" onClick={() => openEvidence(target, line && line > 0 ? line : undefined)}>
      <FileCode2 size={13} /> {lineLabel}
    </button>
    {(originalLine || startLine || originalStartLine || side) && <span className="thread-position">
      {side ? `side ${side}` : ''}
      {startLine ? ` · lines ${startLine}-${line ?? startLine}` : ''}
      {originalLine ? ` · original ${originalLine}` : ''}
      {originalStartLine ? ` · original lines ${originalStartLine}-${originalLine ?? originalStartLine}` : ''}
    </span>}
    {url && <a href={url} target="_blank" rel="noreferrer" aria-label={label}><ExternalLink size={12} /> <span>{url}</span></a>}
  </div>;
}

function CommitMeta({ commitSha, originalCommitSha }: { commitSha: string | null; originalCommitSha: string | null }) {
  if (!commitSha && !originalCommitSha) return null;
  return <span className="thread-commits">{commitSha ? `commit ${commitSha}` : ''}{originalCommitSha ? ` · original ${originalCommitSha}` : ''}</span>;
}

function Reply({ reply, openEvidence }: { reply: ReviewReply; openEvidence: (path: string, line?: number) => void }) {
  return <div className="thread-reply" data-reply-id={reply.id}>
    <Avatar initials={reply.initials || reply.author.slice(0, 2)} className="reply-avatar" />
    <div className="thread-reply-main">
      <div className="thread-head"><strong>{display(reply.author, 'Review participant')}</strong>{reply.authorAssociation && <span className="thread-association">{reply.authorAssociation}</span>}</div>
      <p>{display(reply.body, 'Reply content is not specified.')}</p>
      <div className="thread-meta">
        {reply.createdAt && <time dateTime={reply.createdAt}>created {reply.createdAt}</time>}
        {reply.updatedAt && <time dateTime={reply.updatedAt}>updated {reply.updatedAt}</time>}
      </div>
      <Location path={reply.path} line={reply.line} originalLine={reply.originalLine} side={reply.side} startLine={null} originalStartLine={null} url={reply.url} openEvidence={openEvidence} label="Open reply" />
      <CommitMeta commitSha={reply.commitSha} originalCommitSha={reply.originalCommitSha} />
    </div>
  </div>;
}

function Thread({ thread, openEvidence }: { thread: ReviewThread; openEvidence: (path: string, line?: number) => void }) {
  const source = thread.source === 'bot' || thread.provenance === 'automated' ? 'bot' : 'human';
  return <article className="thread-row" data-thread-id={thread.id}>
    <Avatar initials={thread.initials || thread.author.slice(0, 2)} />
    <div className="thread-main">
      <div className="thread-head">
        <strong>{display(thread.author, 'Review participant')}</strong>
        <span className="thread-source">{source === 'bot' ? <Bot size={12} /> : <UserRound size={12} />}{source}</span>
        <span className="thread-provenance">{display(thread.provenance, 'unknown provenance')}</span>
        {thread.authorAssociation && <span className="thread-association">{thread.authorAssociation}</span>}
        <StateTag state={thread.state} />
      </div>
      <p>{display(thread.body, 'Review thread content is not specified.')}</p>
      <div className="thread-meta">
        {thread.createdAt && <time dateTime={thread.createdAt}>created {thread.createdAt}</time>}
        {thread.updatedAt && <time dateTime={thread.updatedAt}>updated {thread.updatedAt}</time>}
        {thread.resolvedBy && <span>resolved by {thread.resolvedBy}</span>}
      </div>
      <Location path={thread.path} file={thread.file} line={thread.line} originalLine={thread.originalLine} side={thread.side} startLine={thread.startLine} originalStartLine={thread.originalStartLine} url={thread.url} openEvidence={openEvidence} label="Open review thread" />
      <CommitMeta commitSha={thread.commitSha} originalCommitSha={thread.originalCommitSha} />
      <div className="thread-replies" aria-label={`${thread.replyCount} replies`}>
        <div className="thread-replies-head"><MessageSquare size={13} /><strong>{thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}</strong></div>
        {thread.replies.map((reply) => <Reply key={reply.id} reply={reply} openEvidence={openEvidence} />)}
      </div>
    </div>
  </article>;
}

export default function ThreadsView({ pr, openEvidence }: ThreadsViewProps) {
  return <div className="view-section">
    <div className="section-intro"><div className="eyebrow">Conversation context</div><h3>Review threads</h3><p>Complete comments, replies, provenance, and code locations stay visible so stale and disputed signals do not look active.</p></div>
    <div className="thread-list">
      {pr.threads.map((thread) => <Thread key={thread.id} thread={thread} openEvidence={openEvidence} />)}
      {pr.threads.length === 0 && <div className="empty-analysis"><MessageSquare size={20} /><h4>No review threads</h4><p>GitHub reports no review discussion for this pull request.</p></div>}
    </div>
  </div>;
}

export { Reply as ReviewReply, Thread as ReviewThreadItem };
export { ThreadsView };
