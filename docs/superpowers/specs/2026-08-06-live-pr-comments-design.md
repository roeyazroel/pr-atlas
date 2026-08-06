# Live Pull Request Comments Design

## Status

Approved product direction for implementation on 2026-08-06.

## Goal

PR Atlas must show the selected pull request's live GitHub conversation and let the authenticated user publish a new top-level pull request comment without leaving Atlas. A comment confirmed by GitHub must become visible in Atlas immediately.

## Product Decisions

- "Two-way" means reading and writing the pull request conversation.
- The first complete writing flow covers top-level pull request comments. It does not create line-specific review comments or reply to existing review threads.
- Every GitHub read and write uses the user's existing authenticated `gh` CLI session. PR Atlas will not add OAuth, token storage, or another login.
- Live conversation comments are independent of analysis runs. They work when a pull request is unprocessed, processing, ready, outdated, failed, or cancelled.
- Existing code review threads remain visible as analysis-linked context. They are not presented as live conversation data.

## UX

### Navigation

Rename the current **Review threads** navigation item to **Comments**. The view contains two visually distinct sections without nesting cards inside cards:

1. **PR conversation** — live GitHub comments and the composer.
2. **Code review threads** — the existing walkthrough-derived inline review threads.

The Comments tab badge shows the number of live conversation comments once loaded. Walkthrough thread counts remain inside the code review section so live and snapshot data are not conflated.

### Conversation loading

Load comments for the selected live pull request only. Do not fetch comments for every pull request in the repository list.

The conversation surface has explicit states:

- Loading: a compact progress row that does not shift the composer.
- Loaded: chronological comments, oldest first.
- Empty: "No conversation comments yet" with the composer still available.
- Failed: a sanitized inline error and a **Retry** control.
- Demo/browser fixture: a clear read-only message because no authenticated Electron API exists.

A **Refresh comments** control reloads the selected pull request. The global repository refresh also invalidates the selected pull request's comment cache so the next render fetches current data.

### Composer

Place the composer before the conversation list so writing is discoverable. It contains:

- The authenticated viewer identity when available.
- A multiline field labelled `Comment on pull request #<number>`.
- A concise note that GitHub Markdown can be entered and will render on GitHub. Atlas preserves line breaks and Markdown source in this release; it does not execute or inject comment HTML.
- A **Comment** primary action.
- `Command+Enter` on macOS and `Control+Enter` elsewhere as a keyboard shortcut.

The action is disabled for blank input and while a write is in flight. Input is trimmed before submission and bounded to 65,536 UTF-16 code units in both the renderer and main process.

On success, Atlas appends the canonical comment returned by GitHub, clears the draft, moves focus back to the composer, and exposes a polite status message. It does not use an optimistic placeholder; only a GitHub-confirmed comment is shown as published.

On failure, Atlas keeps the draft, re-enables the action, and shows a generic actionable error. A retry cannot create a duplicate unless the user explicitly submits again after the failed request has settled.

### Comment presentation

Each live comment shows:

- Author login and avatar when available.
- Author association when GitHub supplies it.
- Body with preserved line breaks.
- Created time and an edited indicator when `updatedAt` differs from `createdAt`.
- A safe external link to the canonical GitHub comment.

Remote comment HTML is never injected into the renderer. Remote images embedded in Markdown are not fetched by Atlas in this release.

## Architecture

### Shared contract

Add a provider-neutral `PullRequestComment` DTO to `shared/contracts.ts`:

```ts
export interface PullRequestComment {
  id: number;
  nodeId: string;
  body: string;
  author: string;
  authorAvatarUrl: string | null;
  authorAssociation: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  viewerDidAuthor: boolean;
}
```

Extend `PrAtlasApi` with required Electron methods:

```ts
listPullRequestComments(
  repository: string,
  pullNumber: number,
): Promise<PullRequestComment[]>;

createPullRequestComment(
  repository: string,
  pullNumber: number,
  body: string,
): Promise<PullRequestComment>;
```

The renderer receives only normalized fields. Raw GitHub payloads and command diagnostics stay in the main process.

### GitHub client

Add two methods to `GithubClient` in `electron/backend/github.ts`.

Read with the issue-comments endpoint because GitHub models top-level pull request conversation comments as issue comments:

```text
gh api --paginate --slurp repos/{owner}/{repo}/issues/{pullNumber}/comments?per_page=100
```

Write with:

```text
gh api --method POST repos/{owner}/{repo}/issues/{pullNumber}/comments -f body=<comment>
```

Both calls use the existing `CommandRunner`, which invokes `execFile` with a fixed argument array. No shell command is constructed. The read path flattens paginated arrays, ignores malformed records, maps valid records deterministically, and returns chronological order. The write path requires one valid returned comment and maps it through the same normalizer.

`viewerDidAuthor` compares the comment author's login against the viewer established by `bootstrap()`. It is additive presentation metadata and never controls authorization.

### IPC and preload

Add narrow delegation methods to `AnalysisService`, which already owns the shared `GithubClient`, then register `pr-atlas:list-pr-comments` and `pr-atlas:create-pr-comment` handlers in `electron/main.ts`. The main process must not create a second GitHub client or a second authentication path. Validate at the IPC boundary:

- Repository through `validateRepository`.
- Pull request number through `validatePullNumber`.
- Body as a string whose trimmed length is 1 through 65,536.

Invalid input is rejected before calling `GithubClient`. GitHub and CLI failures return the existing sanitized GitHub error; stderr, command paths, tokens, and response bodies do not cross IPC.

Expose exact typed wrappers in `electron/preload.ts`. No generic command execution capability is exposed to the renderer.

### Renderer state

Keep a comment resource keyed by the stable live pull request ID:

```ts
type CommentResource = {
  status: "idle" | "loading" | "ready" | "error";
  comments: PullRequestComment[];
  error: string | null;
};
```

Loading is selected-PR scoped. A cancellation flag prevents a late response from one pull request from overwriting another pull request's visible conversation. Posting captures the repository and pull request number at submission time, then applies the result only to the matching resource key.

Extract the live conversation and composer into a focused component rather than expanding the already-large `App.tsx`. `App.tsx` owns Electron calls and per-PR resources; the component owns draft text, focus, keyboard submission, and presentation.

Key the component by live pull request ID so React creates an isolated draft for each selected pull request. A pull request switch unmounts the previous composer instead of carrying its draft into another conversation.

`ThreadsView.tsx` becomes the composed Comments view. Its current review-thread rendering remains intact below the new live conversation component.

## Error Handling and Consistency

- A successful POST response is authoritative and is appended by `id` only if not already present.
- A manual refresh replaces the resource with the server list and therefore reconciles edits or deletions made on GitHub.
- A read failure does not hide a previously loaded list; it shows a refresh error alongside the last known comments.
- A write failure never clears the draft or appends a local-only comment.
- Switching repositories or pull requests cannot leak drafts, comments, errors, or pending results across pull requests.
- Comments are sorted by `createdAt`, with numeric `id` as the stable tie-breaker.

## Tests

Follow red-green-refactor for every behavior.

### Backend

- Paginated issue-comment responses flatten and map to the exact DTO.
- Malformed records are ignored without fabricating comments.
- The read command uses the validated endpoint and pagination flags.
- The write command sends the exact comment body as one `execFile` argument.
- A successful write returns the canonical mapped comment.
- Empty, non-string, oversized, invalid repository, and invalid pull number payloads are rejected at IPC validation.
- GitHub failures are sanitized.

### Renderer

- Selecting a live pull request loads its conversation independently of analysis status.
- Existing comments render oldest first with author, body, metadata, and safe link.
- Empty and failed reads expose the intended retry states.
- Blank drafts cannot submit.
- `Command+Enter` or `Control+Enter` submits once.
- The submit button disables during the request.
- A successful GitHub response becomes visible immediately and clears the draft.
- A failed write preserves the draft and displays a retryable error.
- Switching pull requests isolates resources and ignores stale responses.
- Existing walkthrough review threads remain visible below the live conversation.
- Browser/demo mode stays read-only and does not claim a comment was published.

### Validation

Run focused backend and renderer tests, the complete Vitest suite, both TypeScript checks, the production build, and `git diff --check`. Inspect the Comments view at desktop and narrow widths in light and dark themes, including loading, empty, error, posting, and populated states.

## Non-goals

- Starting line-specific review threads.
- Replying to inline review comments.
- Editing, deleting, minimizing, reacting to, resolving, or unresolving comments.
- Rendering arbitrary GitHub-provided HTML.
- Replacing GitHub CLI authentication.
- Folding live conversation comments back into an existing generated walkthrough without a new analysis run.
