import { describe, expect, it } from "vitest";
import { costIndicator } from "../../src/App";

describe("analysis cost visibility", () => {
  it("labels reported, estimated, unavailable, and absent metadata honestly", () => {
    expect(costIndicator({ cost: { kind: "reported", amountUsd: 1.84 } })).toEqual({ label: "$1.84 provider estimate", title: "Provider-reported cost estimate; billing may differ." });
    expect(costIndicator({ cost: { kind: "estimated", amountUsd: 1.84, model: "gpt-5.4", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10" } })?.label).toBe("~$1.84 API estimate");
    expect(costIndicator({ usage: { inputTokens: 12 }, cost: { kind: "unavailable", reason: "No model pricing." } })).toEqual({ label: "12 input tokens · Cost unavailable", title: "No model pricing." });
    expect(costIndicator({ usage: { inputTokens: 12 } })).toEqual({ label: "12 input tokens · Cost unavailable", title: "Provider reported usage without cost metadata." });
    expect(costIndicator({ cost: { kind: "estimated", amountUsd: 0.0001, model: "gpt-5.6", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10" } })?.label).toBe("<$0.01 API estimate");
    expect(costIndicator({ cost: { kind: "estimated", amountUsd: 1.25, maxAmountUsd: 2.5, model: "gpt-5.6", pricingSource: "OpenAI API pricing", pricingVersion: "2026-08-10", pricingAsOf: "2026-08-10" } })?.label).toBe("~$1.25–$2.50 API estimate");
    expect(costIndicator(undefined)).toBeUndefined();
  });
});
