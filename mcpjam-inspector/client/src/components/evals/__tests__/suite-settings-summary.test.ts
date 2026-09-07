import { describe, expect, it } from "vitest";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  describeGatePolicy,
  describeJudge,
  describePredicates,
  describeValidity,
  formatFraction,
  summarizeGithubChecks,
  summarizeRubric,
} from "../suite-settings-summary";

describe("suite-settings-summary", () => {
  it("renders a stored fraction as a percent", () => {
    expect(formatFraction(0.8)).toBe("80%");
    expect(formatFraction(1)).toBe("100%");
  });

  it("describes checks by kind and count, not operands", () => {
    expect(describePredicates([])).toBe("None");
    expect(
      describePredicates([
        { type: "noToolErrors" },
        { type: "responseContains", text: "a" },
        { type: "responseContains", text: "b" },
      ] as Predicate[]),
    ).toContain("×2");
  });

  it("names an absent judge as not configured, not off", () => {
    expect(describeJudge(undefined)).toBe("Not configured");
    expect(describeJudge({ goalCompletion: { enabled: false } })).toBe("Off");
    expect(
      describeJudge({
        goalCompletion: { role: "gating", threshold: 0.8 },
      }),
    ).toContain("Gating");
  });

  it("enumerates quality-gate conditions and treats zero as configured", () => {
    expect(describeGatePolicy(undefined)).toBe("None");
    expect(
      describeGatePolicy({
        baseline: { kind: "run", runId: "run_abc" },
        maximumPassRateDrop: 0,
        maximumP95LatencyIncreaseMs: 0,
      }),
    ).toBe("Run run_abc, 0% allowed drop, 0ms p95 increase");
    expect(
      describeGatePolicy({ noGatingScoreErrors: true }),
    ).toBe("any gating scorer errored");
  });

  it("describes validity ceilings as percents", () => {
    expect(describeValidity(undefined)).toBe("Contract defaults");
    expect(
      describeValidity({
        repetitions: 1,
        passThreshold: 1,
        validity: { minCompletionRate: 0.8, maxEvaluatorErrorRate: 0.1 },
      }),
    ).toBe("80% completed, at most 10% grader errors");
  });

  it("joins rubric criteria by label", () => {
    expect(summarizeRubric(undefined)).toBe("None");
    expect(
      summarizeRubric({
        criteria: [
          { id: "a", label: "Done", description: "" },
          { id: "b", label: "Safe", description: "" },
        ],
      }),
    ).toBe("Done, Safe");
  });

  it("never returns an empty text for a loading GitHub Checks row", () => {
    expect(
      summarizeGithubChecks({
        availability: undefined,
        rows: undefined,
        suiteId: "suite-1",
      }).text.length,
    ).toBeGreaterThan(0);
  });

  it("reads GitHub Active/Paused and a missing outage policy", () => {
    const paused = summarizeGithubChecks({
      availability: { state: "enabled" },
      rows: [
        {
          suiteId: "suite-1",
          repoFullName: "acme/api",
          enabled: false,
          connectionStatus: "verified",
        },
      ],
      suiteId: "suite-1",
    });
    expect(paused.chips?.[0]?.label).toContain("Paused");
    expect(paused.chips?.[0]?.label).toContain("no policy chosen");

    const active = summarizeGithubChecks({
      availability: { state: "enabled" },
      rows: [
        {
          suiteId: "suite-1",
          repoFullName: "acme/api",
          enabled: true,
          outagePolicy: "fail_open",
          connectionStatus: "verified",
        },
      ],
      suiteId: "suite-1",
    });
    expect(active.chips?.[0]?.label).toContain("Active");
    expect(active.chips?.[0]?.label).toContain("Fail open");
  });
});
