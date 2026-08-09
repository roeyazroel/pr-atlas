import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeDocumentEvidencePaths,
  readEvidenceDetail,
  resolveEvidencePath,
} from "../../electron/backend/evidence";
import type { ReviewDocument } from "../../shared/contracts";

describe("local evidence path resolution", () => {
  it("resolves an existing file inside the exact managed worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "acme",
      "repo",
      "abc1234",
    );
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "App.tsx"), "export {}\n");
    await expect(
      resolveEvidencePath(root, "acme/repo", "abc1234", "src/App.tsx"),
    ).resolves.toBe(join(worktree, "src", "App.tsx"));
  });

  it("rejects traversal, invalid revisions, and missing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    await expect(
      resolveEvidencePath(root, "acme/repo", "abc1234", "../secret"),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      resolveEvidencePath(root, "acme/repo", "../../escape", "src/App.tsx"),
    ).rejects.toThrow(/revision/i);
    await expect(
      resolveEvidencePath(root, "acme/repo", "abc1234", "src/missing.ts"),
    ).rejects.toThrow(/not found/i);
  });

  it("accepts exact absolute evidence only inside the matching managed worktree or analysis input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "acme",
      "repo",
      "abc1234",
    );
    const input = join(
      root,
      "analyses",
      "github.com",
      "acme",
      "repo",
      "42",
      "abc1234",
      "run-1",
      "input",
    );
    await mkdir(join(worktree, "src"), { recursive: true });
    await mkdir(input, { recursive: true });
    const source = join(worktree, "src", "App.tsx");
    const diff = join(input, "diff.patch");
    await writeFile(source, "export {}\n");
    await writeFile(diff, "diff --git\n");

    await expect(
      resolveEvidencePath(root, "acme/repo", "abc1234", source),
    ).resolves.toBe(source);
    await expect(
      resolveEvidencePath(root, "acme/repo", "abc1234", diff),
    ).resolves.toBe(diff);
    await expect(
      resolveEvidencePath(root, "acme/other", "abc1234", source),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      resolveEvidencePath(root, "acme/repo", "def5678", diff),
    ).rejects.toThrow(/unsafe/i);
  });

  it("normalizes every provider evidence path to an exact openable file before Ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "acme",
      "repo",
      "abc1234",
    );
    const input = join(
      root,
      "analyses",
      "github.com",
      "acme",
      "repo",
      "42",
      "abc1234",
      "run-1",
      "input",
    );
    await mkdir(join(worktree, "src"), { recursive: true });
    await mkdir(input, { recursive: true });
    await writeFile(join(worktree, "src", "App.tsx"), "export {}\n");
    await writeFile(join(input, "diff.patch"), "diff --git\n");
    const document = {
      evidence: [
        {
          id: "source",
          kind: "file",
          title: "App",
          path: "src/App.tsx",
          line: null,
          url: null,
        },
        {
          id: "diff",
          kind: "diff",
          title: "Diff",
          path: "diff.patch",
          line: null,
          url: null,
        },
      ],
    } as ReviewDocument;

    const normalized = await normalizeDocumentEvidencePaths(
      root,
      "acme/repo",
      "abc1234",
      worktree,
      input,
      document,
    );
    expect(normalized.evidence[0].path).toBe("src/App.tsx");
    expect(normalized.evidence[1].path).toBe(join(input, "diff.patch"));
    await expect(
      normalizeDocumentEvidencePaths(
        root,
        "acme/repo",
        "abc1234",
        worktree,
        input,
        {
          ...document,
          evidence: [
            {
              id: "bad",
              kind: "file",
              title: "Directory",
              path: "src",
              line: null,
              url: null,
            },
          ],
        },
      ),
    ).rejects.toThrow(/not a file/i);
  });

  it("reads only the bounded prefix of a large text evidence file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "acme",
      "repo",
      "abc1234",
    );
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(
      join(worktree, "src", "large.ts"),
      `export const marker = true\n${"x".repeat(700 * 1024)}`,
    );

    const detail = await readEvidenceDetail(
      root,
      "acme/repo",
      "abc1234",
      "src/large.ts",
    );
    expect(detail.content).toContain("export const marker = true");
    expect(detail.content.length).toBeLessThan(512 * 1024 + 1_000);
  });

  it("rejects binary evidence instead of rendering decoded bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const worktree = join(
      root,
      "worktrees",
      "github.com",
      "acme",
      "repo",
      "abc1234",
    );
    await mkdir(join(worktree, "assets"), { recursive: true });
    await writeFile(
      join(worktree, "assets", "payload.bin"),
      Buffer.from([0, 255, 2, 3]),
    );

    await expect(
      readEvidenceDetail(root, "acme/repo", "abc1234", "assets/payload.bin"),
    ).rejects.toThrow(/binary|text/i);
  });

  it("keeps hunk source lines while excluding metadata between files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-atlas-evidence-"));
    const input = join(
      root,
      "analyses",
      "github.com",
      "acme",
      "repo",
      "42",
      "abc1234",
      "run-1",
      "input",
    );
    await mkdir(input, { recursive: true });
    const diff = join(input, "diff.patch");
    await writeFile(
      diff,
      [
        "diff --git a/src/one.ts b/src/one.ts",
        "index 111..222 100644",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/two.ts b/src/two.ts",
        "index 333..444 100644",
        "--- a/src/two.ts",
        "+++ b/src/two.ts",
        "@@ -3 +3 @@",
        "--- value",
        "+++ value",
      ].join("\n"),
    );

    const detail = await readEvidenceDetail(
      root,
      "acme/repo",
      "abc1234",
      diff,
    );
    expect(detail.hunks).toEqual([
      { header: "@@ -1 +1 @@", content: "-old\n+new" },
      { header: "@@ -3 +3 @@", content: "--- value\n+++ value" },
    ]);
  });
});
