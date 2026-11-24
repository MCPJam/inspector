import { describe, expect, it } from "vitest";
import { suiteCheck } from "../suite-check.js";
import type { PlatformClimb } from "../../platform/climb-types.js";
import { climb } from "./fixtures.js";

const codes = (check: ReturnType<typeof suiteCheck>) => check.findings.map((finding) => `${finding.severity}:${finding.code}${finding.environmentId ? `@${finding.environmentId}` : ""}`);

describe("suiteCheck", () => {
  it("is not ready before the baseline settles", () => {
    const check = suiteCheck(climb({ baseline: undefined, state: "baselining" }));
    expect(check).toMatchObject({ ready: false, canShowChange: false, environments: [], findings: [] });
  });

  it("reports the noise and smallest change per environment as the backend settled them", () => {
    const check = suiteCheck(climb());
    expect(check.ready).toBe(true);
    expect(check.environments[0]).toMatchObject({
      environmentId: "env-a",
      noiseBps: { pass_rate: 833, tokens: 40 },
      smallestChangeBps: { pass_rate: 833, tokens: 100 },
      flippedSteeringCaseKeys: ["search-empty"],
      flippedValidationCount: 1,
    });
    expect(check.canShowChange).toBe(true);
  });

  it("names the steering cases that flipped and counts validation cases without naming them", () => {
    const flipped = suiteCheck(climb()).findings.find((finding) => finding.code === "flipped_cases");
    expect(flipped?.message).toContain("1 steering and 1 validation case");
    expect(flipped?.message).toContain("search-empty");
    expect(JSON.stringify(suiteCheck(climb()))).not.toMatch(/validation case key/);
  });

  it("warns when the climb has no validation cases, and says how to set some", () => {
    const base = climb();
    const check = suiteCheck(climb({ groups: { ...base.groups, validation: 0 } }));
    const finding = check.findings.find((entry) => entry.code === "no_validation_cases");
    expect(finding).toMatchObject({ severity: "warns" });
    expect(finding?.message).toContain("no validation cases");
    expect(finding?.message).toContain("listed as validation");
    expect(check.canShowChange).toBe(true);
    expect(suiteCheck(base).findings.some((entry) => entry.code === "no_validation_cases")).toBe(false);
  });

  it("says how many iterations were lost, and which tools no validation case covers", () => {
    const check = suiteCheck(
      climb({ groups: { steering: 6, validation: 3, confirmation: 0, steeringCases: [], steeringToolsWithoutValidation: ["search", "fetch"] } }),
    );
    expect(check.findings.find((finding) => finding.code === "iterations_lost")?.message).toContain("2 of 24 iterations");
    expect(check.findings.find((finding) => finding.code === "no_validation_for_tools")?.message).toContain("search, fetch");
    expect(check.steeringToolsWithoutValidation).toEqual(["search", "fetch"]);
  });

  describe.each([
    ["every steering case passes, for pass rate", { measure: "pass_rate" as const, allGreen: true }, ["blocks:no_room_to_improve"], false],
    ["every steering case passes, for tokens", { measure: "tokens" as const, allGreen: true }, [], true],
    ["no environment recorded cost", { measure: "cost" as const, noCost: true }, ["blocks:measure_not_recorded"], false],
    ["one environment lacks cost", { measure: "cost" as const }, ["warns:measure_not_recorded@env-b"], true],
  ])("%s", (_label, setup, expected, canShow) => {
    it("is judged by the climb's own measure", () => {
      const base = climb({ measure: setup.measure });
      for (const env of base.baseline!.environments) {
        if ("allGreen" in setup) env.noRoomToImprove = true;
        if ("noCost" in setup) env.recorded.cost = false;
      }
      const check = suiteCheck(base);
      for (const code of expected) expect(codes(check)).toContain(code);
      expect(check.canShowChange).toBe(canShow);
    });
  });

  it("warns that a suite is coarse when its smallest pass rate change is a quarter or more", () => {
    const base = climb();
    base.baseline!.environments[0]!.steering!.smallestChangeBps = { pass_rate: 2500 };
    const check = suiteCheck(base);
    expect(check.findings.find((finding) => finding.code === "smallest_change" && finding.environmentId === "env-a")).toMatchObject({
      severity: "warns",
      message: expect.stringContaining("add iterations or cases"),
    });
  });

  describe("replays_one_decision", () => {
    /** env-b's two baseline runs agree to the token; env-a keeps its flipped cases and noise. */
    const identical = (over: Partial<PlatformClimb> = {}, patch: { tokensNoiseBps?: number; flippedSteeringCaseKeys?: string[]; flippedValidationCount?: number; tokens?: boolean } = {}) => {
      const base = climb(over);
      const environments = base.baseline!.environments.map((env) =>
        env.environmentId !== "env-b"
          ? env
          : {
              ...env,
              recorded: { ...env.recorded, tokens: patch.tokens ?? true },
              flippedSteeringCaseKeys: patch.flippedSteeringCaseKeys ?? [],
              flippedValidationCount: patch.flippedValidationCount ?? 0,
              steering: { ...env.steering!, tokensNoiseBps: patch.tokensNoiseBps ?? 0 },
            },
      );
      return { ...base, baseline: { ...base.baseline!, environments } };
    };
    const replays = (check: ReturnType<typeof suiteCheck>) => check.findings.filter((finding) => finding.code === "replays_one_decision");

    it("warns for a pass rate climb and names the environment", () => {
      const found = replays(suiteCheck(identical()));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: "warns", environmentId: "env-b" });
      expect(found[0]!.message).toContain("same result in every case, to the token");
      expect(found[0]!.message).toContain("needs an environment that samples");
    });

    it("is information for another measure, and does not block a climb", () => {
      const check = suiteCheck(identical({ measure: "tokens" }));
      expect(replays(check)).toMatchObject([{ severity: "info", environmentId: "env-b" }]);
      expect(replays(check)[0]!.message).not.toContain("needs an environment that samples");
      expect(check.canShowChange).toBe(true);
    });

    it("does not fire when the token counts differ, a case flipped, or tokens were not recorded", () => {
      expect(replays(suiteCheck(identical({}, { tokensNoiseBps: 40 })))).toEqual([]);
      expect(replays(suiteCheck(identical({}, { flippedSteeringCaseKeys: ["search-empty"] })))).toEqual([]);
      expect(replays(suiteCheck(identical({}, { flippedValidationCount: 1 })))).toEqual([]);
      expect(replays(suiteCheck(identical({}, { tokens: false })))).toEqual([]);
      expect(replays(suiteCheck(climb()))).toEqual([]);
    });
  });
});
