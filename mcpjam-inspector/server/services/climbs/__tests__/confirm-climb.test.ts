import { describe, expect, it, vi } from "vitest";
import { confirmClimb } from "../confirm-climb.js";
import { runGroupIdFor } from "../run-group-id.js";
import { CLIMB, SUITE, fakeConvex, registered, startedReceipt } from "./helpers.js";
import { climbRow } from "./climb-fixtures.js";

const CLIMB_ROW = climbRow({ state: "stopped", stopReason: "round_limit", rounds: [], groups: { steering: 4, validation: 2, confirmation: 3, steeringCases: [], steeringToolsWithoutValidation: [] } }) as never;

const confirmationGroup = (role: string) => {
  const base = registered(role, { serverId: role === "best" ? "s_best" : "s_baseline", caseIds: ["c1", "c2", "c3"] });
  const idempotencyKey = `climb:${CLIMB}:confirmation:1:${role}`;
  return { ...base, idempotencyKey, runGroupId: runGroupIdFor(SUITE, idempotencyKey) };
};

function setup(handlers: Record<string, (args: any) => unknown> = {}) {
  const groups = [confirmationGroup("baseline"), confirmationGroup("best")];
  const fake = fakeConvex({
    "climbFinish:planClimbFinish": () => ({ allowed: true, caseIds: ["c1", "c2", "c3"], environmentIds: ["env_a"], confirmationCasesUsedBy: [] }),
    "testSuites:estimateSuiteRunCredits": () => ({ credits: 12, lowerBoundCredits: 9 }),
    "climbFinish:beginClimbConfirmation": () => ({ unitKey: "confirmation:1", estimatedCredits: 24, confirmationCasesUsedBy: ["climb-0"], groups }),
    "climbSettle:recordClimbRunLaunch": () => ({}),
    "climbFinish:getClimbConfirmation": () => ({ status: "running", unitKey: "confirmation:1", startedAt: 1, startedBy: "u", estimatedCredits: 24 }),
    "climbs:getClimb": () => CLIMB_ROW,
    "climbRounds:getClimbRound": () => ({ number: 1 }),
    ...handlers,
  });
  const createEvalRunGroup = vi.fn(async ({ body }: any) => startedReceipt(groups.find((g) => g.idempotencyKey === body.idempotencyKey)!));
  const deps = { convex: fake.convex, client: { createEvalRunGroup, cancelEvalRun: vi.fn() } as never, hashListing: vi.fn(async () => "hash"), readServer: vi.fn(), appOrigin: "https://app.test" };
  return { deps, fake, createEvalRunGroup };
}

const clock = () => {
  let now = 0;
  return { now: () => now, sleep: vi.fn(async (ms: number) => void (now += ms)) };
};

describe("confirmClimb", () => {
  it("quotes two groups on the confirmation cases and starts nothing on a dry run", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    const result = await confirmClimb(deps, "proj1", CLIMB_ROW, { dryRun: true, waitSeconds: 0 });
    expect(result).toMatchObject({ dryRun: true, settled: false, confirmationCaseCount: 3, environmentIds: ["env_a"], estimate: { creditsPerGroup: 12, groups: 2 } });
    expect(fake.called("testSuites:estimateSuiteRunCredits")[0]).toEqual({ suiteId: SUITE, environmentIds: ["env_a"], caseIds: ["c1", "c2", "c3"] });
    expect(fake.called("climbFinish:beginClimbConfirmation")).toEqual([]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("refuses with the backend's own code and quotes and launches nothing", async () => {
    const { deps, fake, createEvalRunGroup } = setup({
      "climbFinish:planClimbFinish": () => ({
        allowed: false,
        refusal: { code: "CLIMB_NOTHING_TO_CONFIRM", message: "No round of this climb stands as kept, so there is nothing to confirm." },
        caseIds: [],
        environmentIds: [],
        confirmationCasesUsedBy: [],
      }),
    });
    const error: any = await confirmClimb(deps, "proj1", CLIMB_ROW, { dryRun: false, waitSeconds: 0 }).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details.code).toBe("CLIMB_NOTHING_TO_CONFIRM");
    expect(fake.called("testSuites:estimateSuiteRunCredits")).toEqual([]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("registers and launches the baseline mock and the best server on the confirmation cases", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    const result = await confirmClimb(deps, "proj1", CLIMB_ROW, { dryRun: false, waitSeconds: 0 });
    expect(fake.called("climbFinish:beginClimbConfirmation")[0]).toEqual({ climbId: CLIMB, realListingHash: "hash", estimatedCreditsPerGroup: 12 });
    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    expect(createEvalRunGroup.mock.calls[0]![0].body.caseIds).toEqual(["c1", "c2", "c3"]);
    expect(result).toMatchObject({ dryRun: false, unitKey: "confirmation:1", settled: false, confirmationCasesUsedBy: ["climb-0"] });
    expect(result.groups!.map((group) => group.role)).toEqual(["baseline", "best"]);
  });

  it("holds until the confirmation settles and returns its interval and the summary", async () => {
    let reads = 0;
    const record = { status: "settled", unitKey: "confirmation:1", startedAt: 1, startedBy: "u", estimatedCredits: 24, environments: [{ environmentId: "env_a" }], measure: "pass_rate" };
    const row = (caseKey: string, arm: string, passed: number) => ({ environmentId: "env_a", caseKey, arm, counted: 3, passed, lost: 0, m: { tokens: { sum: 0, n: 0, missing: 3 }, cost: { sum: 0, n: 0, missing: 3 }, tool_calls: { sum: 0, n: 0, missing: 3 } } });
    const { deps } = setup({
      "climbs:getClimb": () => ({ ...(CLIMB_ROW as object), rounds: [{ number: 1, status: "settled" }] }),
      "climbRounds:getClimbRound": () => ({ number: 1, status: "settled", verdict: "kept", standing: "kept", reasons: [], environments: [] }),
      "climbFinish:getClimbConfirmation": () => {
        reads += 1;
        return reads < 3
          ? { status: "running", unitKey: "confirmation:1", startedAt: 1, startedBy: "u", estimatedCredits: 24 }
          : { ...record, cases: ["a", "b", "c"].flatMap((key) => [row(key, "baseline", 0), row(key, "best", 3)]) };
      },
    });
    const c = clock();
    const result = await confirmClimb(deps, "proj1", CLIMB_ROW, { dryRun: false, waitSeconds: 40 }, c);
    expect(result.settled).toBe(true);
    expect(result.result).toMatchObject({ status: "settled", environments: [{ environmentId: "env_a", difference: 100, includesZero: false }] });
    expect(result.summary?.notEstablished.join(" ")).toContain("both helped pick this result");
    expect(c.sleep).toHaveBeenCalledTimes(2);
  });

  it("returns unsettled at the bound, so the caller reads the climb later", async () => {
    const { deps } = setup();
    const result = await confirmClimb(deps, "proj1", CLIMB_ROW, { dryRun: false, waitSeconds: 5 }, clock());
    expect(result).toMatchObject({ settled: false });
    expect(result.result).toBeUndefined();
  });
});
