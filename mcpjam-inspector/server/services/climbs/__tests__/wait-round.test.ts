import { describe, expect, it, vi } from "vitest";
import { ROUND_POLL_MS, readRound } from "../wait-round.js";
import { CLIMB, SUITE, fakeConvex } from "./helpers.js";

const scope = { climbId: CLIMB, suiteId: SUITE };

function clock() {
  let now = 0;
  return { now: () => now, sleep: vi.fn(async (ms: number) => void (now += ms)) };
}

describe("readRound", () => {
  it("reads once and does not wait when no wait was asked for", async () => {
    const fake = fakeConvex({ "climbRounds:getClimbRound": () => ({ number: 2, status: "running" }) });
    const c = clock();
    const round = await readRound(fake.convex, scope, 2, 0, c);
    expect(round).toMatchObject({ climbId: CLIMB, suiteId: SUITE, status: "running", settled: false, waitedMs: 0 });
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it("holds until the round settles and says how long it waited", async () => {
    const statuses = ["running", "running", "settled"];
    const fake = fakeConvex({ "climbRounds:getClimbRound": () => ({ number: 2, status: statuses.shift(), verdict: "kept" }) });
    const c = clock();
    const round = await readRound(fake.convex, scope, 2, 30, c);
    expect(round).toMatchObject({ status: "settled", settled: true, waitedMs: 2 * ROUND_POLL_MS });
    expect(fake.called("climbRounds:getClimbRound")).toHaveLength(3);
  });

  it("stops at the bound with a round that is still running, so the caller can ask again", async () => {
    const fake = fakeConvex({ "climbRounds:getClimbRound": () => ({ number: 2, status: "running" }) });
    const c = clock();
    const round = await readRound(fake.convex, scope, 2, 5, c);
    expect(round.settled).toBe(false);
    expect(round.waitedMs).toBeLessThanOrEqual(5_000);
    expect(c.sleep.mock.calls.length).toBe(2);
  });

  it("treats a failed round as settled: nothing more will happen to it", async () => {
    const fake = fakeConvex({ "climbRounds:getClimbRound": () => ({ number: 2, status: "failed", failureReason: "deadline" }) });
    expect((await readRound(fake.convex, scope, 2, 30, clock())).settled).toBe(true);
  });
});
