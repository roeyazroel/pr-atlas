import { ExternalLink, LoaderCircle, MessageSquare, RefreshCw, Send } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { PullRequestComment } from '../../shared/contracts'

export type CommentResourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CommentResource {
  status: CommentResourceStatus
  comments: PullRequestComment[]
  error: string | null
}

export interface CommentViewer {
  label: string
  initials: string
}

export interface PullRequestCommentsProps {
  pullNumber: number
  viewer?: CommentViewer | null
  live: boolean
  resource: CommentResource
  posting: boolean
  postError: string | null
  successMessage: string | null
  /** Resolve true only after GitHub confirms the comment; false means the draft must remain. */
  onPost: (body: string) => Promise<boolean>
  onRefresh: () => void
}

const MAX_COMMENT_LENGTH = 65_536

function display(value: string | null | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback
}

function initialsFor(author: string): string {
  const words = author.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return `${words[0][0] ?? ''}${words[words.length - 1][0] ?? ''}`.toUpperCase()
  return author.trim().slice(0, 2).toUpperCase() || '?'
}

function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'avatars.githubusercontent.com') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function Avatar({ initials, className = '', avatarUrl, alt }: { initials: string; className?: string; avatarUrl?: string | null; alt?: string }) {
  const trustedUrl = safeAvatarUrl(avatarUrl)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (trustedUrl && failedUrl !== trustedUrl) {
    return <span className={`avatar ${className}`.trim()}><img className="pull-request-comment-avatar-image" src={trustedUrl} alt={alt ?? 'GitHub avatar'} onError={() => setFailedUrl(trustedUrl)} /></span>
  }
  return <span className={`avatar ${className}`.trim()} aria-hidden="true">{display(initials, '?').slice(0, 2).toUpperCase()}</span>
}

function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function commentOrder(left: PullRequestComment, right: PullRequestComment): number {
  const leftTime = Date.parse(left.createdAt)
  const rightTime = Date.parse(right.createdAt)
  const leftValid = Number.isFinite(leftTime)
  const rightValid = Number.isFinite(rightTime)
  if (leftValid && rightValid && leftTime !== rightTime) return leftTime - rightTime
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt)
  return left.id - right.id
}

function CommentItem({ comment }: { comment: PullRequestComment }) {
  const url = safeExternalUrl(comment.url)
  const edited = comment.updatedAt !== comment.createdAt
  return <article className="pull-request-comment" data-comment-id={comment.id}>
    <Avatar initials={initialsFor(comment.author)} avatarUrl={comment.authorAvatarUrl} alt={`${display(comment.author, 'GitHub participant')} avatar`} />
    <div className="pull-request-comment-main">
      <div className="pull-request-comment-head">
        <strong>{display(comment.author, 'GitHub participant')}</strong>
        {comment.viewerDidAuthor && <span className="pull-request-comment-you">you</span>}
        {comment.authorAssociation && <span className="thread-association">{comment.authorAssociation}</span>}
      </div>
      <p className="pull-request-comment-body">{display(comment.body, 'Comment content is not available.')}</p>
      <div className="thread-meta pull-request-comment-meta">
        <time dateTime={comment.createdAt}>created {comment.createdAt}</time>
        {edited && <time dateTime={comment.updatedAt}>edited {comment.updatedAt}</time>}
        {url && <a href={url} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden="true" /> <span>Open on GitHub</span></a>}
      </div>
    </div>
  </article>
}

function CommentComposer({ pullNumber, viewer, posting, postError, successMessage, onPost }: {
  pullNumber: number
  viewer?: CommentViewer | null
  posting: boolean
  postError: string | null
  successMessage: string | null
  onPost: (body: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = useCallback(async () => {
    const body = draft.trim()
    if (!body || posting || submitting) return
    setSubmitting(true)
    setLocalError(null)
    try {
      const succeeded = await onPost(body)
      if (succeeded === true) {
        setDraft('')
        textareaRef.current?.focus()
      } else {
        setLocalError('Unable to post comment. Try again.')
      }
    } catch {
      setLocalError('Unable to post comment. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [draft, onPost, posting, submitting])

  const error = postError ?? localError
  const canSubmit = draft.trim().length > 0 && !posting && !submitting

  return <form className="pull-request-comment-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <div className="pull-request-comment-composer-head">
      <Avatar initials={viewer?.initials || initialsFor(viewer?.label || 'me')} className="small" />
      <div>
        <strong>{display(viewer?.label, 'GitHub viewer')}</strong>
        <span>Start a pull request conversation</span>
      </div>
    </div>
    <label className="pull-request-comment-label" htmlFor={`pull-request-comment-${pullNumber}`}>Comment on pull request #{pullNumber}</label>
    <textarea
      ref={textareaRef}
      id={`pull-request-comment-${pullNumber}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void submit()
        }
      }}
      maxLength={MAX_COMMENT_LENGTH}
      rows={4}
      placeholder="Write a comment…"
      aria-describedby={`pull-request-comment-note-${pullNumber}`}
    />
    <div className="pull-request-comment-composer-foot">
      <span id={`pull-request-comment-note-${pullNumber}`} className="pull-request-comment-note">GitHub Markdown renders on GitHub; Atlas preserves the source and line breaks.</span>
      <button className="primary-button" type="submit" disabled={!canSubmit}><Send size={13} aria-hidden="true" /> Comment</button>
    </div>
    {error && <p className="pull-request-comment-error" role="alert">{error}</p>}
    {successMessage && <p className="pull-request-comment-success" role="status" aria-live="polite">{successMessage}</p>}
  </form>
}

export default function PullRequestComments({ pullNumber, viewer, live, resource, posting, postError, successMessage, onPost, onRefresh }: PullRequestCommentsProps) {
  const comments = useMemo(() => [...resource.comments].sort(commentOrder), [resource.comments])
  const hasComments = comments.length > 0

  return <section className="pull-request-comments" aria-labelledby={`pull-request-comments-heading-${pullNumber}`}>
    <div className="pull-request-comments-heading">
      <div>
        <div className="eyebrow">Conversation context</div>
        <h3 id={`pull-request-comments-heading-${pullNumber}`}>PR conversation</h3>
      </div>
      <button className="secondary-button" type="button" onClick={onRefresh} disabled={!live || resource.status === 'loading'}><RefreshCw size={13} aria-hidden="true" /> Refresh comments</button>
    </div>

    {!live && <div className="pull-request-comments-readonly" role="note"><MessageSquare size={14} aria-hidden="true" /> Read-only demo mode: comments cannot be published without the authenticated desktop API.</div>}

    {live && <CommentComposer pullNumber={pullNumber} viewer={viewer} posting={posting} postError={postError} successMessage={successMessage} onPost={onPost} />}

    <div className="pull-request-comments-list" aria-live="polite">
      {resource.status === 'idle' && <div className="pull-request-comments-state">Comments will load when this pull request is selected.</div>}
      {resource.status === 'loading' && <div className="pull-request-comments-state"><LoaderCircle size={14} className="pull-request-comments-spinner" aria-hidden="true" /> Loading comments</div>}
      {resource.status === 'error' && <div className="pull-request-comments-error" role="alert"><span>{display(resource.error, 'Unable to load comments.')}{hasComments && ' Showing last loaded comments.'}</span><button className="secondary-button" type="button" onClick={onRefresh} disabled={!live}>Retry</button></div>}
      {resource.status === 'ready' && !hasComments && <div className="pull-request-comments-state"><MessageSquare size={15} aria-hidden="true" /> No conversation comments yet</div>}
      {hasComments && <div className="pull-request-comments-items">{comments.map((comment) => <CommentItem key={`${comment.id}-${comment.nodeId}`} comment={comment} />)}</div>}
    </div>
  </section>
}

export { CommentItem }
