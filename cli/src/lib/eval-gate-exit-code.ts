import type { GateReport } from "@mcpjam/sdk";

/**
 * Exit code for `mcpjam cloud eval gate`.
 *
 * Copies the `conformance-exit-code.ts` idiom, and for the same reason: "the
 * evals regressed" and "we never established anything" are different failures
 * with different fixes, and a run that could not be graded must never look like
 * a pass. `2` is taken by usage errors, so the third state is `3`.
 *
 *   0 — every requested gate passed, OR a failing gate was waived: an
 *       authorized user overrode it on the record, and the waiver is named in
 *       every artifact this command writes.
 *   1 — an EVAL VERDICT failed. Reserved for exactly that.
 *   2 — usage error: the policy names an unknown or positionally-generated
 *       scorer, or a threshold is out of range.
 *   3 — incomplete / infrastructure: the run was cancelled, the wait timed out,
 *       the network failed, or the run is NON-GATEABLE (its score evidence did
 *       not verify, or no integrity verdict exists at all).
 *
 * The one rule that matters more than the others: no infrastructure condition
 * may ever map to `1`. A CI job that fails a release because a network call
 * flaked, and reports it as "the server regressed", trains people to ignore the
 * gate.
 */
export function evalGateExitCode(report: GateReport): number {
  switch (report.outcome) {
    case "passed":
      return 0;
    // An authorized, recorded, time-boxed override of a real failure. Exit 0,
    // because unblocking the release is what a waiver is FOR — but it reaches
    // 0 by its own named outcome rather than by being turned into `passed`
    // upstream, so nothing downstream has to reconstruct which of the two
    // happened. The report, and every artifact built from it, still says the
    // gate failed and was waived.
    case "waived":
      return 0;
    case "failed":
      return 1;
    case "usage_error":
      return 2;
    case "incomplete":
      return 3;
    default:
      // Unreachable for a well-typed report; reached only if an older SDK
      // hands back an outcome this CLI does not know. Fails closed rather
      // than open — an unrecognized verdict is not a pass.
      return 3;
  }
}

/**
 * Statuses at which a run has stopped changing.
 *
 * Colocated with {@link NON_VERDICT_STATUSES} on purpose: they are one
 * vocabulary, and splitting them across files is how a newly-added terminal
 * status ends up in one set and not the other — making `--wait` poll a finished
 * run until the deadline and then report a wait timeout.
 */
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Terminal run statuses that make a gate undecidable rather than failed.
 *
 * `"failed"` belongs here because it is an EXECUTION state, not a verdict:
 * the platform vocabulary separates `status` ("completed" | "failed" |
 * "cancelled") from `result` ("passed" | "failed"), and a run whose runner
 * crashed mid-flight still carries the summary of the iterations it managed
 * to record. Gating that partial summary is fail-OPEN — a run that dies after
 * 3 passing iterations of 30 reads as a 100% pass rate and exits 0. Only
 * `status: "completed"` has a summary that describes the whole run.
 */
const NON_VERDICT_STATUSES = new Set(["cancelled", "timed_out", "failed"]);

/**
 * Whether a hosted run's status means "no verdict was established", as opposed
 * to "the verdict was a failure". A cancelled run has not told us the server
 * regressed; it has told us nothing.
 */
export function isNonVerdictRunStatus(status: string | undefined): boolean {
  return status !== undefined && NON_VERDICT_STATUSES.has(status);
}

/**
 * Whether the platform itself declined to decide this run.
 *
 * Verdict policy 2 adds a third `result`, `inconclusive`: the run finished,
 * but not enough of it was gradeable to make a claim about the server. Its
 * `summary` counts are precisely the evidence the platform judged
 * insufficient, so gating them is fail-either-way — a run that graded 3 of 30
 * trials reads as a 100% pass rate, and one that graded none reads as a
 * regression. Neither is a verdict, so this maps to `incomplete` (exit 3)
 * alongside cancelled and timed-out runs, and NEVER to the verdict code 1.
 */
export function isNonVerdictRunResult(
  result: string | null | undefined,
): boolean {
  return result === "inconclusive";
}

/** Exit code for a run that never produced a verdict at all. */
export const EVAL_GATE_INCOMPLETE_EXIT_CODE = 3;
/** Exit code for a usage error (bad flags, unknown scorer). */
export const EVAL_GATE_USAGE_EXIT_CODE = 2;
