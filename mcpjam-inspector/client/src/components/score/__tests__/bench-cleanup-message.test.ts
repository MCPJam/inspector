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
    // The backend OMITS the ledger when it holds nothing. That covers both a
    // read-only exam and a worker that died before recording, and this cannot
    // tell them apart — so it must not pick the comfortable one.
    expect(benchCleanupState(undefined)).toEqual({ kind: "unreported" });
  });

  it("earns clean only when everything recorded was removed", () => {
    expect(benchCleanupState({ recorded: 3, removed: 3, residue: 0 })).toEqual({
      kind: "clean",
      removed: 3,
    });
  });

  it("calls residue residue, whatever else was removed", () => {
    expect(benchCleanupState({ recorded: 4, removed: 3, residue: 1 })).toEqual({
      kind: "residual",
      residue: 1,
      recorded: 4,
    });
  });

  it("is in progress while removed trails recorded with nothing yet residual", () => {
    expect(benchCleanupState({ recorded: 4, removed: 1, residue: 0 })).toEqual({
      kind: "in_progress",
      removed: 1,
      recorded: 4,
    });
  });

  it("does not read an empty ledger as an unfinished one", () => {
    expect(benchCleanupState({ recorded: 0, removed: 0, residue: 0 })).toEqual({
      kind: "clean",
      removed: 0,
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
      recorded: 4,
      removed: 3,
      residue: 1,
    });
    expect(message).toContain("1 of 4");
    expect(message).toMatch(/could not be removed/);
  });

  it("does not claim removal while cleanup is still running", () => {
    const message = benchCancelledCleanupMessage({
      recorded: 4,
      removed: 1,
      residue: 0,
    });
    expect(message).toMatch(/still running/);
    expect(message).toContain("1 of 4");
  });

  it("says everything was removed only when it was", () => {
    expect(
      benchCancelledCleanupMessage({ recorded: 2, removed: 2, residue: 0 }),
    ).toMatch(/Everything it created on your connector was removed \(2\)/);
  });

  it("distinguishes a run that created nothing from one that cleaned up", () => {
    expect(
      benchCancelledCleanupMessage({ recorded: 0, removed: 0, residue: 0 }),
    ).toBe("This run created nothing on your connector.");
  });
});
