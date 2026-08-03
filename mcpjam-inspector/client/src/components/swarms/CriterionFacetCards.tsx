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
 * Per-criterion pass/fail cards for the swarm Insights view.
 *
 * Each criterion is its own boolean dimension, so each card is its own filter:
 * clicking two DIFFERENT criteria's fail counts narrows to the sessions that
 * failed both, which is the read worth having. Two verdicts on the SAME
 * criterion widen (a session cannot be both) — the grouping rule in
 * `chipGroupKey` handles that, and these are ordinary filter chips, so they
 * narrow the sankey and the drilldown like any other.
 *
 * Fail is the primary affordance. The reason people open this view is to find
 * what broke, and a card that led with the pass count would bury it.
 */
export function CriterionFacetCards({
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

  return (
    <div className="px-5 pb-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-xs font-medium">Pass criteria</h3>
        <span className="text-[11px] text-muted-foreground">
          Deterministic checks across graded sessions
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {facets.map((facet) => {
          const name = criterionDisplayName(facet);
          // The DENOMINATOR is only the sessions whose run carried this
          // criterion — sessions from rubric-less runs are excluded upstream,
          // so this rate never depends on how many ungraded sessions happened
          // to be in the scan window.
          const graded = facet.passCount + facet.failCount;
          const failChip = chipFor(facet.criterionId, "fail", `${name}: failed`);
          const passChip = chipFor(facet.criterionId, "pass", `${name}: passed`);
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
              className="rounded-lg border bg-card/40 p-3"
            >
              <div
                className="truncate text-xs font-medium"
                title={name}
              >
                {name}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onToggleChip(failChip)}
                  disabled={facet.failCount === 0}
                  aria-pressed={failActive}
                  // The criterion name lives in a sibling element, so without
                  // this two cards with the same count present identical
                  // accessible names ("6 failed").
                  aria-label={`${name}: ${facet.failCount} failed`}
                  className={cn(
                    "rounded-md border px-2 py-1 text-left transition-colors",
                    "disabled:cursor-default disabled:opacity-50",
                    failActive
                      ? "border-destructive bg-destructive/10"
                      : "hover:bg-muted/60",
                  )}
                >
                  <div className="text-sm font-semibold tabular-nums">
                    {facet.failCount}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    failed
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleChip(passChip)}
                  disabled={facet.passCount === 0}
                  aria-pressed={passActive}
                  aria-label={`${name}: ${facet.passCount} passed`}
                  className={cn(
                    "rounded-md border px-2 py-1 text-left transition-colors",
                    "disabled:cursor-default disabled:opacity-50",
                    passActive ? "border-primary bg-primary/10" : "hover:bg-muted/60",
                  )}
                >
                  <div className="text-sm font-medium tabular-nums text-muted-foreground">
                    {facet.passCount}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    passed
                  </div>
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
                <span>
                  {graded === 0
                    ? "No completed grades yet"
                    : `${facet.failCount}/${graded} sessions failed`}
                </span>
                {/* Ungraded is reported separately, never folded into the fail
                    count — a crashed runner is not a product regression — and
                    it is CLICKABLE, because "which sessions never got graded?"
                    is exactly the question this number provokes. */}
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
