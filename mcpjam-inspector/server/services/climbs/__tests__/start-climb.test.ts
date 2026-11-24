import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { continueClimb } from "../continue-climb.js";
import { startClimb } from "../start-climb.js";
import { CLIMB, SUITE, fakeConvex, registered, startedReceipt } from "./helpers.js";

const CLIMB_ROW = {
  climbId: CLIMB,
  suiteId: SUITE,
  projectId: "proj1",
  serverId: "s_real",
  serverName: "Echo",
  environmentIds: ["env_a", "env_b"],
  state: "baselining",
  groups: { steering: 6, validation: 3, confirmation: 3 },
};

function setup(handlers: Record<string, (args: any) => unknown> = {}) {
  const groups = [registered("baseline_a"), registered("baseline_b")];
  const fake = fakeConvex({
    "climbs:startClimb": () => CLIMB_ROW,
    "mockServers:createMock": () => ({ mockId: "s_mock", version: 1, contentHash: "h" }),
    "testSuites:estimateSuiteRunCredits": () => ({ credits: 40, lowerBoundCredits: 30 }),
    "climbs:beginClimbBaseline": () => ({ unitKey: "baseline:1", estimatedCredits: 60, groups }),
    "climbs:getClimb": () => ({ ...CLIMB_ROW, activeUnitKey: "baseline:1" }),
    "climbSettle:recordClimbRunLaunch": () => ({}),
    "climbRounds:stopClimb": () => ({ state: "stopped" }),
    ...handlers,
  });
  const createEvalRunGroup = vi.fn(async ({ body }: any) =>
    startedReceipt(groups.find((g) => g.idempotencyKey === body.idempotencyKey)!),
  );
  const hashListing = vi.fn(async () => "listing-hash");
  const deps = {
    convex: fake.convex,
    client: { createEvalRunGroup, cancelEvalRun: vi.fn() } as never,
    hashListing,
  };
  return { deps, fake, createEvalRunGroup, hashListing };
}

describe("startClimb", () => {
  it("makes a mock with no changes, quotes the steering and validation share, and launches the baseline's two groups", async () => {
    const { deps, fake, createEvalRunGroup, hashListing } = setup();
    const started = await startClimb(deps, "proj1", { suiteId: SUITE, serverId: "s_real", roundLimit: 3, creditLimit: 500 });

    expect(fake.calls.map((call) => call.name)).toEqual([
      "climbs:startClimb",
      "mockServers:createMock",
      "testSuites:estimateSuiteRunCredits",
      "climbs:beginClimbBaseline",
      "climbSettle:recordClimbRunLaunch",
      "climbSettle:recordClimbRunLaunch",
      "climbSettle:recordClimbRunLaunch",
      "climbSettle:recordClimbRunLaunch",
      "climbs:getClimb",
    ]);
    expect(fake.called("mockServers:createMock")[0]).toEqual({
      projectId: "proj1",
      baseServerId: "s_real",
      name: `Echo (climb ${CLIMB.slice(-6)} baseline)`,
      definitionJson: "{}",
    });
    expect(hashListing).toHaveBeenCalledWith("proj1", "s_real");
    // 40 credits for the suite, 9 of 12 cases run: 30 a group, two groups.
    expect(fake.called("testSuites:estimateSuiteRunCredits")[0]).toEqual({
      suiteId: SUITE,
      environmentIds: ["env_a", "env_b"],
    });
    expect(fake.called("climbs:beginClimbBaseline")[0]).toEqual({
      climbId: CLIMB,
      serverId: "s_mock",
      serverVersion: "1",
      realListingHash: "listing-hash",
      estimatedCreditsPerGroup: 30,
    });
    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    expect(started.launch).toMatchObject({
      unitKey: "baseline:1",
      estimate: { creditsPerGroup: 30, groups: 2, lowerBound: false },
    });
    expect(started.launch.groups.flatMap((group) => group.runs)).toHaveLength(4);
    expect(started.activeUnitKey).toBe("baseline:1");
  });

  it("passes the caller's choices to the backend as given and quotes a floor when MCPJam cannot price every run", async () => {
    const { deps, fake } = setup({
      "testSuites:estimateSuiteRunCredits": () => ({ credits: null, lowerBoundCredits: 10 }),
    });
    const started = await startClimb(deps, "proj1", {
      suiteId: SUITE,
      serverId: "s_real",
      roundLimit: 2,
      creditLimit: 90,
      measure: "tokens",
      groupLists: { steering: ["a"] },
    });
    expect(fake.called("climbs:startClimb")[0]).toMatchObject({ measure: "tokens", groupLists: { steering: ["a"] } });
    expect(started.launch.estimate).toMatchObject({ lowerBound: true, creditsPerGroup: 8 });
  });

  it("makes nothing and launches nothing when the backend refuses the climb", async () => {
    const { deps, fake, createEvalRunGroup } = setup({
      "climbs:startClimb": () => {
        throw new ConvexError({ code: "CLIMB_SUITE_HAS_NO_ENVIRONMENTS", message: "Attach an environment first." });
      },
    });
    await expect(startClimb(deps, "proj1", { suiteId: SUITE, serverId: "s_real", roundLimit: 1, creditLimit: 1 })).rejects.toThrow();
    expect(fake.calls.map((call) => call.name)).toEqual(["climbs:startClimb"]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("stops the climb when the baseline cannot be registered, so a failed start leaves nothing waiting", async () => {
    const { deps, fake, createEvalRunGroup } = setup({
      "climbs:beginClimbBaseline": () => {
        throw new ConvexError({ code: "CLIMB_CREDIT_LIMIT_REACHED", message: "needs 60, 30 left", needed: 60, left: 30 });
      },
    });
    await expect(startClimb(deps, "proj1", { suiteId: SUITE, serverId: "s_real", roundLimit: 1, creditLimit: 30 })).rejects.toThrow();
    expect(fake.called("climbRounds:stopClimb")).toEqual([{ climbId: CLIMB }]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("stops the climb when the baseline's launch fails", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    createEvalRunGroup.mockRejectedValue(new Error("down"));
    await expect(startClimb(deps, "proj1", { suiteId: SUITE, serverId: "s_real", roundLimit: 1, creditLimit: 500 })).rejects.toThrow();
    // The unit was failed (which frees it) and the climb stopped.
    expect(fake.called("climbSettle:failClimbUnit")).toHaveLength(1);
    expect(fake.called("climbRounds:stopClimb")).toHaveLength(1);
  });
});

describe("continueClimb", () => {
  const failed = { ...CLIMB_ROW, baselineFailure: { unitKey: "baseline:2", reason: "Staging lost 3 of 12 iterations." } };

  it("registers and launches the baseline again, as the next attempt, when the last one failed", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    const answer = await continueClimb(deps, "proj1", failed as never);
    expect(answer).toMatchObject({ resumed: false, baselineStarted: true, launch: { unitKey: "baseline:1" } });
    expect(fake.called("mockServers:createMock")[0]).toMatchObject({ name: "Echo (climb " + CLIMB.slice(-6) + " baseline 3)" });
    expect(fake.called("climbs:beginClimbBaseline")).toHaveLength(1);
    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    expect(fake.called("climbSteps:continueClimb")).toEqual([]);
  });

  it("leaves a climb with a baseline or one running to the backend's continue", async () => {
    const { deps, fake, createEvalRunGroup } = setup({ "climbSteps:continueClimb": () => ({ resumed: true, stepDue: false }) });
    const running = { ...failed, activeUnitKey: "baseline:3" };
    expect(await continueClimb(deps, "proj1", running as never)).toMatchObject({ resumed: true, stepDue: false });
    expect(fake.called("climbs:beginClimbBaseline")).toEqual([]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });
});
