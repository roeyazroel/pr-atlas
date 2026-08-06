import test from "node:test";
import assert from "node:assert/strict";
import { reduceFiles } from "./reduce.mjs";

test("preserves every changed file while removing paired formatting-only lines", () => {
  const input = [[
    { filename: "src/app.ts", status: "modified", changes: 4, patch: "@@ -1,2 +1,2 @@\n-const x=1\n+const x = 1\n-old()\n+newBehavior()" },
    { filename: "tests/app.test.ts", status: "modified", changes: 2, patch: "@@ -8 +8 @@\n-expect(old)\n+expect(newBehavior)" },
  ]];
  const { result, metrics } = reduceFiles(input, 10_000);
  assert.equal(metrics.changedFileCoverage, 1);
  assert.equal(metrics.filesRepresented, 2);
  assert.equal(result.facts[0].formattingOnlyLines, 2);
  assert.ok(result.facts.flatMap((file) => file.evidence).some((entry) => entry[1].includes("newBehavior")));
  assert.ok(!result.facts.flatMap((file) => file.evidence).some((entry) => entry[1].includes("const x")));
  assert.ok(result.facts.flatMap((file) => file.evidence).every((entry) => Number.isInteger(entry[0])));
});

test("uses deterministic ranking and reports context omitted by a byte budget", () => {
  const input = [
    { filename: "README.md", changes: 1, patch: "@@ -1 +1 @@\n-old\n+documentation" },
    { filename: "src/core.ts", changes: 1, patch: "@@ -1 +1 @@\n-old\n+importantBehavior" },
  ];
  const first = reduceFiles(input, 20);
  const second = reduceFiles([...input].reverse(), 20);
  assert.deepEqual(first, second);
  assert.ok(first.result.droppedContext.some((entry) => entry.reason === "byte-budget"));
  assert.equal(first.metrics.changedFileCoverage, 1);
});

test("allocates an evidence floor across semantic files before spending the remaining budget", () => {
  const input = Array.from({ length: 4 }, (_, index) => ({
    filename: `src/file-${index}.ts`,
    changes: 2,
    patch: `@@ -1 +1 @@\n-old${index}\n+newBehavior${index}`,
  }));
  const { metrics } = reduceFiles(input, 1_000);
  assert.equal(metrics.detailedFiles, 4);
});
