# Parallel large-PR review lenses PoC

## Hypothesis

For a large pull request, deriving compact shared facts once and assigning four
independent, bounded review lenses can reduce the provider critical path without
making the final walkthrough ambiguous. The merge must retain contradictory claims,
deduplicate repeated evidence, and expose file-coverage gaps instead of hiding them.

The four lenses are `behavior-architecture`, `tests`, `risk-reviews`, and
`files-flows`. They receive a compact fact projection and stable evidence IDs—not
the raw diff—so their prompts are bounded and replayable.

## Run

```sh
npx vitest --config vitest.config.ts run pocs/large-pr/lens-parallel/lens-parallel.test.mjs
node pocs/large-pr/lens-parallel/benchmark.mjs \
  '/Users/roeyazroel/Library/Application Support/Electron/analyses/github.com/roeyazroel/pr-atlas/9/409c6dbd44ce88dcb7602598f5ff3c56b3093193/8fab17aa-4367-4996-935d-201279627495/input' \
  --out pocs/large-pr/lens-parallel/output/pr-9-report.json
```

The benchmark only reads the saved artifact and uses deterministic replay outputs;
it makes no provider or network calls. The report includes prompt bytes per task,
duplicate-evidence occurrences, conflicts, uncovered files, and estimated parallel
critical path (the maximum bounded task work units, versus the serial sum).

## Risks and limits

- The replay results test orchestration and merge semantics, not model quality.
- Compact facts deliberately omit raw diff text; a production implementation must
  provide a safe, on-demand evidence resolver for claims that require line detail.
- File coverage measures cited file paths, not semantic completeness.
- Contradictions are reported for reviewer resolution, not automatically adjudicated.
