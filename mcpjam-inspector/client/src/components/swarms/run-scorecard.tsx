import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import {
  SWARM_QUERIES,
  type GoalScoreRollup,
  type RunScorecard,
  type RunScorecardCriterion,
} from "@/lib/swarm-api";
import {
  PREDICATE_KIND_LABELS,
  formatCriterion,
  type PredicateKind,
} from "@/shared/predicate-kinds";

/**
 * Deterministic rubric scorecard for one run, with the advisory
 * goal-completion judge as the final row.
 *
 * The judge is rendered LAST and visually separated on purpose. It answers a
 * different question with different evidence — an LLM's opinion of whether the
 * goal was met, versus a rule that either held or did not — and a table that
 * interleaved them would invite reading a 0.6 judge score and a failed
 * criterion as the same kind of fact.
 *
 * Four count columns, kept distinct. Folding `pending` (a runner still
 * working, or one that died) or `grading failed` into the fail column would
 * make an infrastructure hiccup read as a product regression.
 */
export function RunScorecardSection({
  runId,
  goalScoreSummary,
}: {
  runId: string;
  goalScoreSummary?: GoalScoreRollup;
}) {
  const scorecard = useQuery(
    SWARM_QUERIES.getRunScorecard as never,
    { runId } as never,
  ) as RunScorecard | null | undefined;

  const hasJudge =
    goalScoreSummary !== undefined &&
    (goalScoreSummary.gradedCount > 0 ||
      (goalScoreSummary.pendingCount ?? 0) > 0 ||
      (goalScoreSummary.failedCount ?? 0) > 0);
  const criteria = scorecard?.criteria ?? [];

  // Nothing graded this run either way. A "Pass criteria" heading over an
  // empty table would advertise a feature the journey never opted into.
  if (criteria.length === 0 && !hasJudge) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium">Scorecard</h3>
        {scorecard ? (
          <span className="text-[11px] text-muted-foreground">
            {scorecard.sessionsGraded}/{scorecard.sessionsTotal} sessions graded
          </span>
        ) : null}
      </div>

      {criteria.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Criterion</th>
                <th className="py-1 px-2 text-right font-medium">Passed</th>
                <th className="py-1 px-2 text-right font-medium">Failed</th>
                <th className="py-1 px-2 text-right font-medium">Pending</th>
                <th
                  className="py-1 pl-2 text-right font-medium"
                  title="Grading itself broke — not the same as failing the criterion"
                >
                  Not graded
                </th>
              </tr>
            </thead>
            <tbody>
              {criteria.map((row) => (
                <tr key={row.criterionId} className="border-t border-border/30">
                  <td
                    className="max-w-[16rem] truncate py-1 pr-2"
                    title={criterionRowName(row)}
                  >
                    {criterionRowName(row)}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {row.passCount}
                  </td>
                  <td
                    className={cn(
                      "py-1 px-2 text-right tabular-nums",
                      row.failCount > 0 && "font-semibold text-destructive",
                    )}
                  >
                    {row.failCount}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums text-muted-foreground">
                    {row.pendingCount}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums text-muted-foreground">
                    {row.failedGradingCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {hasJudge ? (
        <div
          className={cn(
            "flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground",
            criteria.length > 0 && "mt-2 border-t border-border/30 pt-2",
          )}
        >
          <span className="font-medium text-foreground/80">
            Goal completion (LLM judge)
          </span>
          <span className="tabular-nums">
            {goalScoreSummary!.passedCount}/{goalScoreSummary!.gradedCount}{" "}
            passed
          </span>
          {goalScoreSummary!.avgScore !== null ? (
            <span className="tabular-nums">
              avg {goalScoreSummary!.avgScore.toFixed(2)}
            </span>
          ) : null}
          {(goalScoreSummary!.pendingCount ?? 0) > 0 ? (
            <span className="tabular-nums">
              {goalScoreSummary!.pendingCount} pending
            </span>
          ) : null}
          {(goalScoreSummary!.failedCount ?? 0) > 0 ? (
            <span className="tabular-nums">
              {goalScoreSummary!.failedCount} not graded
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The author's `label`, else the predicate kind's label, else the raw id.
 *
 * The raw-id fallback is deliberate: a row whose id no longer appears in the
 * run snapshot is a real row with real counts, and inventing a friendly name
 * for it would be a guess.
 */
function criterionRowName(row: RunScorecardCriterion): string {
  // Delegate to the shared helper so the label rules (blank-label handling,
  // predicate-kind fallback) stay defined once and cannot drift between the
  // authoring form and this table. Only the unknown-kind escape hatch is
  // local: `formatCriterion` has no id to fall back to.
  if (row.kind in PREDICATE_KIND_LABELS) {
    return formatCriterion({ ...row, kind: row.kind as PredicateKind });
  }
  return row.label?.trim() || row.criterionId;
}
