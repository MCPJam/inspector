/**
 * The one definition of "this run will never do more work".
 *
 * Three copies of this set had grown along the eval-run path, and the cost of a
 * fourth is not the duplication itself — it is that each copy is a place a new
 * terminal status can be added to three of four lists. A run status the
 * detached-execution guard treats as terminal while the replay guard does not
 * is a run that gets finalized twice, or executed twice.
 *
 * (`services/github-checks-worker.ts` keeps its own copy: it is a different
 * subsystem with its own status vocabulary, and folding it in here would
 * couple the two.)
 */
import { ITERATION_STATUSES } from "@mcpjam/sdk/contract";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  // The runner finalizes run/iteration timeouts as `timed_out` before
  // rethrowing into the detached catch. Terminal, so a defensive re-finalize
  // cannot overwrite a timeout result with `failed`.
  "timed_out",
]);

/** Whether a run status means the run has finished, however it finished. */
export function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * The same question for one ITERATION, derived from the canonical lifecycle
 * (`ITERATION_STATUSES` in `@mcpjam/sdk/contract`) by removing the two
 * non-terminal states rather than by re-listing the terminal ones: a status
 * added to the contract is then terminal here by default, which is the safe
 * direction — treating a finished iteration as still running stalls a poller,
 * while the reverse only shortens a duration.
 *
 * `setup_failed` and `skipped` are terminal exactly like `failed`: the harness
 * is done with the trial. They are NOT the same as `failed` anywhere a verdict
 * is derived — a setup failure says something about us and a skip says nothing
 * at all — but "will this iteration do more work" is answered `no` for all
 * three.
 */
export const TERMINAL_ITERATION_STATUSES: ReadonlySet<string> = new Set(
  ITERATION_STATUSES.filter(
    (status) => status !== "pending" && status !== "running",
  ),
);

/** Whether an iteration status means the iteration has finished. */
export function isTerminalIterationStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_ITERATION_STATUSES.has(status);
}
