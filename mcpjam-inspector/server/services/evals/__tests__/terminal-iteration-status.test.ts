/**
 * "Will this iteration do more work?" — one answer, derived from the canonical
 * lifecycle rather than re-listed.
 *
 * The bug this pins is the one the run-status module was extracted to prevent,
 * one level down: a poller or DTO that knows `completed`/`failed`/`cancelled`/
 * `timed_out` are terminal but not `setup_failed`/`skipped` reports a finished
 * trial as still running — `durationMs: null` for the one class of failure an
 * operator is timing, and a poll that never ends.
 */

import { describe, expect, it } from "vitest";
import { ITERATION_STATUSES } from "@mcpjam/sdk/contract";
import {
  TERMINAL_ITERATION_STATUSES,
  isTerminalIterationStatus,
} from "../run-status.js";

describe("terminal iteration statuses", () => {
  it("treats every lifecycle status except pending/running as terminal", () => {
    expect([...TERMINAL_ITERATION_STATUSES].sort()).toEqual(
      [
        "cancelled",
        "completed",
        "failed",
        "setup_failed",
        "skipped",
        "timed_out",
      ].sort(),
    );
  });

  it("stays derived from the contract, so a new status is terminal by default", () => {
    // The safe direction: a status this module has never heard of ends the
    // iteration rather than stalling a poller forever.
    const nonTerminal = ITERATION_STATUSES.filter(
      (status) => !TERMINAL_ITERATION_STATUSES.has(status),
    );
    expect(nonTerminal).toEqual(["pending", "running"]);
  });

  it("includes setup_failed and skipped", () => {
    expect(isTerminalIterationStatus("setup_failed")).toBe(true);
    expect(isTerminalIterationStatus("skipped")).toBe(true);
  });

  it("rejects non-statuses without throwing", () => {
    for (const value of [undefined, null, 3, {}, "", "COMPLETED", "done"]) {
      expect(isTerminalIterationStatus(value)).toBe(false);
    }
  });
});
