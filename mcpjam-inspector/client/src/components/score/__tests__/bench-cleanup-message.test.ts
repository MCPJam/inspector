import { describe, expect, it } from "vitest";
import { benchCleanupState } from "@/lib/apis/bench-api";
import { benchCancelledCleanupMessage } from "../bench-cleanup-message";

/**
 * What we may tell someone about their own connector.
 *
 * Cancelling marks a run terminal immediately, so the cancel screen renders
 * while the worker may still be deleting things. The old copy said "anything
 * it wrote to your connector was still cleaned up" on that branch
 * unconditionally — equally cheerful over recorded residue and over a run that
 * had attempted no cleanup at all. These pin the one reading of the ledger
 * that earns the reassurance, and that the others do not get it.
 */
describe("benchCleanupState", () => {
  it("reads an absent ledger as unreported, never as clean", () => {
    // Absent is still reachable — an older backend, or a status read from
    // before the field existed. It is NOT the same claim as `not_applicable`:
    // one says "this exam creates nothing", the other says nothing at all.
    expect(benchCleanupState(undefined)).toEqual({ kind: "unreported" });
  });

  it("keeps not_applicable distinct from a finished cleanup", () => {
    expect(
      benchCleanupState({ status: "not_applicable", residueCount: 0 }),
    ).toEqual({ kind: "nothing_created" });
    expect(benchCleanupState({ status: "complete", residueCount: 0 })).toEqual({
      kind: "clean",
    });
  });

  it("carries the residue count through", () => {
    expect(benchCleanupState({ status: "residue", residueCount: 2 })).toEqual({
      kind: "residual",
      residue: 2,
    });
  });

  it("treats both unfinished states as in progress", () => {
    expect(benchCleanupState({ status: "pending", residueCount: 0 })).toEqual({
      kind: "in_progress",
    });
    expect(benchCleanupState({ status: "running", residueCount: 0 })).toEqual({
      kind: "in_progress",
    });
  });
});

describe("what a cancelled run says about the connector", () => {
  it("promises nothing when there is no ledger to promise from", () => {
    const message = benchCancelledCleanupMessage(undefined);
    expect(message).toBe("We have no cleanup report for this run yet.");
    expect(message).not.toMatch(/cleaned up|removed/i);
  });

  it("names the residue rather than softening it", () => {
    // These are objects sitting in somebody's tenant that they now have to
    // remove by hand. A vague sentence leaves them there.
    const message = benchCancelledCleanupMessage({
      status: "residue",
      residueCount: 2,
    });
    expect(message).toContain("2 items");
    expect(message).toMatch(/could not be removed/);
  });

  it("does not claim removal while cleanup is still running", () => {
    const message = benchCancelledCleanupMessage({
      status: "pending",
      residueCount: 0,
    });
    expect(message).toMatch(/still running/);
    expect(message).not.toMatch(/was removed/);
  });

  it("says everything was removed only when it was", () => {
    expect(
      benchCancelledCleanupMessage({ status: "complete", residueCount: 0 }),
    ).toBe("Everything it created on your connector was removed.");
  });

  it("distinguishes a read-only exam from one that cleaned up after itself", () => {
    expect(
      benchCancelledCleanupMessage({
        status: "not_applicable",
        residueCount: 0,
      }),
    ).toBe("This exam only reads, so nothing was created on your connector.");
  });
});
