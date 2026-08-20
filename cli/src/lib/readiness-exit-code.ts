/**
 * What a readiness run means to a shell, and to CI.
 *
 * A conformance run answers "did this server violate the spec". A readiness
 * run answers "would a directory list this", and that question has a third
 * outcome the first does not: a lane can be `incomplete`, meaning nothing was
 * established. Collapsing that into a pass is the failure mode this whole
 * feature exists to prevent — a CI job that goes green because the run could
 * not reach the server has told its owner the opposite of the truth.
 *
 *   0  ready         every required lane evaluated and passed
 *   1  not-ready     something was evaluated and FAILED
 *   2  usage error   (the CLI-wide convention; not produced here)
 *   3  incomplete    something could not be evaluated
 *   4  execution     the run itself failed, was cancelled, or never finished
 *   5  observations  the grade is READY, but the AI observations the caller
 *                    asked for were refused
 *
 * WHY 5 EXISTS, AND WHY IT ONLY APPLIES OVER A PASS. Observations are
 * non-dispositive by construction — they can never make a server not-ready —
 * so a credit refusal must not turn a passing server into a failing one for a
 * BILLING reason. But a caller who asked for commentary and did not get it did
 * not get what it asked for, and a silent 0 hides that. So the grade decides
 * first, and 5 is reachable only when the grade is 0: a real violation or a
 * real gap always outranks a missing opinion.
 */

/** The lane rollup a run produced, however it was obtained. */
export type ReadinessOverallStatus = "ready" | "not-ready" | "incomplete";

export type ReadinessObservationStatus =
  | "not-requested"
  | "pending"
  | "completed"
  | "billing-blocked"
  | "provider-failed"
  | "invalid-output";

export const READINESS_EXIT_READY = 0;
export const READINESS_EXIT_NOT_READY = 1;
export const READINESS_EXIT_INCOMPLETE = 3;
export const READINESS_EXIT_EXECUTION_FAILED = 4;
export const READINESS_EXIT_OBSERVATIONS_UNAVAILABLE = 5;

export interface ReadinessExitInput {
  /** Absent when the run never produced a verdict at all. */
  overallStatus?: ReadinessOverallStatus | null;
  /** Hosted runs only. `failed`/`cancelled` mean no verdict was reached. */
  runStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** What the caller asked for, not what it got. */
  requestedObservations?: boolean;
  observationStatus?: ReadinessObservationStatus;
}

export function readinessExitCode(input: ReadinessExitInput): number {
  // A run that never finished has no verdict to report, and reporting one
  // would be inventing it. This is checked FIRST because a failed hosted run
  // can still carry stale lanes from a previous attempt.
  if (input.runStatus === "failed" || input.runStatus === "cancelled") {
    return READINESS_EXIT_EXECUTION_FAILED;
  }
  if (input.runStatus === "pending" || input.runStatus === "running") {
    return READINESS_EXIT_EXECUTION_FAILED;
  }
  if (!input.overallStatus) return READINESS_EXIT_EXECUTION_FAILED;

  if (input.overallStatus === "not-ready") return READINESS_EXIT_NOT_READY;
  if (input.overallStatus === "incomplete") return READINESS_EXIT_INCOMPLETE;

  // Ready. The only thing left that can lower it is an unfulfilled request
  // for commentary — see the header for why that cannot outrank a verdict.
  if (
    input.requestedObservations === true &&
    input.observationStatus !== undefined &&
    input.observationStatus !== "completed"
  ) {
    return READINESS_EXIT_OBSERVATIONS_UNAVAILABLE;
  }
  return READINESS_EXIT_READY;
}

/**
 * One line naming the exit code's reason, for a human at a terminal.
 *
 * stderr, like every other advisory line in this CLI, so a `--reporter json`
 * stdout stays parseable. Says WHICH lane or WHICH refusal, because "not
 * ready" with no subject is a status, not a next step.
 */
export function describeReadinessExit(
  code: number,
  detail?: string,
): string | undefined {
  switch (code) {
    case READINESS_EXIT_READY:
      return undefined;
    case READINESS_EXIT_NOT_READY:
      return `Not ready${detail ? `: ${detail}` : ""}`;
    case READINESS_EXIT_INCOMPLETE:
      return `Incomplete — some requirements could not be evaluated${
        detail ? `: ${detail}` : ""
      }. This is NOT a pass.`;
    case READINESS_EXIT_EXECUTION_FAILED:
      return `The readiness run did not finish${detail ? `: ${detail}` : ""}`;
    case READINESS_EXIT_OBSERVATIONS_UNAVAILABLE:
      return `Ready, but the AI observations you asked for were not produced${
        detail ? `: ${detail}` : ""
      }. The grade above is complete and unaffected.`;
    default:
      return undefined;
  }
}
