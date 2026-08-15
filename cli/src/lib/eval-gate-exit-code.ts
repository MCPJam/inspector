import type { GateReport } from "@mcpjam/sdk";

/**
 * Exit code for `mcpjam eval gate`.
 *
 * Copies the `conformance-exit-code.ts` idiom, and for the same reason: "the
 * evals regressed" and "we never established anything" are different failures
 * with different fixes, and a run that could not be graded must never look like
 * a pass. `2` is taken by usage errors, so the third state is `3`.
 *
 *   0 — every requested gate passed.
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

/** Terminal run statuses that make a gate undecidable rather than failed. */
const NON_VERDICT_STATUSES = new Set(["cancelled", "timed_out"]);

/**
 * Whether a hosted run's status means "no verdict was established", as opposed
 * to "the verdict was a failure". A cancelled run has not told us the server
 * regressed; it has told us nothing.
 */
export function isNonVerdictRunStatus(status: string | undefined): boolean {
  return status !== undefined && NON_VERDICT_STATUSES.has(status);
}

/** Exit code for a run that never produced a verdict at all. */
export const EVAL_GATE_INCOMPLETE_EXIT_CODE = 3;
/** Exit code for a usage error (bad flags, unknown scorer). */
export const EVAL_GATE_USAGE_EXIT_CODE = 2;
