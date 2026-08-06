import { describe, expect, it } from "vitest";
import { validateAnalysisRequest } from "../../electron/backend/validation";

const validRequest = () => ({
  repository: "example/backend",
  pullNumber: 481,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  provider: "claude",
});

describe("analysis request validation", () => {
  it("normalizes a valid request without changing its repository identity", () => {
    const result = validateAnalysisRequest(validRequest());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.repository).toBe("example/backend");
      expect(result.value.pullNumber).toBe(481);
      expect(result.value.baseSha).toBe("a".repeat(40));
      expect(result.value.headSha).toBe("b".repeat(40));
    }
  });

  it.each([
    ["repository", { repository: "../../secrets" }],
    ["repository owner", { repository: "example" }],
    ["pull request number", { pullNumber: 0 }],
    ["pull request number type", { pullNumber: "481" }],
    ["base SHA", { baseSha: "not-a-sha" }],
    ["head SHA", { headSha: "not-a-sha" }],
  ])("rejects an invalid %s", (_label, change) => {
    const result = validateAnalysisRequest({ ...validRequest(), ...change });
    expect(result.valid).toBe(false);
  });

  it("rejects non-object and null IPC payloads", () => {
    const nullResult = validateAnalysisRequest(null);
    const stringResult = validateAnalysisRequest("not-an-object");
    expect(nullResult.valid).toBe(false);
    expect(stringResult.valid).toBe(false);
    if (!nullResult.valid && !stringResult.valid) {
      expect(nullResult.error.code).toBe("INVALID_REQUEST");
      expect(stringResult.error.code).toBe("INVALID_REQUEST");
    }
  });

  it.each(["claude", "codex", "cursor"] as const)(
    "accepts the %s provider",
    (provider) => {
      const result = validateAnalysisRequest({ ...validRequest(), provider });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value.provider).toBe(provider);
    },
  );

  it("rejects unknown providers", () => {
    const result = validateAnalysisRequest({
      ...validRequest(),
      provider: "unknown",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe("INVALID_PROVIDER");
  });

  it("accepts a bounded selected model and supplemental collection prompt", () => {
    const result = validateAnalysisRequest({
      ...validRequest(),
      model: "claude-sonnet-4-6",
      effort: "medium",
      customPrompt:
        "Collect more evidence about migrations and rollback behavior.",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.model).toBe("claude-sonnet-4-6");
      expect(result.value.effort).toBe("medium");
      expect(result.value.customPrompt).toMatch(/rollback behavior/);
    }
  });

  it("rejects unsafe or oversized model and supplemental prompt values", () => {
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        model: "--dangerously-skip-permissions",
      }).valid,
    ).toBe(false);
    expect(
      validateAnalysisRequest({ ...validRequest(), effort: "unbounded" }).valid,
    ).toBe(false);
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        customPrompt: "x".repeat(4_001),
      }).valid,
    ).toBe(false);
  });

  it("accepts only the documented analysis-config bounds", () => {
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        config: {
          depth: "quick",
          includeReviewComments: false,
          maxGraphNodes: 20,
          timeoutMinutes: 1,
        },
      }).valid,
    ).toBe(true);
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        config: {
          depth: "deep",
          includeReviewComments: true,
          maxGraphNodes: 200,
          timeoutMinutes: 60,
        },
      }).valid,
    ).toBe(true);
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        config: {
          depth: "standard",
          includeReviewComments: true,
          maxGraphNodes: 19,
          timeoutMinutes: 20,
        },
      }).valid,
    ).toBe(false);
    expect(
      validateAnalysisRequest({
        ...validRequest(),
        config: {
          depth: "standard",
          includeReviewComments: true,
          maxGraphNodes: 80,
          timeoutMinutes: 61,
        },
      }).valid,
    ).toBe(false);
  });
});
