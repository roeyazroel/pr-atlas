import { describe, expect, it } from "vitest";
import {
  aggregateProviderAccounting,
  estimateCodexCost,
  parseProviderAccounting,
} from "../../electron/backend/costs";

describe("provider accounting", () => {
  it("uses Claude terminal result usage/cost over duplicate streamed assistant messages", () => {
    const accounting = parseProviderAccounting(
      "claude",
      [
        JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 8, output_tokens: 14 } } }),
        JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { input_tokens: 999, output_tokens: 999 } } }),
        JSON.stringify({ type: "result", total_cost_usd: 1.84, usage: { input_tokens: 200, output_tokens: 25 }, modelUsage: { "claude-sonnet": { inputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, outputTokens: 25 }, "claude-haiku": { inputTokens: 40, outputTokens: 5 } } }),
      ].join("\n"),
      "claude-sonnet-4-6",
    );

    expect(accounting).toMatchObject({
      cost: { kind: "reported", amountUsd: 1.84 },
      usage: { inputTokens: 240, cachedInputTokens: 50, cacheWriteInputTokens: 10, outputTokens: 30 },
    });
  });

  it("uses distinct Claude message usage only as a failed-stream fallback and says cost is unavailable", () => {
    expect(parseProviderAccounting("claude", [
      JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { input_tokens: 12, output_tokens: 3 } } }),
      JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { input_tokens: 12, output_tokens: 3 } } }),
      JSON.stringify({ type: "assistant", message: { id: "msg-2", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ].join("\n"))).toEqual({
      usage: { inputTokens: 16, outputTokens: 5 },
      cost: { kind: "unavailable", reason: "Claude reported usage but not total cost." },
    });
  });

  it("uses final cumulative Codex JSONL usage exactly once and prices cache reads", () => {
    const accounting = parseProviderAccounting(
      "codex",
      [
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 100, reasoning_tokens: 20 } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 800, output_tokens: 300, reasoning_tokens: 50 } }),
      ].join("\n"),
      "gpt-5.6",
    );

    expect(accounting.usage).toEqual({ inputTokens: 2000, cachedInputTokens: 800, outputTokens: 300, reasoningTokens: 50 });
    expect(accounting.cost).toMatchObject({ kind: "estimated", pricingSource: "OpenAI API pricing", model: "gpt-5.6" });
    expect(accounting.cost?.kind).toBe("estimated");
    if (accounting.cost?.kind === "estimated") expect(accounting.cost.amountUsd).toBeGreaterThan(0);
  });

  it("records Cursor usage without inventing a price", () => {
    const accounting = parseProviderAccounting(
      "cursor",
      JSON.stringify({ usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2 } }),
      "cursor-grok-4.5-high-fast",
    );

    expect(accounting).toEqual({
      usage: { inputTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 8 },
      cost: { kind: "unavailable", reason: "Cursor Agent does not expose model-specific pricing." },
    });
  });

  it("handles unknown models and invalid values without NaN or negative cost", () => {
    expect(estimateCodexCost("unknown", { inputTokens: -4, outputTokens: Number.NaN })).toEqual({
      kind: "unavailable",
      reason: "No API pricing is recorded for this Codex model.",
    });
  });

  it("does not turn missing Codex usage into a zero-dollar estimate", () => {
    expect(estimateCodexCost("gpt-5.6", undefined)).toEqual({
      kind: "unavailable",
      reason: "Codex usage was not reported.",
    });
    expect(estimateCodexCost("gpt-5.6", { inputTokens: 0, outputTokens: 0 })).toMatchObject({
      kind: "estimated",
      amountUsd: 0,
    });
  });

  it("uses the current exact API rates for Codex Terra and Luna", () => {
    expect(estimateCodexCost("gpt-5.6-terra", {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 100_000,
      outputTokens: 100_000,
    })).toMatchObject({ kind: "estimated", amountUsd: 3.07 });
    expect(estimateCodexCost("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 100_000,
      outputTokens: 100_000,
    })).toMatchObject({ kind: "estimated", amountUsd: 0.307 });
  });

  it("returns an honest long-context range when cumulative Codex usage crosses 272K", () => {
    const normal = estimateCodexCost("gpt-5.6-sol", { inputTokens: 272_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000, outputTokens: 1_000_000 });
    const long = estimateCodexCost("gpt-5.6-sol", { inputTokens: 272_001, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000, outputTokens: 1_000_000 });

    expect(normal).toMatchObject({ kind: "estimated", amountUsd: 30.9725 });
    expect(long).toMatchObject({ kind: "estimated", amountUsd: 30.972505, maxAmountUsd: 46.94501 });
    expect(estimateCodexCost("gpt-5.4", { inputTokens: 272_001, outputTokens: 100 })).toMatchObject({
      kind: "estimated", amountUsd: 0.6815025, maxAmountUsd: 1.362255,
    });
  });

  it("ignores usage-like fields inside an untrusted walkthrough payload", () => {
    const accounting = parseProviderAccounting("claude", JSON.stringify({
      type: "result",
      total_cost_usd: 0.2,
      usage: { input_tokens: 10, output_tokens: 2 },
      result: { summary: { usage: { input_tokens: 999_999 } }, total_cost_usd: 999 },
    }));
    expect(accounting).toEqual({ usage: { inputTokens: 10, outputTokens: 2 }, cost: { kind: "reported", amountUsd: 0.2 } });
  });

  it("sums anchor, specialist, and fallback invocations while retaining the unavailable state", () => {
    expect(aggregateProviderAccounting([
      { usage: { inputTokens: 10, outputTokens: 2 }, cost: { kind: "estimated", amountUsd: 0.01, maxAmountUsd: 0.02, model: "gpt-5.4", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10" } },
      { usage: { inputTokens: 15, outputTokens: 1 }, cost: { kind: "estimated", amountUsd: 0.02, model: "gpt-5.4", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10" } },
      { usage: { inputTokens: 20, outputTokens: 3 }, cost: { kind: "unavailable", reason: "No API pricing is recorded for this Codex model." } },
    ])).toEqual({
      usage: { inputTokens: 45, outputTokens: 6 },
      cost: { kind: "estimated", amountUsd: 0.03, maxAmountUsd: 0.04, model: "gpt-5.4", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10", incomplete: true },
    });
  });
});
