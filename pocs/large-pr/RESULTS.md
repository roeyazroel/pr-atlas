# Large-PR analysis PoC results

Benchmark input: the captured deterministic inputs for PR #9, containing 34
changed files, 16,288 additions, 2,457 deletions, an 865,111-byte full diff,
and 536,285 bytes of GitHub file metadata/patches. Provider measurements used
the installed Codex CLI with `gpt-5.6-sol`, read-only sandboxing, ephemeral
sessions, ignored user rules/config, and structured output.

| Approach | Measured provider wall time | Output quality | Decision |
| --- | ---: | --- | --- |
| Existing monolithic scan | 20:00 timeout | No document; persisted timeout diagnostics | Baseline failure |
| File-batched map/reduce | 1:33 maps + 3:31 full-schema reduce = **5:04** | Atlas 1.1 valid; 5 groups, 5 steps, 36 evidence items across 18 paths, 8 tests, four valid graphs | **Winner** |
| Deterministic context reduction | **2:14** | Atlas 1.1 valid, but only 3 groups, 13 evidence items across 12 paths, 4 tests, and 16 limitations | Reject as primary path; possible preprocessor |
| Parallel review lenses | Replay-only 4x critical-path estimate | Prompts under 3 KB, but 29 of 34 changed files were uncited | Reject as primary path |

## File-batched evidence

The deterministic planner produced five complete-file chunks. It preserved all
34 changed files without duplication, reduced the largest per-map prompt by
70.69%, and estimated a 2.92x map-stage speedup at four workers. The five real
provider maps completed in about 93 seconds and yielded 17 pre-merge groups and
72 exact evidence items. A canonical reducer then generated a complete
walkthrough that passed the production `validateWalkthroughDocument` validator.

One 252,153-byte `src/App.tsx` diff exceeded the nominal chunk ceiling and was
kept whole. A production implementation should support hunk splitting with
overlap for such files, while retaining one canonical file owner for merge and
coverage accounting.

## Why not choose the fastest result

Context reduction represented every file and retained detailed evidence for 32
text-patch files, but reducing a 120 KB evidence budget into one provider call
collapsed important cross-layer distinctions. Its result was structurally valid
yet materially shallower than batching. Parallel lenses were even more compact,
but their replay merge cited only five changed files. Structural validity alone
is therefore not sufficient parity evidence.

## Production requirements before integration

- Keep the current monolithic path for small PRs; activate batching only above a
  deterministic size threshold.
- Bound concurrency (four maps in this benchmark), expose batch progress inside
  the existing six-stage lifecycle, and allow cancellation to stop every child.
- Persist map outputs so only failed batches need retrying.
- Validate every map result and the final reducer result; never install partial
  output as Ready.
- Make coverage/no-duplicate invariants a hard reducer precondition.
- Preserve exact evidence IDs/paths and report cross-batch ambiguity as a
  limitation rather than inventing relationships.
- Handle provider rate limits and aggregate cost: batching reduced critical path
  but slightly increased aggregate prompt bytes through per-task instructions.
- Add an oversized-file strategy (bounded hunks with contextual overlap) before
  enabling batching by default.

The PoCs intentionally do not alter Atlas production execution. They establish
that bounded file maps plus a schema-validated reducer can cut this large PR from
a 20-minute timeout to roughly five minutes without falling to the shallower
result observed in the other approaches.
