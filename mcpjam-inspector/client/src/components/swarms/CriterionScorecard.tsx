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
  type PredicateKind,
} from "@/shared/predicate-kinds";

/**
 * Aggregate rubric scorecard for the swarm Insights view — tallied across
 * every graded session in the scanned window.
 *
 * Paired with "Where sessions struggled" in the Insights rail: same card
 * chrome and header shape. Leads with "N/M clean" (not a % billboard) so
 * rubric checks cannot read as an overall run grade next to open patterns.
 *
 * Each criterion is its own boolean dimension, so each row is its own filter:
 * clicking two DIFFERENT criteria's fail counts narrows to the sessions that
 * failed both. Fail is the primary affordance.
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

  const totalPass = facets.reduce((sum, f) => sum + f.passCount, 0);
  const totalFail = facets.reduce((sum, f) => sum + f.failCount, 0);
  const totalGraded = totalPass + totalFail;
  const cleanCount = facets.filter(
    (f) => f.passCount + f.failCount > 0 && f.failCount === 0,
  ).length;
  const allClean = totalGraded > 0 && totalFail === 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col rounded-lg border border-border/60 bg-muted/20"
      data-testid="criterion-scorecard"
    >
      <div className="flex items-baseline justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium">Rubric checks</h3>
          <p className="truncate text-[11px] text-muted-foreground">
            Pass/fail rules you configured
          </p>
        </div>
        {totalGraded > 0 ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
            data-testid="criterion-scorecard-clean"
          >
            {cleanCount}/{facets.length} clean
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto">
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
              className="flex items-center gap-3 px-3 py-1.5"
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
                    : "border-border/50 bg-muted text-muted-foreground",
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
                {graded === 0 ? (
                  <span className="tabular-nums">No completed grades yet</span>
                ) : facet.failCount > 0 ? (
                  <span className="tabular-nums">
                    {facet.failCount}/{graded} failed
                  </span>
                ) : null}
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

      <div className="border-t border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        {totalGraded === 0 ? (
          "No completed grades yet"
        ) : allClean ? (
          <span data-testid="criterion-scorecard-bridge">
            Checks passed — separate from struggle patterns on the left
          </span>
        ) : (
          `${totalFail}/${totalGraded} graded checks failed`
        )}
      </div>
    </div>
  );
}

/**
 * What to call a criterion on screen.
 *
 * The author's `label` wins. Failing that, the predicate KIND's label — the
 * facet row carries no predicate arguments, so this is as specific as the
 * server-side data allows. Failing even that, the raw id: ugly, but it names
 * a real row, which beats inventing a friendlier name for a criterion no run
 * in the window defines.
 */
function criterionDisplayName(facet: CriterionFacet): string {
  const label = facet.label?.trim();
  if (label) return label;
  if (facet.kind && facet.kind in PREDICATE_KIND_LABELS) {
    return PREDICATE_KIND_LABELS[facet.kind as PredicateKind];
  }
  return facet.criterionId;
}
