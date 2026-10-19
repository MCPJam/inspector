/**
 * The one definition of where an eval run or iteration is in its lifecycle.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Every surface that waits on, gates on, or reports a run asks one of three
 * questions, and they are different questions:
 *
 *   - Is the run TERMINAL? It will never change again, so its verdict can be
 *     read. {@link isEvalRunTerminalStatus}
 *   - Is the run PAST EXECUTION? Nothing is left to execute, but it may still
 *     be deciding. {@link isEvalRunPastExecution}
 *   - Is the ITERATION terminal? The harness is done with that trial.
 *     {@link isEvalIterationTerminalStatus}
 *
 * A copy of any of these is a place a new status gets added to some lists and
 * not others, and a run that one guard reads as finished while another reads
 * it as live is a run that gets finalized twice or executed twice.
 *
 * Swarm runs, benchmark jobs and MCP tasks have their own vocabularies and are
 * deliberately not folded in here.
 */

import { z } from "zod";
import type { IterationStatus } from "./chain.js";

/**
 * Every status an eval run can be stored with. Mirrors the backend
 * `testSuiteRun.status` union exactly.
 */
export const EVAL_RUN_STATUSES = [
  "pending",
  "running",
  "grading",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];
export const evalRunStatusSchema = z.enum(EVAL_RUN_STATUSES);

/**
 * The run statuses that never change again, however the run ended.
 *
 * `grading` IS DELIBERATELY ABSENT. A run held for its gating judge has run
 * every trial but has `result: "pending"` and no verdict yet; a poller, a gate
 * or a check that read it as terminal would report the absence of a verdict as
 * one.
 */
export const EVAL_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly EvalRunStatus[];
export type EvalRunTerminalStatus = (typeof EVAL_RUN_TERMINAL_STATUSES)[number];

/** Whether a run status means the run has finished and its verdict can be read. */
export function isEvalRunTerminalStatus(
  status: unknown
): status is EvalRunTerminalStatus {
  return (EVAL_RUN_TERMINAL_STATUSES as readonly unknown[]).includes(status);
}

/**
 * The narrower question the EXECUTION path asks: is anything left to execute?
 *
 * `grading` splits this from terminality. Every trial of a held run has
 * finished, so executing it again would bill a customer twice for a run
 * already paid for, but its verdict does not exist yet. Use this to decide
 * "should I run this", never "is this done".
 */
export function isEvalRunPastExecution(
  status: unknown
): status is EvalRunTerminalStatus | "grading" {
  return isEvalRunTerminalStatus(status) || status === "grading";
}

/**
 * The iteration statuses at which the harness is done with a trial.
 *
 * Listed rather than derived from the contract's `ITERATION_STATUSES`, because
 * neither default is safe: a finished iteration read as live stalls a poller,
 * and a live one read as terminal is skipped by the write that records its
 * result. The contract test pins this list against the full status set, so a
 * status added to the contract fails it until someone classifies it.
 * `setup_failed` and `skipped` are terminal here like `failed`; they differ
 * from it wherever a verdict is derived, not here.
 */
export const EVAL_ITERATION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "setup_failed",
  "skipped",
] as const satisfies readonly IterationStatus[];

export type EvalIterationTerminalStatus =
  (typeof EVAL_ITERATION_TERMINAL_STATUSES)[number];

/** Whether an iteration status means the iteration has finished. */
export function isEvalIterationTerminalStatus(
  status: unknown
): status is EvalIterationTerminalStatus {
  return (EVAL_ITERATION_TERMINAL_STATUSES as readonly unknown[]).includes(
    status
  );
}
