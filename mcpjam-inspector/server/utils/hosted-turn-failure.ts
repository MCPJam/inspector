import type { PersistedTurnTrace } from "./chat-ingestion.js";
import {
  didTurnFail,
  terminationOf,
  type TurnOutcomeRecord,
} from "@/shared/turn-outcome";

/**
 * Did this hosted turn fail? Shared by evals and synthetic sessions.
 *
 * THE RECORD FIRST, TRACE ABSENCE ONLY AS A FALLBACK. This used to key
 * primarily on the ABSENCE of a turn trace, which worked only because a turn
 * that ended badly was excluded from persistence and therefore produced no
 * trace. That inference is now wrong in both directions:
 *
 *  - a failed or timed-out turn will be RECORDED, trace and all, so absence no
 *    longer marks it;
 *  - a cancelled turn also produces a trace, and a cancellation is not a
 *    failure — somebody asked for it.
 *
 * So the lifecycle decides when a record exists, and the old heuristics apply
 * only to callers that do not have one (a mocked engine, a historical row).
 * Getting this order wrong is what would make a setup failure with zero error
 * spans read as a success.
 *
 * A `null` return means "no failure DETECTED here" — never "this turn
 * succeeded". The caller's own gates decide the rest.
 */
export function getHostedTurnFailure(args: {
  /** How the turn ended, when the engine reported it. */
  outcome?: TurnOutcomeRecord | undefined;
  turnTrace: Pick<PersistedTurnTrace, "spans"> | undefined;
  newMessageCount: number;
}): string | null {
  if (args.outcome) {
    if (didTurnFail(args.outcome)) {
      return describeRecordedFailure(args.outcome);
    }
    // A CANCELLED turn is not a failure and must not be reported as one: the
    // eval and swarm callers have their own cancellation policy, and routing a
    // stop through the failure path would record a verdict for a run the user
    // ended.
    if (args.outcome.lifecycle === "cancelled") return null;
    // `paused` is a turn waiting to be resumed; `completed` speaks for itself.
    // Both still go through the content checks below, because a turn can
    // complete and produce nothing — which the engine reports as a failure of
    // its own now, but historical and mocked callers still need the check.
  }

  if (!args.outcome && !args.turnTrace) {
    // Kept for callers with NO record: a hosted turn that produced no trace
    // caught something mid-flight.
    //
    // Guarded on the record's absence, not merely dead beside it. A turn can
    // be recorded and still write no trace — a `paused` one persists through
    // the resume path, and a terminal one writes nothing at all while
    // `TERMINAL_TURN_RECORDING_ENABLED` is off. Reading either absence as an
    // engine failure would invent one out of a switch position, which is the
    // same trace-absence inference this function exists to stop making.
    return "Backend stream failed during iteration (engine caught an error mid-turn)";
  }
  if (args.newMessageCount === 0) {
    return "Backend step returned no content (stream error or empty response)";
  }
  // No trace to walk, and the record did not call it a failure: nothing
  // detected here.
  if (!args.turnTrace) return null;
  // Tool failures belong to the caller's tool-error policy. Child error spans
  // carrying a toolCallId are tool evidence too, even with another category.
  const failedStep = args.turnTrace.spans.find(
    (span) =>
      span.status === "error" && span.category !== "tool" && !span.toolCallId,
  );
  return failedStep ? `Backend step failed mid-turn: ${failedStep.name}` : null;
}

/** One sentence naming what the record says went wrong. */
function describeRecordedFailure(outcome: TurnOutcomeRecord): string {
  if (outcome.lifecycle === "timed_out") {
    // No fallback: the union narrows a `timed_out` record to the variant whose
    // `termination.timeout` is REQUIRED, so "Turn timed out" was unreachable.
    const { timeout } = outcome.termination;
    return `Turn exceeded its ${timeout.clock} budget of ${timeout.budgetMs}ms (elapsed ${timeout.elapsedMs}ms)`;
  }
  // Not narrowed to one lifecycle here — `failed`, `interrupted` and a
  // sidecar-failed `paused` all reach this line — so read the projection
  // rather than a leg the union only promises on some variants.
  const termination = terminationOf(outcome);
  const source = termination?.errorSource;
  const code = termination?.errorCode;
  const where =
    source === "setup"
      ? "Turn failed before the model was invoked"
      : "Backend stream failed during iteration";
  return code ? `${where} (${code})` : where;
}
