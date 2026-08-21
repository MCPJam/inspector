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
