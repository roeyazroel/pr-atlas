import { describe, expect, it } from "vitest";
import {
  createRunLogger,
  redactCommandArgv,
  serializeLogRecord,
  type StructuredLogRecord,
} from "../../electron/backend/logging";

describe("structured backend logging", () => {
  it("serializes a JSONL-friendly record with run context and metadata", () => {
    const record: StructuredLogRecord = {
      timestamp: "2026-08-09T10:00:00.000Z",
      level: "info",
      event: "provider.started",
      runId: "run-123",
      provider: "codex",
      task: "walkthrough",
      stage: "generating",
      metadata: { attempt: 1, cached: false },
    };

    const line = serializeLogRecord(record);

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(record);
  });

  it("redacts secret metadata and truncates large values without breaking JSON", () => {
    const secret = "do-not-write-this-secret";
    const line = serializeLogRecord(
      {
        timestamp: "2026-08-09T10:00:00.000Z",
        level: "error",
        event: "provider.failed",
        metadata: {
          apiKey: secret,
          nested: { authorization: "Bearer secret-token" },
          output: "x".repeat(10_000),
        },
      },
      { maxRecordBytes: 2_000, maxStringLength: 120 },
    );

    expect(line.length).toBeLessThanOrEqual(2_000);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("secret-token");
    expect(JSON.parse(line).metadata.output).toMatch(/truncated/i);
  });

  it("handles cyclic metadata and applies an injected string redactor", () => {
    const cyclic: Record<string, unknown> = { message: "safe-value" };
    cyclic.self = cyclic;

    const parsed = JSON.parse(
      serializeLogRecord(
        {
          timestamp: "2026-08-09T10:00:00.000Z",
          level: "debug",
          event: "test",
          metadata: cyclic,
        },
        { redact: (value) => value.replaceAll("safe-value", "[CUSTOM]") },
      ),
    );

    expect(parsed.metadata).toMatchObject({
      message: "[CUSTOM]",
      self: "[Circular]",
    });
  });

  it("redacts secret command argv values deterministically and truncates large args", () => {
    const argv = [
      "codex",
      "--model",
      "gpt-5",
      "--api-key=inline-secret",
      "--token",
      "standalone-secret",
      "--header",
      "Authorization: Bearer header-secret",
      `--prompt=${"p".repeat(10_000)}`,
    ];

    const first = redactCommandArgv(argv, { maxArgLength: 100 });
    const second = redactCommandArgv(argv, { maxArgLength: 100 });

    expect(first).toEqual(second);
    expect(first).toEqual([
      "codex",
      "--model",
      "gpt-5",
      "--api-key=[REDACTED]",
      "--token",
      "[REDACTED]",
      "--header",
      "Authorization: [REDACTED]",
      expect.stringMatching(/^--prompt=p+…\[truncated\]$/),
    ]);
    expect(first.join(" ")).not.toMatch(/inline-secret|standalone-secret|header-secret/);
  });

  it("bounds accumulated records and emits one JSON object per line", () => {
    const logger = createRunLogger(
      { runId: "run-1", provider: "cursor", stage: "mapping" },
      { maxRecords: 2 },
    );

    logger.info("first");
    logger.warn("second", { value: 2 });
    logger.error("third", { value: 3 });

    expect(logger.records).toHaveLength(2);
    expect(logger.records.map(({ event }) => event)).toEqual(["second", "third"]);
    expect(logger.records[0]).toMatchObject({ runId: "run-1", provider: "cursor", stage: "mapping" });
    expect(logger.records[0].metadata).toEqual({ value: 2 });

    const lines = logger.toJSONL().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["second", "third"]);
  });
});
