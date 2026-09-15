/**
 * One recorded iteration, projected to the row a reader can act on.
 *
 * Lives here rather than in `shared/actionable-insights/` because it reads
 * `EvalIteration` and the run's client identity, which are Evaluate's types;
 * the shared list component takes the projected rows and knows none of that.
 */
import type { EvalIteration } from "../evals/types";
import { computeIterationResult } from "../evals/pass-criteria";
import type { AffectedIterationRow } from "@/components/shared/actionable-insights/affected-iterations-list";

export function affectedRowFor(
  iteration: EvalIteration,
  clientLabel?: string | null,
): AffectedIterationRow {
  return {
    iterationId: iteration._id,
    caseTitle: iteration.testCaseSnapshot?.title ?? "Untitled case",
    iterationNumber: iteration.iterationNumber ?? null,
    client: clientLabel ?? null,
    model: iteration.testCaseSnapshot?.model ?? null,
    result: computeIterationResult(iteration),
    canOpen: Boolean(iteration.testCaseId),
  };
}

/**
 * The lookup the findings block hands down, keyed by iteration id.
 *
 * An id the page has not loaded is NOT dropped by the consumer — it renders
 * as an unloaded row, so a finding's own count and its list agree.
 */
export function affectedRowsById(
  iterations: readonly EvalIteration[],
  clientLabel?: string | null,
): Record<string, AffectedIterationRow> {
  const rows: Record<string, AffectedIterationRow> = {};
  for (const iteration of iterations) {
    rows[iteration._id] = affectedRowFor(iteration, clientLabel);
  }
  return rows;
}

/** Non-passing first, then by recorded iteration number. Stable for equal rows. */
export function sortAffectedRows(
  rows: readonly AffectedIterationRow[],
): AffectedIterationRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.result === "passed") - Number(b.result === "passed") ||
      (a.iterationNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.iterationNumber ?? Number.MAX_SAFE_INTEGER),
  );
}
