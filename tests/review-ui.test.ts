import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecommendedReviewOrder,
  buildReviewArchitecture,
  deriveReviewFlowTraces,
} from "../src/review-ui";

describe("schema 2 review architecture", () => {
  it("aggregates each story once in review-plan order with a deterministic attention level", () => {
    const model = buildReviewArchitecture({
      schemaVersion: "2.0.0",
      primaryStoryId: "story-primary",
      reviewPlan: ["story-primary", "story-supporting", "story-independent"],
      stories: [
        {
          id: "story-supporting",
          title: "Shared callback path",
          summary: "",
          relationshipToPrimary: "supporting",
          relationshipRationale: "",
          reviewReason: "Check the callback handoff once.",
          changeGroupIds: ["group-low", "group-high"],
          dependsOnStoryIds: [],
        },
        {
          id: "story-primary",
          title: "Primary behavior",
          summary: "",
          relationshipToPrimary: "primary",
          relationshipRationale: "",
          reviewReason: "Start at the owner boundary.",
          changeGroupIds: ["group-medium"],
          dependsOnStoryIds: [],
        },
        {
          id: "story-independent",
          title: "Independent cleanup",
          summary: "",
          relationshipToPrimary: "independent",
          relationshipRationale: "",
          reviewReason: "Review this separately.",
          changeGroupIds: ["group-low-independent"],
          dependsOnStoryIds: [],
        },
      ],
      changeGroups: [
        { id: "group-low", title: "Low", attention: "low" },
        { id: "group-high", title: "High", attention: "high" },
        { id: "group-medium", title: "Medium", attention: "medium" },
        { id: "group-low-independent", title: "Independent low", attention: "low" },
      ],
    });

    expect(buildRecommendedReviewOrder(model)).toEqual([
      expect.objectContaining({
        id: "story-primary",
        title: "Primary behavior",
        reason: "Start at the owner boundary.",
        groupCount: 1,
        attention: "medium",
      }),
      expect.objectContaining({
        id: "story-supporting",
        title: "Shared callback path",
        reason: "Check the callback handoff once.",
        groupCount: 2,
        attention: "high",
      }),
      expect.objectContaining({
        id: "story-independent",
        title: "Independent cleanup",
        reason: "Review this separately.",
        groupCount: 1,
        attention: "low",
      }),
    ]);
    expect(buildRecommendedReviewOrder(model)).toHaveLength(3);
  });

  it("keeps story order, nests atomic groups, and derives compact friendly flow traces", () => {
    const model = buildReviewArchitecture({
      schemaVersion: "2.0.0",
      primaryStoryId: "story-primary",
      reviewPlan: ["story-primary", "story-supporting"],
      stories: [
        {
          id: "story-supporting",
          title: "Refresh callback handoff",
          summary: "The callback now waits for the rotated credential.",
          relationshipToPrimary: "supporting",
          relationshipRationale: "It consumes the session boundary.",
          reviewReason: "Verify the redirect race after the owner moves.",
          changeGroupIds: ["group-callback"],
          dependsOnStoryIds: ["story-primary"],
        },
        {
          id: "story-primary",
          title: "Session-owned rotation",
          summary: "Refresh tokens rotate at the server boundary.",
          relationshipToPrimary: "primary",
          relationshipRationale: "This is the central behavior change.",
          reviewReason: "Start at the credential boundary.",
          changeGroupIds: ["group-session", "group-schema"],
          dependsOnStoryIds: [],
        },
      ],
      changeGroups: [
        { id: "group-session", title: "Rotate token", summary: "A", previousBehavior: "B", newBehavior: "C", motivation: "D", attention: "high", evidenceIds: [] },
        { id: "group-schema", title: "Migrate schema", summary: "A", previousBehavior: "B", newBehavior: "C", motivation: "D", attention: "medium", evidenceIds: [] },
        { id: "group-callback", title: "Guard callback", summary: "A", previousBehavior: "B", newBehavior: "C", motivation: "D", attention: "low", evidenceIds: [] },
      ],
      graphs: {
        dataFlow: {
          id: "data-flow",
          nodes: [{ id: "session", label: "Session service", explanation: "", changed: true, changeGroupIds: ["group-session"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] }],
          edges: [{ id: "edge", source: "session", target: "session", label: "rotates", changeGroupIds: ["group-session"], evidenceIds: [], reviewThreadIds: [] }],
        },
        codeDependency: {
          id: "code-dependency",
          nodes: [{ id: "schema", label: "Token schema", explanation: "", changed: true, changeGroupIds: ["group-schema"], testIds: [], reviewThreadIds: [], reviewInsightIds: [], evidenceIds: [] }],
          edges: [],
        },
      },
    });

    expect(model.kind).toBe("schema-2");
    expect(model.stories.map((story) => story.id)).toEqual([
      "story-primary",
      "story-supporting",
    ]);
    expect(model.stories[0]?.groups.map((group) => group.id)).toEqual([
      "group-session",
      "group-schema",
    ]);
    expect(model.stories[1]?.groups.map((group) => group.id)).toEqual([
      "group-callback",
    ]);
    expect(model.stories[0]?.flowTraces).toEqual([
      { type: "data-flow", label: "Session service → rotates", nodeId: "session", changeGroupIds: ["group-session"] },
      { type: "code-dependency", label: "Token schema", nodeId: "schema", changeGroupIds: ["group-schema"] },
    ]);
    expect(model.stories[0]?.flowTraces[0]?.label).not.toContain("group-");
  });

  it("derives a separate exact trace for each sibling group in the same graph", () => {
    const document = {
      schemaVersion: "2.0.0",
      graphs: {
        dataFlow: {
          id: "data-flow",
          nodes: [
            { id: "session", label: "Session service", changeGroupIds: ["group-a"] },
            { id: "callback", label: "OAuth callback", changeGroupIds: ["group-b"] },
          ],
          edges: [
            { id: "edge-a", source: "session", target: "session", label: "rotates", changeGroupIds: ["group-a"] },
            { id: "edge-b", source: "callback", target: "callback", label: "hands off", changeGroupIds: ["group-b"] },
          ],
        },
      },
    };
    expect(deriveReviewFlowTraces(document, ["group-a"])).toEqual([
      { type: "data-flow", label: "Session service → rotates", nodeId: "session", changeGroupIds: ["group-a"] },
    ]);
    expect(deriveReviewFlowTraces(document, ["group-b"])).toEqual([
      { type: "data-flow", label: "OAuth callback → hands off", nodeId: "callback", changeGroupIds: ["group-b"] },
    ]);
  });

  it("opens the changed endpoint for a context-to-change edge and omits actions without a changed endpoint", () => {
    const document = {
      schemaVersion: "2.0.0",
      graphs: {
        dataFlow: {
          id: "data-flow",
          nodes: [
            { id: "context-source", label: "Existing boundary", changeGroupIds: [] },
            { id: "changed-target", label: "Updated handler", changeGroupIds: ["group-target"] },
          ],
          edges: [
            { id: "target-edge", source: "context-source", target: "changed-target", label: "feeds", changeGroupIds: ["group-target"] },
          ],
        },
        codeDependency: {
          id: "code-dependency",
          nodes: [
            { id: "unchanged-source", label: "Existing module", changeGroupIds: [] },
            { id: "unchanged-target", label: "Context module", changeGroupIds: [] },
          ],
          edges: [
            { id: "context-edge", source: "unchanged-source", target: "unchanged-target", label: "references", changeGroupIds: ["group-target"] },
          ],
        },
      },
    };

    expect(deriveReviewFlowTraces(document, ["group-target"])).toEqual([
      { type: "data-flow", label: "Existing boundary → feeds → Updated handler", nodeId: "changed-target", changeGroupIds: ["group-target"] },
      { type: "code-dependency", label: "Existing module → references → Context module", changeGroupIds: ["group-target"] },
    ]);
  });

  it("does not fabricate a Review surface for a legacy 1.1 artifact", () => {
    const model = buildReviewArchitecture({
      schemaVersion: "1.1.0",
      changeGroups: [{ id: "legacy-group", title: "Old group" }],
      walkthrough: [{ id: "legacy-step", changeGroupId: "legacy-group" }],
    });
    expect(model.kind).toBe("empty");
    expect(model.stories).toEqual([]);
  });

  it("keeps Review readable when the main column is narrow inside a wide viewport", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/\.review-main\s*\{[^}]*container-type:\s*inline-size/s);
    expect(css).toMatch(/@container\s+review-main\s*\(max-width:\s*560px\)/);
    expect(css).toMatch(/@container\s+review-main[\s\S]*?\.review-chapter-head[^{]*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/@container\s+review-main[\s\S]*?\.review-detail-grid[^{]*\{[^}]*grid-template-columns:\s*1fr/s);
  });
});
