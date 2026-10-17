/**
 * Whether a replayed start should execute, which is not "is it done": a run
 * held in `grading` has run every trial, so executing it again would bill the
 * suite twice, yet it has no verdict. The lifecycle predicates are pinned in
 * `sdk/tests/contract-eval-lifecycle.test.ts`; this pins the execution guard.
 */

import { describe, expect, it } from "vitest";
import { shouldSkipExecution } from "../../../routes/shared/evals.js";

describe("shouldSkipExecution", () => {
  it("skips a replay of a run held for its judge", () => {
    // The double-spend this guard exists for, in a status that is deliberately
    // not terminal: every trial already ran, so executing would run the whole
    // suite again and bill for it.
    expect(shouldSkipExecution({ deduped: true, status: "grading" })).toBe(
      true,
    );
  });

  it("still executes a replay of a run genuinely in flight", () => {
    expect(shouldSkipExecution({ deduped: true, status: "running" })).toBe(
      false,
    );
    expect(shouldSkipExecution({ deduped: true, status: "pending" })).toBe(
      false,
    );
  });

  it("never skips a fresh start, whatever its status", () => {
    expect(shouldSkipExecution({ status: "grading" })).toBe(false);
    expect(shouldSkipExecution({ deduped: false, status: "completed" })).toBe(
      false,
    );
  });
});
