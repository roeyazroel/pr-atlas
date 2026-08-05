# File-batched large-PR map/reduce PoC

Hypothesis: for a large PR, independent file batches keep each provider call well below the full-diff prompt while retaining every changed file and producing a canonical reduce payload. The planner packs complete diff sections up to a byte ceiling, preferring files from the same parent-directory subsystem; it never splits a file. A file larger than the ceiling is retained intact and reported as an explicit exception.

Run against the captured PR #9 input (no provider call is made):

```sh
node pocs/large-pr/file-batched/cli.mjs \
  --input '/Users/roeyazroel/Library/Application Support/Electron/analyses/github.com/roeyazroel/pr-atlas/9/409c6dbd44ce88dcb7602598f5ff3c56b3093193/8fab17aa-4367-4996-935d-201279627495/input' \
  --max-chunk-bytes 163840 --parallelism 4 --out /tmp/pr-atlas-file-batched-pr9
```

The command prints coverage/no-drop invariants, chunk-balance metrics, a byte-based parallel critical-path estimate, and the **per-call** prompt reduction relative to one full-diff call. It also writes replayable `map-tasks.json`, blank structured map-output templates, and a deterministic reduce-input template. Later benchmarks can invoke a provider per task and pass all completed outputs to `buildReduceInput`; the reducer rejects missing, duplicate, or unknown task IDs and orders accepted results by task ID.

Correctness risk: a finding whose evidence spans chunks can be missed or merged poorly. The reduce contract therefore preserves source task IDs and paths, but a production design would need explicit cross-chunk dependency routing and a schema-validated reducer. Merge risk: this PoC only establishes planning/replay mechanics; it deliberately makes no changes to Atlas ingestion, provider execution, prompts, or UI.

Validation:

```sh
npx vitest run pocs/large-pr/file-batched/planner.test.mjs
```
