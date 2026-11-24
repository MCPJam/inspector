import { describe, expect, it } from "vitest";
import type { PlatformClimbRound } from "../../platform/climb-types.js";
import { summarizeClimb } from "../summary.js";
import { climb } from "./fixtures.js";

const round = (number: number, standing: "kept" | "reverted", over: Partial<PlatformClimbRound> = {}): PlatformClimbRound =>
  ({
    number,
    status: "settled",
    serverId: `mock-${number}`,
    submittedBy: "u",
    submittedVia: "mcp",
    openedAt: 1,
    verdict: standing,
    standing,
    reasons: [],
    estimatedCredits: 10,
    remeasuredBest: false,
    againstBest: {},
    failedSteeringCaseKeys: [],
    environments: [
      {
        environmentId: "env-a",
        candidateLost: 0,
        bestLost: 0,
        measureRecorded: true,
        steering: { passRate: { candidateBps: 9167, bestBps: 7500, deltaBps: 1667, noiseBps: 833, move: "better" } },
        validation: { passRate: { candidateBps: 8333, bestBps: 8333, deltaBps: 0, noiseBps: 1666, move: "none" } },
      },
    ],
    environmentsWithoutMeasure: [],
    ...over,
  }) as PlatformClimbRound;

const base = () => climb({ state: "stopped", stopReason: "round_limit", groups: { steering: 6, validation: 3, confirmation: 0, steeringCases: [], steeringToolsWithoutValidation: [] } });

describe("summarizeClimb", () => {
  it("labels steering and validation as the cases that picked the result, and gives totals only", () => {
    const summary = summarizeClimb({ climb: base(), rounds: [round(1, "kept", { validation: "unchanged" })] });
    expect(summary.steering.label).toContain("helped pick this result");
    expect(summary.validation.label).toContain("totals only");
    expect(summary.steering.environments[0]).toMatchObject({ environmentId: "env-a", baselinePassRateBps: 7500, bestPassRateBps: 9167 });
    expect(summary.validation.environments[0]).toMatchObject({ bestPassRateBps: 8333 });
    expect(summary.stoppedBecause).toBe("the round limit was reached");
    expect(JSON.stringify(summary)).not.toMatch(/validationCaseKey/);
  });

  it("states what was established and what was not, with no interval, when no cases were set aside", () => {
    const summary = summarizeClimb({ climb: base(), rounds: [round(1, "kept")] });
    expect(summary.confirmation).toMatchObject({ status: "no_cases" });
    expect(summary.established[0]).toContain("improved pass rate on the steering cases in at least one environment");
    expect(summary.established[0]).toContain("validation cases included");
    expect(summary.notEstablished.join(" ")).toContain("both helped pick this result");
    expect(summary.notEstablished.join(" ")).toContain("No cases were set aside");
    expect(JSON.stringify(summary)).not.toContain("interval");
  });

  it("says nothing is kept when no round improved on the baseline", () => {
    const summary = summarizeClimb({ climb: base(), rounds: [round(1, "reverted")] });
    expect(summary.established).toEqual(["No round improved on the baseline, so nothing is kept."]);
    expect(summary.steering.environments[0]!.bestPassRateBps).toBe(7500);
  });

  it("counts an overrule to kept as kept, and an overrule to reverted as not", () => {
    const overruledUp = round(1, "reverted", { overruled: { to: "kept", by: "u", reason: "r", at: 1 } });
    const overruledDown = round(2, "kept", { overruled: { to: "reverted", by: "u", reason: "r", at: 1 } });
    expect(summarizeClimb({ climb: base(), rounds: [overruledUp] }).established[0]).toContain("1 round improved");
    expect(summarizeClimb({ climb: base(), rounds: [overruledDown] }).established[0]).toContain("nothing is kept");
  });

  it("compounds the kept rounds' ratios for a climb for tokens", () => {
    const tokens = (ratioBps: number) => ({ environments: [{ environmentId: "env-a", candidateLost: 0, bestLost: 0, measureRecorded: true, steering: { measure: { ratioBps, noiseBps: 40, comparedCases: 5, move: "better" as const } } }] });
    const summary = summarizeClimb({ climb: { ...base(), measure: "tokens" }, rounds: [round(1, "kept", tokens(9000)), round(2, "kept", tokens(9000))] });
    expect(summary.steering.environments[0]!.measureRatioBps).toBe(8100);
  });

  describe("with a confirmation", () => {
    const withCases = () => ({ ...base(), groups: { ...base().groups, confirmation: 4 } });
    const record = { status: "settled" as const, unitKey: "confirmation:1", startedAt: 1, startedBy: "u", estimatedCredits: 1, environments: [{ environmentId: "env-a" }] };
    const row = (caseKey: string, arm: "baseline" | "best", passed: number) => ({
      environmentId: "env-a", caseKey, arm, counted: 3, passed, lost: 0,
      m: { tokens: { sum: 0, n: 0, missing: 3 }, cost: { sum: 0, n: 0, missing: 3 }, tool_calls: { sum: 0, n: 0, missing: 3 } },
    });
    const cases = (best: number[]) => ["a", "b", "c", "d"].flatMap((key, i) => [row(key, "baseline", 1), row(key, "best", best[i]!)]);

    it("reports the interval and says a gain within noise should not be shipped on", () => {
      const summary = summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")], confirmation: { record, cases: cases([1, 1, 1, 2]) } });
      expect(summary.confirmation).toMatchObject({ status: "settled" });
      expect(summary.notEstablished.join(" ")).toContain("within noise");
      expect(summary.notEstablished.join(" ")).toContain("Do not ship on it");
    });

    it("counts a gain whose interval excludes zero as established", () => {
      const summary = summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")], confirmation: { record, cases: cases([3, 3, 3, 3]) } });
      expect(summary.established.join(" ")).toContain("the interval excludes zero");
    });

    it("names an environment that lost too many iterations as not decided", () => {
      const lost = { ...record, environments: [{ environmentId: "env-a", notDecided: true }] };
      const summary = summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")], confirmation: { record: lost, cases: cases([3, 3, 3, 3]) } });
      expect(summary.confirmation).toMatchObject({ status: "settled", environments: [], notDecided: ["env-a"] });
      expect(summary.notEstablished.join(" ")).toContain("not decided there");
    });

    it("says it has not run, is running, or failed", () => {
      expect(summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")] }).confirmation.status).toBe("not_run");
      expect(summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")], confirmation: { record: { ...record, status: "running" } } }).confirmation.status).toBe("running");
      expect(
        summarizeClimb({ climb: withCases(), rounds: [round(1, "kept")], confirmation: { record: { ...record, status: "failed", failureReason: "deadline" } } }).confirmation,
      ).toMatchObject({ status: "failed", failureReason: "deadline" });
    });

    it("carries the earlier climbs that used the same confirmation cases", () => {
      const used = { ...withCases(), confirmationCasesUsedBy: ["climb-0"] };
      expect(summarizeClimb({ climb: used, rounds: [round(1, "kept")] }).confirmation.usedByEarlierClimbs).toEqual(["climb-0"]);
    });
  });
});
