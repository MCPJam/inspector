import { cn } from "@/lib/utils";
import {
  chipKey,
  criterionChipValue,
  type CriterionVerdict,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { CriterionFacet } from "@/hooks/useUsageInsights";
import {
  PREDICATE_KIND_LABELS,
  formatCriterion,
  type PredicateKind,
} from "@/shared/predicate-kinds";

/** Keep the scorecard headline and compact statline on one calculation. */
export function summarizeCriterionFacets(facets: readonly CriterionFacet[]) {
  const totalPass = facets.reduce((sum, facet) => sum + facet.passCount, 0);
  const totalFail = facets.reduce((sum, facet) => sum + facet.failCount, 0);
  const totalGraded = totalPass + totalFail;
  const cleanCount = facets.filter(
    (facet) =>
      facet.passCount + facet.failCount > 0 && facet.failCount === 0,
  ).length;
  return {
    totalPass,
    totalFail,
    totalGraded,
    cleanCount,
    scorePct:
      totalGraded === 0 ? null : Math.round((totalPass / totalGraded) * 100),
  };
}

/**
 * Aggregate rubric scorecard for Insights — tallied across every graded
 * session in the scanned window, with a headline score on top. Mounted as a
 * subsection inside Findings in {@link InsightsWorkbench}; that parent owns
 * the card chrome, so this block has none of its own.
 *
 * Each criterion is its own boolean dimension, so each row is its own filter:
 * clicking two DIFFERENT criteria's fail counts narrows to the sessions that
 * failed both, which is the read worth having. Two verdicts on the SAME
 * criterion widen (a session cannot be both) — the grouping rule in
 * `chipGroupKey` handles that, and these are ordinary filter chips, so they
 * narrow the sankey and the drilldown like any other.
 *
 * Fail is the primary affordance. The reason people open this view is to find
 * what broke, and a row that led with the pass count would bury it.
 */
export function CriterionScorecard({
  facets,
  filter,
  onToggleChip,
}: {
  facets: CriterionFacet[] | undefined;
  filter: UsageFilterState;
  onToggleChip: (chip: UsageFilterChip) => void;
}) {
  // No rubric anywhere in the scanned window. Rendering an empty section here
  // would advertise a feature the project has not configured; silence is the
  // honest state.
  if (!facets || facets.length === 0) return null;

  const activeKeys = new Set(filter.chips.map(chipKey));
  const chipFor = (
    criterionId: string,
    verdict: CriterionVerdict,
    label: string,
  ): UsageFilterChip => ({
    kind: "dimension",
    key: "criterion",
    value: criterionChipValue(criterionId, verdict),
    label,
  });

  // The headline is verdict-weighted, not criterion-weighted: 100 sessions
  // failing one check should read worse than 2 sessions failing another.
  const { totalFail, totalGraded, cleanCount, scorePct } =
    summarizeCriterionFacets(facets);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2.5 pb-2">
        <h3 className="text-sm font-semibold tracking-tight">Scorecard</h3>
        <span className="text-xs text-muted-foreground">
          Pass rates across graded sessions
        </span>
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
          <span className="font-mono text-xs font-semibold uppercase tracking-wider">
            {scorePct === null ? "Score —" : `Score ${scorePct}%`}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Across runs
          </span>
        </div>
        <div className="divide-y divide-border/50">
          {facets.map((facet) => {
            const name = criterionDisplayName(facet);
            // The DENOMINATOR is only the sessions whose run carried this
            // criterion — sessions from rubric-less runs are excluded upstream,
            // so this rate never depends on how many ungraded sessions happened
            // to be in the scan window.
            const graded = facet.passCount + facet.failCount;
            const failChip = chipFor(
              facet.criterionId,
              "fail",
              `${name}: failed`,
            );
            const passChip = chipFor(
              facet.criterionId,
              "pass",
              `${name}: passed`,
            );
            const ungradedChip = chipFor(
              facet.criterionId,
              "ungraded",
              `${name}: not graded`,
            );
            const failActive = activeKeys.has(chipKey(failChip));
            const passActive = activeKeys.has(chipKey(passChip));
            const ungradedActive = activeKeys.has(chipKey(ungradedChip));

            return (
              <div
                key={facet.criterionId}
                className="flex items-center gap-3 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => onToggleChip(failChip)}
                  disabled={facet.failCount === 0}
                  aria-pressed={failActive}
                  // The criterion name lives in a sibling element, so without
                  // this two rows with the same count present identical
                  // accessible names ("6 failed").
                  aria-label={`${name}: ${facet.failCount} failed`}
                  className={cn(
                    "flex h-6 min-w-7 shrink-0 items-center justify-center rounded border px-1 font-mono text-xs font-semibold tabular-nums transition-colors",
                    "disabled:cursor-default",
                    facet.failCount > 0
                      ? failActive
                        ? "border-destructive bg-destructive/20 text-destructive"
                        : "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
                      : "border-border/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {facet.failCount}
                </button>
                <span
                  className="min-w-0 flex-1 truncate text-xs font-medium"
                  title={name}
                >
                  {name}
                </span>
                <div className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">
                    {graded === 0
                      ? "No completed grades yet"
                      : `${facet.failCount}/${graded} sessions failed`}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleChip(passChip)}
                    disabled={facet.passCount === 0}
                    aria-pressed={passActive}
                    aria-label={`${name}: ${facet.passCount} passed`}
                    className={cn(
                      "rounded px-1 tabular-nums underline-offset-2 transition-colors hover:underline",
                      "disabled:cursor-default disabled:no-underline disabled:opacity-50",
                      passActive && "bg-muted font-medium text-foreground",
                    )}
                  >
                    {facet.passCount} passed
                  </button>
                  {/* Ungraded is reported separately, never folded into the
                      fail count — a crashed runner is not a product regression
                      — and it is CLICKABLE, because "which sessions never got
                      graded?" is exactly the question this number provokes. */}
                  {facet.ungradedCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => onToggleChip(ungradedChip)}
                      aria-pressed={ungradedActive}
                      aria-label={`${name}: ${facet.ungradedCount} not graded`}
                      className={cn(
                        "rounded px-1 underline-offset-2 transition-colors hover:underline",
                        ungradedActive && "bg-muted font-medium text-foreground",
                      )}
                    >
                      {facet.ungradedCount} not graded
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="border-t bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          {totalGraded === 0
            ? "No completed grades yet"
            : /* Two different denominators, so they need two different nouns.
                 The first is per-CHECK (how many checks have a clean sheet);
                 the second is per-VERDICT — `totalGraded` sums pass+fail
                 across every check on every session, so with 3 checks over 10
                 sessions it is 30, not 10. Calling that "sessions" would
                 overstate the sample by the rubric's size. */
              `${cleanCount} / ${facets.length} checks passing · ${totalFail}/${totalGraded} graded checks failed`}
        </div>
      </div>
    </div>
  );
}

/**
 * What to call a check on screen.
 *
 * The author's `label` wins. Failing that, the predicate KIND's label — the
 * facet row carries no predicate arguments, so this is as specific as the
 * server-side data allows. Failing even that, the raw id: ugly, but it names
 * a real row, which beats inventing a friendlier name for a check no run in
 * the window defines.
 *
 * The label rules themselves are delegated to `formatCriterion` so they stay
 * defined once and cannot drift between the authoring form, the run
 * scorecard, and this table. Only the unknown-kind escape hatch is local:
 * `formatCriterion` has no id to fall back to.
 */
function criterionDisplayName(facet: CriterionFacet): string {
  if (facet.kind && facet.kind in PREDICATE_KIND_LABELS) {
    return formatCriterion({ ...facet, kind: facet.kind as PredicateKind });
  }
  return facet.label?.trim() || facet.criterionId;
}
