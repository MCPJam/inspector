/**
 * The three lifecycle questions a run or iteration status answers, and why
 * they are different questions.
 *
 * `grading` is what splits the run questions apart. A run held for its gating
 * judge has run every trial, so executing it again would run and bill the
 * suite twice, but it has NO VERDICT: its `result` is `pending`. Treat it as
 * terminal and a poller reports a run with no verdict as decided; treat it as
 * still executing and a redelivered claim double-bills a customer.
 */

import { describe, expect, it } from "vitest";
import lifecycleFixtures from "./fixtures/eval-lifecycle-parity-fixtures.json" with { type: "json" };
import { ITERATION_STATUSES } from "../src/contract/chain.js";
import {
  EVAL_ITERATION_TERMINAL_STATUSES,
  EVAL_RUN_STATUSES,
  EVAL_RUN_TERMINAL_STATUSES,
  evalRunStatusSchema,
  isEvalIterationNonVerdictStatus,
  isEvalIterationTerminalStatus,
  isEvalRunNonVerdictStatus,
  isEvalRunPastExecution,
  isEvalRunTerminalStatus,
} from "../src/contract/index.js";

const NOT_STATUSES = [undefined, null, 3, {}, "", "COMPLETED", "done"];

describe("EVAL_RUN_STATUSES", () => {
  it("mirrors the backend run status union", () => {
    expect([...EVAL_RUN_STATUSES]).toEqual([
      "pending",
      "running",
      "grading",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]);
  });

  it("parses the vocabulary and nothing else", () => {
    for (const status of EVAL_RUN_STATUSES) {
      expect(evalRunStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const value of NOT_STATUSES) {
      expect(evalRunStatusSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("isEvalRunTerminalStatus", () => {
  it("holds exactly the four statuses at which a run is decided", () => {
    // Set equality, so a fifth member is a deliberate act. Adding `grading`
    // is the most damaging edit available: every gate, poller and check that
    // asks "is this done" would answer yes for a run that has not been decided.
    expect([...EVAL_RUN_TERMINAL_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "timed_out",
    ]);
    for (const status of EVAL_RUN_TERMINAL_STATUSES) {
      expect(isEvalRunTerminalStatus(status), status).toBe(true);
    }
  });

  it("does not call a held or live run terminal", () => {
    for (const status of ["grading", "running", "pending", ...NOT_STATUSES]) {
      expect(isEvalRunTerminalStatus(status)).toBe(false);
    }
  });
});

describe("isEvalRunPastExecution", () => {
  it("adds grading to the terminal statuses and nothing else", () => {
    const pastExecution = EVAL_RUN_STATUSES.filter(isEvalRunPastExecution);
    expect([...pastExecution].sort()).toEqual(
      [...EVAL_RUN_TERMINAL_STATUSES, "grading"].sort()
    );
    for (const value of NOT_STATUSES) {
      expect(isEvalRunPastExecution(value)).toBe(false);
    }
  });
});

describe("isEvalIterationTerminalStatus", () => {
  it("treats every iteration status except pending and running as terminal", () => {
    expect([...EVAL_ITERATION_TERMINAL_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "setup_failed",
      "skipped",
      "timed_out",
    ]);
  });

  it("classifies every contract status, so a new one fails until it is listed", () => {
    // No default is safe: a poller stalls on one direction, and the result
    // write is skipped on the other. A new status shows up here as live.
    expect(
      ITERATION_STATUSES.filter(
        (status) => !isEvalIterationTerminalStatus(status)
      )
    ).toEqual(["pending", "running"]);
  });

  it("rejects non-statuses without throwing", () => {
    for (const value of NOT_STATUSES) {
      expect(isEvalIterationTerminalStatus(value)).toBe(false);
    }
  });
});

describe("no-verdict predicates", () => {
  it("names the terminal run statuses that carry no verdict", () => {
    // `completed` is the only terminal run status a gate may read a verdict from.
    expect(
      EVAL_RUN_TERMINAL_STATUSES.filter((status) => !isEvalRunNonVerdictStatus(status))
    ).toEqual(["completed"]);
  });

  it("names the terminal iteration statuses that never reached a judge", () => {
    // `failed` is a verdict on the case; the other four say nothing about it.
    expect(
      EVAL_ITERATION_TERMINAL_STATUSES.filter(
        (status) => !isEvalIterationNonVerdictStatus(status)
      )
    ).toEqual(["completed", "failed"]);
  });
});

describe("eval-lifecycle-parity-fixtures.json", () => {
  // The backend holds a byte-for-byte copy and runs its mirror against it, so
  // these rows are the cross-repo contract: change an answer here and the
  // backend's mirror check fails until both sides agree.
  it("lists every status of both unions, in order", () => {
    expect(lifecycleFixtures.run.map((row) => row.status)).toEqual([
      ...EVAL_RUN_STATUSES,
    ]);
    expect(lifecycleFixtures.iteration.map((row) => row.status)).toEqual([
      ...ITERATION_STATUSES,
    ]);
  });

  it("matches every run predicate", () => {
    for (const row of lifecycleFixtures.run) {
      expect(
        {
          status: row.status,
          terminal: isEvalRunTerminalStatus(row.status),
          pastExecution: isEvalRunPastExecution(row.status),
          nonVerdict: isEvalRunNonVerdictStatus(row.status),
        },
        row.status
      ).toEqual(row);
    }
  });

  it("matches every iteration predicate", () => {
    for (const row of lifecycleFixtures.iteration) {
      expect(
        {
          status: row.status,
          terminal: isEvalIterationTerminalStatus(row.status),
          nonVerdict: isEvalIterationNonVerdictStatus(row.status),
        },
        row.status
      ).toEqual(row);
    }
  });

  it("answers no for every non-status", () => {
    for (const value of lifecycleFixtures.notStatuses) {
      expect(isEvalRunTerminalStatus(value)).toBe(false);
      expect(isEvalRunPastExecution(value)).toBe(false);
      expect(isEvalRunNonVerdictStatus(value)).toBe(false);
      expect(isEvalIterationTerminalStatus(value)).toBe(false);
      expect(isEvalIterationNonVerdictStatus(value)).toBe(false);
    }
  });
});
