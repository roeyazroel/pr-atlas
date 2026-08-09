// @vitest-environment node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtlasApiCoordinator, startAtlasCoordinator } from "../../electron/backend/coordinator";

describe("coordinator MCP stdio bridge", () => {
  let bridgeDirectory = "";
  let bridgePath = "";

  beforeAll(async () => {
    bridgeDirectory = await mkdtemp(join(tmpdir(), "pr-atlas-mcp-bundle-"));
    bridgePath = join(bridgeDirectory, "coordinator-mcp.cjs");
    await build({
      entryPoints: [resolve("electron/backend/coordinator-mcp.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bridgePath,
    });
  });

  afterAll(async () => {
    if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
  });

  it("advertises and serves bearer-scoped sanitized PR context alongside the strict submit schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-atlas-mcp-"));
    const coordinator = new AtlasApiCoordinator(directory, { repository: "acme/atlas", pullNumber: 9, baseSha: "a".repeat(40), headSha: "b".repeat(40) }, new Set(), undefined, (value) => value, { pullRequest: { title: "Atlas PR", path: "/private/worktree" }, reviewThreads: [], reviews: [], issueComments: [], reviewComments: [] });
    const server = await startAtlasCoordinator(coordinator); const task = coordinator.task("anchor");
    try {
      const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ATLAS_COORDINATOR_URL: server.url, ATLAS_TASK_TOKEN: task.token }, stdio: ["pipe", "pipe", "pipe"] });
      const lines: Array<Record<string, unknown>> = [];
      const done = new Promise<void>((resolveDone, reject) => { child.stdout.setEncoding("utf8"); let buffer = ""; child.stdout.on("data", (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); if (lines.length === 4) resolveDone(); } }); child.on("error", reject); });
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      child.stdin.write('{"jsonrpc":"2.0","method":"unknown-notification"}\n');
      child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
      child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_pr_context","arguments":{}}}\n');
      child.stdin.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"preflight_result","arguments":{"result":{"taskId":"anchor"}}}}\n');
      await done; child.kill();
      expect(new Set(lines.map((line) => line.id))).toEqual(new Set([1, 2, 3, 4]));
      const byId = new Map(lines.map((line) => [line.id, line]));
      const tools = ((byId.get(2)?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools);
      const submit = tools.find((tool) => tool.name === "submit_result");
      const preflight = tools.find((tool) => tool.name === "preflight_result");
      const progress = tools.find((tool) => tool.name === "report_progress");
      expect(tools.find((tool) => tool.name === "get_pr_context")?.inputSchema).toMatchObject({ additionalProperties: false });
      expect(submit?.inputSchema).toEqual({ type: "object", additionalProperties: false, required: ["idempotencyKey", "preflightId"], properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 200 }, preflightId: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" } } });
      expect(preflight?.inputSchema).toMatchObject({ additionalProperties: false, properties: { result: { additionalProperties: false, properties: { taskId: { const: "anchor" } } } } });
      expect(progress?.inputSchema).toMatchObject({ additionalProperties: false, properties: { state: { enum: ["pending", "running", "complete", "failed"] }, detail: { type: "string", maxLength: 1000 } } });
      expect(JSON.parse(((((byId.get(3)?.result as { content: Array<{ text: string }> }).content[0]).text)))).toEqual({ pullRequest: { title: "Atlas PR" }, reviewThreads: [], reviews: [], issueComments: [], reviewComments: [] });
      expect(JSON.parse(((((byId.get(4)?.result as { content: Array<{ text: string }> }).content[0]).text)))).toMatchObject({ valid: false, errors: [expect.any(String)] });
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("projects submit_result to its receipt fields before forwarding oversized extra model arguments", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ATLAS_COORDINATOR_URL: `http://127.0.0.1:${address.port}`, ATLAS_TASK_TOKEN: "test-token" }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const reply = new Promise<Record<string, unknown>>((resolveReply, reject) => { child.stdout.setEncoding("utf8"); let buffer = ""; child.stdout.on("data", (chunk) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index >= 0) resolveReply(JSON.parse(buffer.slice(0, index))); }); child.once("error", reject); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_result", arguments: { idempotencyKey: "receipt-only", preflightId: "a".repeat(43), result: { hugeCandidate: "x".repeat(2 * 1024 * 1024) }, unexpected: "discard-me" } } })}\n`);
      await expect(reply).resolves.toMatchObject({ result: { content: [expect.objectContaining({ type: "text" })] } });
      expect(received).toEqual([{ idempotencyKey: "receipt-only", preflightId: "a".repeat(43) }]);
    } finally {
      child.kill();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("terminates rather than retaining an oversized unterminated JSONL frame", async () => {
    const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ATLAS_COORDINATOR_URL: "http://127.0.0.1:1", ATLAS_TASK_TOKEN: "test-token" }, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolveClosed({ code, signal })); });
    try {
      child.stdin.write(Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
      const result = await Promise.race([
        closed,
        new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 750)),
      ]);
      expect(result).not.toBe("timeout");
      if (result !== "timeout") expect(result.code).not.toBe(0);
    } finally {
      child.kill();
    }
  });

  it("terminates on a complete JSONL frame that exceeds the HTTP-sized input cap", async () => {
    const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ATLAS_COORDINATOR_URL: "http://127.0.0.1:1", ATLAS_TASK_TOKEN: "test-token" }, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolveClosed({ code, signal })); });
    try {
      child.stdin.write(Buffer.concat([Buffer.alloc(4 * 1024 * 1024 + 1, "x"), Buffer.from("\n")]));
      const result = await Promise.race([
        closed,
        new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 750)),
      ]);
      expect(result).not.toBe("timeout");
      if (result !== "timeout") expect(result.code).not.toBe(0);
    } finally {
      child.kill();
    }
  });
});
