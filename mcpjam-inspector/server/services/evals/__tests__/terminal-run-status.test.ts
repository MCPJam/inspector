/**
 * The two questions a run status answers, and why they are different questions.
 *
 * `grading` is what splits them. A run held for its gating judge has run every
 * trial — there is nothing left to execute, and executing it again would run
 * the whole suite a second time and bill for it — but it has NO VERDICT: its
 * `result` is `pending` and only `finalizeAfterJudge` will set it.
 *
 * So "should I run this" and "is this done" stop having the same answer, and
 * the cost of collapsing them is a defect in whichever direction it collapses:
 * treat `grading` as terminal and a poller reports a run with no verdict as
 * decided; treat it as still-executing and a redelivered claim double-bills a
 * customer.
 */

import { describe, expect, it } from "vitest";
import {
  isRunPastExecution,
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
} from "../run-status.js";
import { shouldSkipExecution } from "../../../routes/shared/evals.js";

describe("TERMINAL_RUN_STATUSES", () => {
  it("holds exactly the four statuses at which a run is decided", () => {
    // Pinned as SET EQUALITY, so a fifth member is a deliberate act. Adding
    // `grading` here is the single most damaging edit available: every gate,
    // poller and check that asks "is this done" would start answering yes for
    // a run that has not been decided.
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "timed_out",
    ]);
  });

  it("does not call a held run terminal", () => {
    expect(isTerminalRunStatus("grading")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(status), status).toBe(true);
    }
  });
});

describe("isRunPastExecution", () => {
  it("adds `grading` and nothing else", () => {
    expect(isRunPastExecution("grading")).toBe(true);
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isRunPastExecution(status), status).toBe(true);
    }
    expect(isRunPastExecution("running")).toBe(false);
    expect(isRunPastExecution("pending")).toBe(false);
    expect(isRunPastExecution(undefined)).toBe(false);
  });
});

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
