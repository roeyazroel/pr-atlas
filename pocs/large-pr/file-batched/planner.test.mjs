import { describe, expect, it } from "vitest";

import {
  buildFileBatchedPlan,
  buildReduceInput,
  loadAtlasInput,
  summarizePlan,
} from "./planner.mjs";

const pr9Input =
  "/Users/roeyazroel/Library/Application Support/Electron/analyses/github.com/roeyazroel/pr-atlas/9/409c6dbd44ce88dcb7602598f5ff3c56b3093193/8fab17aa-4367-4996-935d-201279627495/input";

describe("file-batched large PR PoC", () => {
  it("loads every PR #9 changed file and derives its diff-byte cost from the patch", async () => {
    const run = await loadAtlasInput(pr9Input);

    expect(run.files.length).toBeGreaterThan(25);
    expect(new Set(run.files.map((file) => file.path)).size).toBe(run.files.length);
    expect(run.files.every((file) => file.diffBytes >= 0)).toBe(true);
    expect(run.files.some((file) => file.path === "electron/backend/agent.ts" && file.diffBytes > 0)).toBe(true);
  });

  it("creates deterministic bounded chunks while preferring files from the same subsystem", () => {
    const files = [
      { path: "api/users/a.ts", diffBytes: 90 },
      { path: "api/users/b.ts", diffBytes: 90 },
      { path: "ui/table/c.tsx", diffBytes: 80 },
      { path: "ui/table/d.tsx", diffBytes: 80 },
    ];
    const options = { maxChunkBytes: 180, parallelism: 2, sharedPromptBytes: 20 };

    const plan = buildFileBatchedPlan(files, options);
    const reorderedPlan = buildFileBatchedPlan([...files].reverse(), options);

    expect(plan.chunks.map((chunk) => chunk.files.map((file) => file.path))).toEqual([
      ["api/users/a.ts", "api/users/b.ts"],
      ["ui/table/c.tsx", "ui/table/d.tsx"],
    ]);
    expect(plan.chunks.every((chunk) => chunk.diffBytes <= options.maxChunkBytes)).toBe(true);
    expect(reorderedPlan).toEqual(plan);
  });

  it("builds deterministic reduce input and exposes coverage, balance, and critical-path metrics", () => {
    const plan = buildFileBatchedPlan(
      [
        { path: "backend/a.ts", diffBytes: 180 },
        { path: "backend/b.ts", diffBytes: 120 },
        { path: "ui/c.tsx", diffBytes: 70 },
      ],
      { maxChunkBytes: 200, parallelism: 2, sharedPromptBytes: 50 },
    );
    const outputs = plan.mapTasks
      .slice()
      .reverse()
      .map((task) => ({ taskId: task.id, findings: [{ path: task.files[0].path, note: task.id }] }));

    const reduce = buildReduceInput(plan, outputs);
    const summary = summarizePlan(plan);

    expect(reduce.mapResults.map((result) => result.taskId)).toEqual(plan.mapTasks.map((task) => task.id));
    expect(summary.coverage).toMatchObject({ missing: [], duplicated: [], complete: true });
    expect(summary.chunkBalance.minBytes).toBe(180);
    expect(summary.chunkBalance.maxBytes).toBe(190);
    expect(summary.parallel.criticalPathBytes).toBeLessThan(summary.parallel.serialBytes);
    expect(summary.prompt.perCallReductionPercent).toBeGreaterThan(0);
    expect(() => buildReduceInput(plan, outputs.slice(1))).toThrow(/missing map output/i);
  });
});
