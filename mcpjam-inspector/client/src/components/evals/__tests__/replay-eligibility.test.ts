import { describe, expect, it } from "vitest";
import { getSuiteReplayEligibility } from "../replay-eligibility";

describe("getSuiteReplayEligibility", () => {
  it("allows replay fallback when the latest run is replayable but suite servers are empty", () => {
    expect(
      getSuiteReplayEligibility({
        suiteServers: [],
        connectedServerNames: new Set(),
        latestRun: {
          _id: "run-1",
          hasServerReplayConfig: true,
        } as any,
      }),
    ).toMatchObject({
      hasServersConfigured: false,
      canRunLive: false,
      canReplayFallback: true,
      canRunNow: true,
    });
  });

  it("prefers the live rerun path when all suite servers are connected", () => {
    expect(
      getSuiteReplayEligibility({
        suiteServers: ["asana"],
        connectedServerNames: new Set(["asana"]),
        latestRun: {
          _id: "run-1",
          hasServerReplayConfig: true,
        } as any,
      }),
    ).toMatchObject({
      hasServersConfigured: true,
      missingServers: [],
      canRunLive: true,
      canReplayFallback: false,
      canRunNow: true,
    });
  });
});
