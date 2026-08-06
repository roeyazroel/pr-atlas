import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PullRequestComment } from '../../shared/contracts'
import PullRequestComments, { type CommentResource } from '../../src/components/PullRequestComments'

const viewer = { label: 'Roey Azroel', initials: 'RA' }

const comment = (overrides: Partial<PullRequestComment> = {}): PullRequestComment => ({
  id: 42,
  nodeId: 'IC_kwDO42',
  body: 'A first line\nA second line',
  author: 'octocat',
  authorAvatarUrl: null,
  authorAssociation: 'CONTRIBUTOR',
  createdAt: '2026-08-05T09:00:00.000Z',
  updatedAt: '2026-08-05T09:05:00.000Z',
  url: 'https://github.com/acme/widgets/issues/7#issuecomment-42',
  viewerDidAuthor: false,
  ...overrides,
})

const resource = (overrides: Partial<CommentResource> = {}): CommentResource => ({
  status: 'ready',
  comments: [],
  error: null,
  ...overrides,
})

function renderComments(overrides: Partial<React.ComponentProps<typeof PullRequestComments>> = {}) {
  const props: React.ComponentProps<typeof PullRequestComments> = {
    pullNumber: 7,
    viewer,
    live: true,
    resource: resource(),
    posting: false,
    postError: null,
    successMessage: null,
    onPost: vi.fn(async () => true),
    onRefresh: vi.fn(),
    ...overrides,
  }
  return { ...render(<PullRequestComments {...props} />), props }
}

describe('PullRequestComments', () => {
  it('keeps Comment disabled for blank input and enforces the textarea limit', async () => {
    const user = userEvent.setup()
    renderComments()

    const textarea = screen.getByRole('textbox', { name: 'Comment on pull request #7' })
    const submit = screen.getByRole('button', { name: 'Comment' })
    expect(submit).toBeDisabled()
    await user.type(textarea, '   ')
    expect(submit).toBeDisabled()
    expect(textarea).toHaveAttribute('maxlength', '65536')
  })

  it('submits a trimmed draft, clears and refocuses after success, and renders the parent comment', async () => {
    const user = userEvent.setup()
    const onPost = vi.fn(async () => true)
    const view = renderComments({ onPost })
    const textarea = screen.getByRole('textbox', { name: 'Comment on pull request #7' })
    await user.type(textarea, '  hello GitHub  ')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(onPost).toHaveBeenCalledWith('hello GitHub'))
    expect(textarea).toHaveValue('')
    expect(textarea).toHaveFocus()

    view.rerender(<PullRequestComments {...view.props} resource={resource({ comments: [comment({ body: 'hello GitHub' })] })} />)
    expect(screen.getByText('hello GitHub')).toBeInTheDocument()
  })

  it('preserves the draft when posting fails', async () => {
    const user = userEvent.setup()
    const onPost = vi.fn(async () => false)
    renderComments({ onPost, postError: 'Unable to post comment. Try again.' })
    const textarea = screen.getByRole('textbox', { name: 'Comment on pull request #7' })
    await user.type(textarea, 'keep this draft')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(onPost).toHaveBeenCalledOnce())
    expect(textarea).toHaveValue('keep this draft')
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to post comment')
  })

  it('uses Cmd/Ctrl+Enter as one submit shortcut', async () => {
    const user = userEvent.setup()
    const onPost = vi.fn(async () => true)
    renderComments({ onPost })
    const textarea = screen.getByRole('textbox', { name: 'Comment on pull request #7' })
    await user.type(textarea, 'shortcut')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(onPost).toHaveBeenCalledWith('shortcut'))
    expect(onPost).toHaveBeenCalledOnce()
  })

  it('exposes loading, empty, stale error, and read-only states', () => {
    const { rerender } = renderComments({ resource: resource({ status: 'loading' }) })
    expect(screen.getByText('Loading comments')).toBeInTheDocument()
    rerender(<PullRequestComments pullNumber={7} viewer={viewer} live resource={resource({ status: 'ready' })} posting={false} postError={null} successMessage={null} onPost={vi.fn(async () => true)} onRefresh={vi.fn()} />)
    expect(screen.getByText('No conversation comments yet')).toBeInTheDocument()
    rerender(<PullRequestComments pullNumber={7} viewer={viewer} live resource={resource({ status: 'error', comments: [comment()], error: 'GitHub is unavailable' })} posting={false} postError={null} successMessage={null} onPost={vi.fn(async () => true)} onRefresh={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub is unavailable')
    expect(screen.getByRole('article')).toHaveTextContent('A first line')
    rerender(<PullRequestComments pullNumber={7} viewer={viewer} live={false} resource={resource({ comments: [comment()] })} posting={false} postError={null} successMessage={null} onPost={vi.fn(async () => true)} onRefresh={vi.fn()} />)
    expect(screen.getByRole('note')).toHaveTextContent(/read-only/i)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('renders oldest first with author metadata, preserved body, and a safe external link', () => {
    const newest = comment({ id: 43, body: 'newest', createdAt: '2026-08-06T09:00:00.000Z', updatedAt: '2026-08-06T09:00:00.000Z', url: 'http://evil.example/comments/43' })
    const javascript = comment({ id: 44, body: 'unsafe', createdAt: '2026-08-07T09:00:00.000Z', updatedAt: '2026-08-07T09:00:00.000Z', url: 'javascript:alert(1)' })
    const oldest = comment({ id: 42, body: 'oldest\nwith line break', createdAt: '2026-08-05T09:00:00.000Z', updatedAt: '2026-08-05T09:10:00.000Z' })
    renderComments({ resource: resource({ comments: [newest, javascript, oldest] }) })
    const items = screen.getAllByRole('article')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('oldest')
    expect(items[0]).toHaveTextContent('CONTRIBUTOR')
    expect(items[0]).toHaveTextContent('edited')
    expect(items[0].querySelector('a')).toHaveAttribute('href', oldest.url)
    expect(items[1].querySelector('a')).toBeNull()
    expect(items[2].querySelector('a')).toBeNull()
    expect(within(items[0]).getByText(/with line break/)).toBeInTheDocument()
  })

  it('renders a narrowly trusted GitHub avatar when the comment provides one', () => {
    const avatarUrl = 'https://avatars.githubusercontent.com/u/42?v=4'
    renderComments({ resource: resource({ comments: [comment({ authorAvatarUrl: avatarUrl })] }) })
    expect(screen.getByRole('img', { name: 'octocat avatar' })).toHaveAttribute('src', avatarUrl)
  })

  it('rejects lookalike avatar hosts and falls back to initials', () => {
    renderComments({ resource: resource({ comments: [comment({ authorAvatarUrl: 'https://avatars.githubusercontent.com.evil.example/u/42' })] }) })
    const article = screen.getByRole('article')
    expect(within(article).queryByRole('img')).not.toBeInTheDocument()
    expect(within(article).getByText('OC')).toBeInTheDocument()
  })

  it('falls back to initials when a trusted avatar fails to load', () => {
    renderComments({ resource: resource({ comments: [comment({ authorAvatarUrl: 'https://avatars.githubusercontent.com/u/42' })] }) })
    const article = screen.getByRole('article')
    fireEvent.error(within(article).getByRole('img', { name: 'octocat avatar' }))
    expect(within(article).queryByRole('img')).not.toBeInTheDocument()
    expect(within(article).getByText('OC')).toBeInTheDocument()
  })
})
