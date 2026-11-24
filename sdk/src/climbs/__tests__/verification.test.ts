import { describe, expect, it } from "vitest";
import type { PlatformClimbVerification } from "../../platform/climb-types.js";
import { verificationReport } from "../verification.js";
import { climb } from "./fixtures.js";

const record = (over: Partial<PlatformClimbVerification> = {}): PlatformClimbVerification => ({
  index: 1,
  unitKey: "verification:1",
  mode: "paired",
  target: "server-1",
  serverMockId: "m1",
  restoreMockId: "m2",
  startedAt: 1,
  startedBy: "u",
  commitSha: "abc123",
  branch: "fix",
  dirty: false,
  status: "settled",
  verdict: "kept",
  result: {
    environments: [{ environmentId: "env-a", steering: { passRate: { candidateBps: 9167, bestBps: 7500, deltaBps: 1667, noiseBps: 833, move: "better" } } }],
    gainOnMock: [{ environmentId: "env-a", steering: { passRate: { deltaBps: 1500 } } }],
  },
  ...over,
});

describe("verificationReport", () => {
  it("says the gain holds, with both gains, the baseline then and now, and the commit", () => {
    const report = verificationReport(climb(), record());
    expect(report.holds).toBe(true);
    expect(report.summary).toContain("holds on the real server");
    expect(report.commit).toEqual({ sha: "abc123", branch: "fix", dirty: false });
    expect(report.environments[0]).toEqual({
      environmentId: "env-a",
      baselineThenBps: 7500,
      baselineNowBps: 7500,
      serverNowBps: 9167,
      gainOnMockBps: 1500,
      gainOnServerBps: 1667,
    });
  });

  it("says it does not hold when the pair was reverted, and does not decide when the rule could not", () => {
    expect(verificationReport(climb(), record({ verdict: "reverted" })).summary).toContain("does not hold");
    const undecided = verificationReport(climb(), record({ verdict: "not_decided" }));
    expect(undecided.holds).toBe(false);
    expect(undecided.summary).toContain("could not be decided");
  });

  it("says a server-only run is not a measured pair, and carries how old the recorded numbers are", () => {
    const report = verificationReport(climb(), record({ mode: "server_only", verdict: "not_decided", result: { recordedAgeMs: { "env-a": 3600000, bad: "x" }, environments: [] } }));
    expect(report.summary).toContain("not a measured pair");
    expect(report.recordedAgeMs).toEqual({ "env-a": 3600000 });
  });

  it("says a failed or running verification said nothing yet", () => {
    expect(verificationReport(climb(), record({ status: "failed", failureReason: "deadline" })).summary).toContain("deadline");
    expect(verificationReport(climb(), record({ status: "running" })).summary).toContain("still running");
  });
});
