import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { submitRound } from "../submit-round.js";
import { wait } from "./wait-helper.js";
import { CLIMB, SUITE, fakeConvex, registered, startedReceipt } from "./helpers.js";

const CLIMB_ROW = {
  climbId: CLIMB,
  suiteId: SUITE,
  projectId: "proj1",
  serverId: "s_real",
  serverName: "Echo",
  environmentIds: ["env_a", "env_b"],
} as never;

const group = (role: string, over = {}) => ({
  ...registered(role, { serverId: "s_candidate", serverVersion: "4", caseIds: ["case_1"] }),
  idempotencyKey: `climb:${CLIMB}:round:2:${role}`,
  ...over,
});
function withKey(role: string, over = {}) {
  const base = group(role, over);
  return { ...base, runGroupId: wait.groupId(base.idempotencyKey) };
}

function setup(handlers: Record<string, (args: any) => unknown> = {}, groups = [withKey("candidate")]) {
  const fake = fakeConvex({
    "climbRounds:planClimbRound": () => ({
      allowed: true,
      candidateCaseIds: ["case_1", "case_2"],
      remeasureBest: null,
      environmentIds: ["env_a", "env_b"],
      creditsLeft: 100,
      roundsLeft: 2,
    }),
    "testSuites:estimateSuiteRunCredits": () => ({ credits: 25, lowerBoundCredits: 20 }),
    "mockServers:getMock": () => ({ version: 4, definitionJson: JSON.stringify({ tools: { search: { description: "Search the index." } } }) }),
    "projectEnvironments:resolveEnvironmentForLaunch": () => ({
      environmentRef: { environmentId: "env_a", name: "Staging", revision: 1 },
      hostId: "host_plain",
      selectedServerIds: ["s_real"],
      servers: [{ serverId: "s_real", name: "Echo" }],
    }),
    "hosts:getHost": () => ({ config: { hostStyle: "mcpjam" } }),
    "climbRounds:beginClimbRound": () => ({ roundNumber: 2, unitKey: "round:2", remeasureBest: false, groups }),
    "climbSettle:recordClimbRunLaunch": () => ({}),
    "climbSettle:failClimbUnit": () => ({ failed: 1 }),
    ...handlers,
  });
  const createEvalRunGroup = vi.fn(async ({ body }: any) =>
    startedReceipt(groups.find((g) => g.idempotencyKey === body.idempotencyKey)!),
  );
  const deps = { convex: fake.convex, client: { createEvalRunGroup, cancelEvalRun: vi.fn() } as never, hashListing: vi.fn(async () => "hash") };
  return { deps, fake, createEvalRunGroup };
}
const args = { serverId: "s_candidate", idempotencyKey: "k1", submittedVia: "mcp" as const };

describe("submitRound", () => {
  it("quotes the candidate's cases, registers the round with who sent it, and launches the candidate group", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    const submitted = await submitRound(deps, "proj1", CLIMB_ROW, args);

    expect(fake.called("testSuites:estimateSuiteRunCredits")[0]).toEqual({
      suiteId: SUITE,
      environmentIds: ["env_a", "env_b"],
      caseIds: ["case_1", "case_2"],
    });
    expect(fake.called("climbRounds:beginClimbRound")[0]).toEqual({
      climbId: CLIMB,
      serverId: "s_candidate",
      // The head the mock had when the round was submitted, so a later edit cannot change what ran.
      serverVersion: "4",
      realListingHash: "hash",
      idempotencyKey: "k1",
      estimatedCreditsPerGroup: 25,
      submittedVia: "mcp",
    });
    expect(createEvalRunGroup).toHaveBeenCalledTimes(1);
    expect(createEvalRunGroup.mock.calls[0]![0].body).toMatchObject({
      caseIds: ["case_1"],
      serverReplacements: [{ serverName: "Echo", replacementServerId: "s_candidate", replacementVersion: "4", realListingHash: "hash" }],
    });
    expect(submitted).toMatchObject({
      climbId: CLIMB,
      roundNumber: 2,
      unitKey: "round:2",
      replayed: false,
      remeasureBest: false,
      estimate: { creditsPerGroup: 25, groups: 1 },
    });
    expect(submitted.groups[0]!.runs).toHaveLength(2);
  });

  it("launches the best so far's group beside the candidate when the backend says to measure it again", async () => {
    const groups = [withKey("candidate"), withKey("best", { serverId: "s_best" })];
    const { deps, createEvalRunGroup, fake } = setup(
      {
        "climbRounds:planClimbRound": () => ({
          allowed: true,
          candidateCaseIds: ["case_1"],
          remeasureBest: { caseIds: ["case_1"], reasons: ["older_than_an_hour"] },
        }),
        "climbRounds:beginClimbRound": () => ({
          roundNumber: 2,
          unitKey: "round:2",
          remeasureBest: true,
          remeasureReasons: ["older_than_an_hour"],
          groups,
        }),
      },
      groups,
    );
    const submitted = await submitRound(deps, "proj1", CLIMB_ROW, args);
    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    expect(submitted).toMatchObject({ remeasureBest: true, remeasureReasons: ["older_than_an_hour"], estimate: { groups: 2 } });
    expect(fake.called("testSuites:estimateSuiteRunCredits")).toHaveLength(1);
  });

  it("names a refusal from the plan before any quote, registration or run", async () => {
    const { deps, fake, createEvalRunGroup } = setup({
      "climbRounds:planClimbRound": () => ({
        allowed: false,
        refusal: {
          code: "CLIMB_NOTHING_TO_FIX_FOR_PASS_RATE",
          message: "Every steering case passes. Climb for tokens, cost or tool calls instead.",
        },
        candidateCaseIds: [],
        remeasureBest: null,
      }),
    });
    const error: any = await submitRound(deps, "proj1", CLIMB_ROW, args).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details.code).toBe("CLIMB_NOTHING_TO_FIX_FOR_PASS_RATE");
    expect(error.message).toContain("tokens, cost or tool calls");
    expect(fake.called("climbRounds:beginClimbRound")).toEqual([]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("keeps the backend's numbers on a limit refusal", async () => {
    const { deps, createEvalRunGroup } = setup({
      "climbRounds:beginClimbRound": () => {
        throw new ConvexError({ code: "CLIMB_CREDIT_LIMIT_REACHED", message: "This round needs 50 credits and 20 are left.", needed: 50, left: 20 });
      },
    });
    const error: any = await submitRound(deps, "proj1", CLIMB_ROW, args).catch((e) => e);
    // The route answers it with the backend's code and numbers (see climbs.test.ts).
    expect(error.data).toMatchObject({ code: "CLIMB_CREDIT_LIMIT_REACHED", needed: 50, left: 20 });
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("launches nothing again for a key that already launched, and says it was a replay", async () => {
    const { deps, createEvalRunGroup } = setup({
      "climbRounds:beginClimbRound": () => ({
        roundNumber: 2,
        unitKey: "round:2",
        replayed: true,
        remeasureBest: false,
        groups: [withKey("candidate", { status: "launched" })],
      }),
    });
    const submitted = await submitRound(deps, "proj1", CLIMB_ROW, args);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
    expect(submitted.replayed).toBe(true);
  });

  it("launches the groups of the new attempt of a cut-off round, under their own keys, and not the old one's", async () => {
    const attemptTwo = withKey("candidate", {
      idempotencyKey: `climb:${CLIMB}:round:2:candidate:attempt:2`,
      attempt: 2,
    });
    const { deps, createEvalRunGroup } = setup(
      {
        "climbRounds:beginClimbRound": () => ({
          roundNumber: 2,
          unitKey: "round:2",
          replayed: true,
          remeasureBest: false,
          // The backend returns the last attempt's groups only.
          groups: [attemptTwo],
        }),
      },
      [attemptTwo],
    );
    const submitted = await submitRound(deps, "proj1", CLIMB_ROW, args);
    expect(submitted.replayed).toBe(true);
    expect(createEvalRunGroup).toHaveBeenCalledTimes(1);
    expect(createEvalRunGroup.mock.calls[0][0].body).toMatchObject({ idempotencyKey: `climb:${CLIMB}:round:2:candidate:attempt:2` });
    expect(submitted.groups.map((g) => g.runGroupId)).toEqual([attemptTwo.runGroupId]);
  });

  it("uses the version the caller named and sends none for a server that is not a mock", async () => {
    const named = setup();
    await submitRound(named.deps, "proj1", CLIMB_ROW, { ...args, serverVersion: "2" });
    expect(named.fake.called("climbRounds:beginClimbRound")[0]).toMatchObject({ serverVersion: "2" });
    // The head is not read to find a version: the one the caller named is the one checked.
    expect(named.fake.called("mockServers:getMock")).toEqual([{ mockId: "s_candidate", version: 2 }]);

    const plain = setup({
      "mockServers:getMock": () => {
        throw new ConvexError({ code: "MOCK_NOT_FOUND", message: "no" });
      },
    });
    await submitRound(plain.deps, "proj1", CLIMB_ROW, args);
    expect(plain.fake.called("climbRounds:beginClimbRound")[0]).not.toHaveProperty("serverVersion");
  });

  it("cancels what started and fails the round when its launch is partial", async () => {
    const { deps, createEvalRunGroup, fake } = setup();
    createEvalRunGroup.mockRejectedValue(new Error("Too many concurrent eval runs"));
    await expect(submitRound(deps, "proj1", CLIMB_ROW, args)).rejects.toMatchObject({ details: { code: "CLIMB_LAUNCH_FAILED" } });
    expect(fake.called("climbSettle:failClimbUnit")).toEqual([{ climbId: CLIMB, unitKey: "round:2", reason: expect.any(String) }]);
  });
});
