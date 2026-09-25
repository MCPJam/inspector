/**
 * COMPILE-TIME cases for the record's invariants.
 *
 * The Zod refinements always caught these at parse time; the point of the
 * discriminated union is that a producer inside this repo is refused by the
 * COMPILER, before anything is written. Each `@ts-expect-error` below fails the
 * build if the construction it guards ever becomes legal again — which is what
 * makes this file a test rather than documentation.
 *
 * Runtime rejection of untrusted input is pinned separately, in
 * `turn-outcome.test.ts`; the two are not interchangeable.
 */
import type { TurnOutcomeRecord } from "../turn-outcome";

const runtime = { engine: "emulated", modelAccess: "hosted" } as const;
const base = { contractVersion: 1, runtime, recordedAt: 1 } as const;

// --- what the contract REQUIRES -------------------------------------------

// @ts-expect-error timed_out must name the clock that fired
const noClock: TurnOutcomeRecord = { ...base, lifecycle: "timed_out" };

const emptyTimedOutTermination: TurnOutcomeRecord = {
  ...base,
  lifecycle: "timed_out",
  // @ts-expect-error timed_out cannot carry a termination without its timeout
  termination: { errorCode: "x" },
};

// @ts-expect-error cancelled must name who stopped the turn
const noSource: TurnOutcomeRecord = { ...base, lifecycle: "cancelled" };

// @ts-expect-error paused must name the rail it is waiting on
const noPauseKind: TurnOutcomeRecord = { ...base, lifecycle: "paused" };

// --- what the contract FORBIDS --------------------------------------------

const completedWithTermination: TurnOutcomeRecord = {
  ...base,
  lifecycle: "completed",
  // @ts-expect-error completed cannot also have been ended by something
  termination: { errorSource: "model" },
};

const failedWithTimeout: TurnOutcomeRecord = {
  ...base,
  lifecycle: "failed",
  termination: {
    // @ts-expect-error a timeout on a failed turn claims two different endings
    timeout: { clock: "turn", budgetMs: 1, elapsedMs: 1 },
  },
};

const failedWithCancellationSource: TurnOutcomeRecord = {
  ...base,
  lifecycle: "failed",
  termination: {
    // @ts-expect-error a cancellationSource on a failed turn does the same
    cancellationSource: "caller",
  },
};

const completedWithPause: TurnOutcomeRecord = {
  ...base,
  lifecycle: "completed",
  // @ts-expect-error `paused` only belongs on a paused turn
  paused: { kind: "tool_approval" },
};

// --- and what it ALLOWS, so the union is not merely restrictive ------------

const completed: TurnOutcomeRecord = { ...base, lifecycle: "completed" };
const timedOut: TurnOutcomeRecord = {
  ...base,
  lifecycle: "timed_out",
  termination: { timeout: { clock: "turn", budgetMs: 1, elapsedMs: 1 } },
};
const cancelled: TurnOutcomeRecord = {
  ...base,
  lifecycle: "cancelled",
  termination: { cancellationSource: "caller" },
};
const paused: TurnOutcomeRecord = {
  ...base,
  lifecycle: "paused",
  paused: { kind: "scope_step_up" },
};
// `superseded` is diagnosis about the race, legal wherever a termination is.
const cancelledWithLateMark: TurnOutcomeRecord = {
  ...base,
  lifecycle: "cancelled",
  termination: {
    cancellationSource: "caller",
    superseded: [{ mark: "completed", at: 2 }],
  },
};

export type {};
void [
  noClock, emptyTimedOutTermination, noSource, noPauseKind,
  completedWithTermination, failedWithTimeout, failedWithCancellationSource,
  completedWithPause, completed, timedOut, cancelled, paused,
  cancelledWithLateMark,
];
