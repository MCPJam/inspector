import { describe, expect, it, vi } from "vitest";
import { launchUnit, type LaunchUnitArgs } from "../launch-unit.js";
import { CLIMB, SUITE, fakeConvex, registered, startedReceipt } from "./helpers.js";

function setup(over: Partial<LaunchUnitArgs> = {}, launch?: (group: any) => Promise<unknown>) {
  const baselineA = registered("baseline_a");
  const baselineB = registered("baseline_b");
  const fake = fakeConvex({
    "climbSettle:failClimbUnit": () => ({ failed: 2 }),
    "climbSettle:recordClimbRunLaunch": () => ({ settled: false }),
  });
  const createEvalRunGroup = vi.fn(async ({ body }: any) => {
    const group = [baselineA, baselineB].find((g) => g.idempotencyKey === body.idempotencyKey)!;
    return launch ? launch(group) : startedReceipt(group);
  });
  const cancelEvalRun = vi.fn(async () => ({}) as never);
  const args: LaunchUnitArgs = {
    client: { createEvalRunGroup, cancelEvalRun } as never,
    convex: fake.convex,
    projectId: "proj1",
    suiteId: SUITE,
    climbId: CLIMB,
    unitKey: "baseline:1",
    groups: [baselineA, baselineB],
    serverName: "Echo",
    realListingHash: "listing-hash",
    ...over,
  };
  return { args, fake, createEvalRunGroup, cancelEvalRun, baselineA, baselineB };
}

describe("launchUnit", () => {
  it("launches each registered group with its own key, cases and the replacement, and records each run", async () => {
    const { args, fake, createEvalRunGroup } = setup();
    const launched = await launchUnit(args);

    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    const body = createEvalRunGroup.mock.calls[0]![0].body;
    expect(body).toEqual({
      suiteId: SUITE,
      targets: [{ environmentId: "env_a" }, { environmentId: "env_b" }],
      caseIds: ["case_1", "case_2"],
      idempotencyKey: `climb:${CLIMB}:baseline:1:baseline_a`,
      climbId: CLIMB,
      serverReplacements: [
        { serverName: "Echo", replacementServerId: "s_mock", replacementVersion: "1", realListingHash: "listing-hash" },
      ],
    });
    expect(launched.map((group) => [group.role, group.runs.map((run) => run.runId)])).toEqual([
      ["baseline_a", ["baseline_a-env_a", "baseline_a-env_b"]],
      ["baseline_b", ["baseline_b-env_a", "baseline_b-env_b"]],
    ]);
    expect(fake.called("climbSettle:recordClimbRunLaunch")).toHaveLength(4);
    expect(fake.called("climbSettle:failClimbUnit")).toEqual([]);
  });

  it("cancels what started when a second group is refused, marks the unit failed, and says so", async () => {
    const { args, fake, cancelEvalRun } = setup({}, async (group) => {
      if (group.role === "baseline_b") {
        throw Object.assign(new Error("Too many concurrent eval runs (max 2). Wait for an active run to finish."), {
          code: "RATE_LIMITED",
        });
      }
      return startedReceipt(group);
    });

    const error: any = await launchUnit(args).catch((e) => e);

    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      code: "CLIMB_LAUNCH_FAILED",
      unitKey: "baseline:1",
      failures: [{ role: "baseline_b", code: "RATE_LIMITED" }],
      cancelledRunIds: ["baseline_a-env_a", "baseline_a-env_b"],
    });
    expect(error.message).toContain("2 runs that had started were cancelled");
    expect(error.message).toContain("baseline_b run group did not start");
    expect(cancelEvalRun).toHaveBeenCalledTimes(2);
    expect(fake.called("climbSettle:failClimbUnit")).toEqual([
      { climbId: CLIMB, unitKey: "baseline:1", reason: expect.stringContaining("baseline_b") },
    ]);
    expect(fake.called("climbSettle:recordClimbRunLaunch")).toEqual([]);
  });

  it("treats an environment that did not start as a partial launch of its group", async () => {
    const { args, cancelEvalRun } = setup({}, async (group) => {
      const receipt = startedReceipt(group);
      if (group.role !== "baseline_a") return receipt;
      return {
        ...receipt,
        outcome: "partial" as const,
        targets: [
          receipt.targets[0]!,
          { status: "failed" as const, target: { environmentId: "env_b" }, error: { code: "ENVIRONMENT_REVISION_CONFLICT", message: "The environment changed." } },
        ],
      };
    });
    const error: any = await launchUnit(args).catch((e) => e);
    expect(error.details.failures).toEqual([
      { role: "baseline_a", environmentId: "env_b", code: "ENVIRONMENT_REVISION_CONFLICT", message: "The environment changed." },
    ]);
    // Both groups' started runs are cancelled: a unit is all or nothing.
    expect(cancelEvalRun).toHaveBeenCalledTimes(3);
  });

  it("still fails the unit when a cancel fails", async () => {
    const { args, fake, cancelEvalRun } = setup({}, async (group) => {
      if (group.role === "baseline_b") throw new Error("down");
      return startedReceipt(group);
    });
    cancelEvalRun.mockRejectedValueOnce(new Error("run already finished"));
    const error: any = await launchUnit(args).catch((e) => e);
    expect(error.message).toContain("1 run that had started was cancelled");
    expect(fake.called("climbSettle:failClimbUnit")).toHaveLength(1);
  });

  it("refuses to launch a group whose id does not follow from its key, and fails the unit", async () => {
    const { args, fake, createEvalRunGroup, baselineA } = setup();
    args.groups = [{ ...baselineA, runGroupId: "0".repeat(32) }];
    const error: any = await launchUnit(args).catch((e) => e);
    expect(error.details).toMatchObject({ code: "CLIMB_RUN_GROUP_ID_MISMATCH", role: "baseline_a" });
    expect(createEvalRunGroup).not.toHaveBeenCalled();
    expect(fake.called("climbSettle:failClimbUnit")).toHaveLength(1);
  });

  it("leaves a launched unit launched when recording a run fails", async () => {
    const { args } = setup();
    args.convex = fakeConvex({ "climbSettle:recordClimbRunLaunch": () => { throw new Error("busy"); } }).convex;
    await expect(launchUnit(args)).resolves.toHaveLength(2);
  });
});
