import { describe, expect, it } from "vitest";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  describeGradingDefaults,
  summarizeComputerEnvironment,
  summarizeEnvironments,
  summarizeGithubChecks,
  summarizeJudge,
  summarizeName,
  summarizePolicy,
  summarizeSchedule,
  summarizeValidity,
} from "../suite-settings-summary";
import {
  groupGradersByStage,
  judgeMode,
  stageConfigStates,
} from "../suite-grading-model";
import type { SuiteSettingsValues } from "../suite-settings-draft";

const emptyValues: SuiteSettingsValues = {
  name: "",
  defaultPassCriteria: undefined,
  minIterations: undefined,
  computerEnvironmentId: undefined,
  defaultMatchOptions: undefined,
  defaultPredicates: [],
  judgeConfig: undefined,
  judgeRubric: undefined,
  verdictPolicyVersion: undefined,
  verdictPolicyDefaults: undefined,
};

const legacyValues: SuiteSettingsValues = {
  ...emptyValues,
  name: "Test Suite",
  defaultPassCriteria: { minimumPassRate: 100 },
};

const v2Values: SuiteSettingsValues = {
  ...emptyValues,
  name: "Test Suite",
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 3, passThreshold: 0.8 },
};

function defaultsFor(
  values: SuiteSettingsValues,
  predicates: Predicate[] = [],
) {
  const model = groupGradersByStage({
    matchOptions: values.defaultMatchOptions,
    predicates,
    judgeConfig: values.judgeConfig,
  });
  const judge = summarizeJudge(values.judgeConfig);
  return describeGradingDefaults(
    values,
    model,
    judge,
    stageConfigStates(model, judgeMode(values.judgeConfig)),
  );
}

describe("suite-settings-summary", () => {
  it("summarizes a legacy name and policy", () => {
    expect(summarizeName(legacyValues)).toMatchObject({
      state: "ready",
      text: "Test Suite",
      tone: "set",
    });
    const policy = summarizePolicy(legacyValues);
    expect(policy.text).toContain("Minimum accuracy 100%");
    expect(policy.text).toContain("minimum iterations off");
    expect(policy.chips?.[0]?.label).toBe("Legacy · suite-wide percent");
    expect(policy.text.toLowerCase()).not.toContain("not measured");
  });

  it("summarizes v2 policy without claiming cases use the default", () => {
    const policy = summarizePolicy(v2Values);
    expect(policy.text).toBe("Default 3 repetitions · 80% pass threshold");
    expect(policy.detail).toBe("Cases may set their own.");
    expect(policy.text.toLowerCase()).not.toContain("every case uses");
  });

  it("summarizes validity with the inconclusive detail", () => {
    const validity = summarizeValidity(v2Values);
    expect(validity.text).toBe("Contract defaults");
    expect(validity.detail).toContain("inconclusive, not failed");
  });

  it("never returns an empty text for loading or unavailable", () => {
    expect(
      summarizeComputerEnvironment({
        id: undefined,
        computerEnvironments: undefined,
      }).text.length,
    ).toBeGreaterThan(0);
    expect(
      summarizeComputerEnvironment({
        id: undefined,
        computerEnvironments: [],
        disabledReason: "Not enabled for this organization",
      }),
    ).toMatchObject({
      state: "unavailable",
      text: "Not enabled for this organization",
    });
    expect(
      summarizeEnvironments({ suite: {}, environments: undefined }).text.length,
    ).toBeGreaterThan(0);
    expect(
      summarizeGithubChecks({
        availability: undefined,
        rows: undefined,
        suiteId: "suite-1",
      }).text.length,
    ).toBeGreaterThan(0);
  });

  it("reads the legacy clients × case-models matrix when cells are unavailable", () => {
    const summary = summarizeEnvironments({
      cellsEditable: false,
      suite: {
        hostAttachments: [
          { namedHostId: "h1", hostName: "Claude Code" },
          { namedHostId: "h2", hostName: null },
        ],
      },
      environments: undefined,
      caseModels: ["anthropic/claude-sonnet-5", "openai/gpt-5-mini"],
    });
    expect(summary.state).toBe("ready");
    expect(summary.text).toBe("Claude Code, h2");
    expect(summary.detail).toBe("× claude-sonnet-5, gpt-5-mini");
    expect(summary.chips?.[0]?.label).toBe("2 runs per Run all");
  });

  it("never spins when cells are unavailable and nothing is attached", () => {
    const summary = summarizeEnvironments({
      cellsEditable: false,
      suite: {},
      environments: undefined,
    });
    expect(summary.state).toBe("ready");
    expect(summary.text).toBe("No clients");
    expect(summary.cta).toBe("pick some");
  });

  it("says environments cannot be edited when the backend cannot, but some are attached", () => {
    const summary = summarizeEnvironments({
      cellsEditable: false,
      suite: { environmentIds: ["e1", "e2", "e3"] },
      environments: undefined,
    });
    expect(summary.text).toBe("3 environments");
    expect(summary.detail).toContain("cannot edit environments");
    expect(summary.chips?.[0]?.label).toBe("3 runs per Run all");
  });

  it("writes the clients × models line from attached environments", () => {
    const summary = summarizeEnvironments({
      suite: { environmentIds: ["e1", "e2"] },
      environments: [
        {
          environmentId: "e1",
          hostId: "h1",
          modelId: "anthropic/claude-sonnet-5",
          name: "CC sonnet",
        },
        {
          environmentId: "e2",
          hostId: "h2",
          modelId: "openai/gpt-5-mini",
          name: "Cursor mini",
        },
      ],
      hostName: (hostId) => ({ h1: "Claude Code", h2: "Cursor" })[hostId],
    });
    expect(summary.text).toBe("CC sonnet, Cursor mini");
    expect(summary.detail).toBe(
      "Claude Code, Cursor × claude-sonnet-5, gpt-5-mini",
    );
    expect(summary.chips?.[0]?.label).toBe("2 runs per Run all");
  });

  it("names a paused schedule's reason and owner", () => {
    const summary = summarizeSchedule({
      schedule: {
        intervalMinutes: 60,
        enabled: true,
        state: "paused_quota",
        createdByUserId: "user-1",
      },
      ownerName: "Ada",
    });
    expect(summary.text).toBe("Paused");
    expect(summary.tone).toBe("attention");
    expect(summary.chips?.[0]?.label).toBe("quota");
    expect(summary.detail).toContain("quota was exhausted");
    expect(summary.detail).toContain("Runs as Ada");
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

  it("reads the four judge modes", () => {
    expect(summarizeJudge(undefined).mode).toBe("manual");
    expect(summarizeJudge(undefined).text).toContain("on request");
    expect(summarizeJudge({ goalCompletion: { enabled: false } }).mode).toBe(
      "off",
    );
    expect(
      summarizeJudge({ goalCompletion: { autoRun: true } }).mode,
    ).toBe("automatic");
    expect(
      summarizeJudge({ goalCompletion: { role: "gating" } }).mode,
    ).toBe("gating");
  });

  it("writes suite-default sentences, not case claims", () => {
    const legacy = defaultsFor(legacyValues);
    expect(legacy[0]).toContain("under 100%");
    expect(legacy.join(" ")).not.toMatch(/not measured/i);
    expect(legacy.join(" ")).not.toMatch(/every case uses/i);

    const v2 = defaultsFor(v2Values);
    expect(v2.some((line) => line.includes("80%"))).toBe(true);
    expect(v2.some((line) => line.includes("Cases may set their own"))).toBe(
      true,
    );
    expect(v2.some((line) => line.includes("inconclusive, not failed"))).toBe(
      true,
    );

    const withCheck = defaultsFor(legacyValues, [
      {
        type: "responseContains",
        needle: "ok",
      } as Predicate,
    ]);
    expect(withCheck.some((line) => /User value/.test(line))).toBe(true);
    expect(
      withCheck.some((line) => line.includes("only on request")),
    ).toBe(true);

    const gating = defaultsFor({
      ...legacyValues,
      judgeConfig: { goalCompletion: { role: "gating" } },
    });
    expect(gating.some((line) => line === "The judge gates the verdict.")).toBe(
      true,
    );
  });
});
