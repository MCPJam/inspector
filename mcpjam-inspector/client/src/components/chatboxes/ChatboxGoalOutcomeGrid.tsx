import { useMemo, useState } from "react";
import { AlertTriangle, ArrowUpDown, Info, Target } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  SESSION_OUTCOMES,
  isCellSelected,
  type SessionOutcome,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { GoalFacet, UsageBreakdown } from "@/hooks/useUsageInsights";
import { cn } from "@/lib/utils";

/**
 * Rows past this are folded into an "Other" row. It is a table, not a chart, so
 * the cap exists to keep the panel scannable rather than to fit labels — and
 * "Other" is a real row with real counts, never a silent drop.
 */
const MAX_GOAL_ROWS = 12;

type SortKey = "volume" | "unresolved";

interface ChatboxGoalOutcomeGridProps {
  breakdown: UsageBreakdown | null | undefined;
  filter: UsageFilterState;
  /**
   * Atomic cell selection. Must NOT be two toggleChip calls — chips OR within a
   * dimension, so toggling would widen the selection instead of narrowing it.
   */
  onSelectCell: (cell: {
    clusterId: string;
    clusterLabel?: string;
    outcome: SessionOutcome | null;
  }) => void;
}

/** Column labels. Short because they head a numeric grid. */
const OUTCOME_LABELS: Record<SessionOutcome, string> = {
  completed: "Completed",
  partial: "Partial",
  unresolved: "Unresolved",
  errored: "Errored",
  unclear: "Unclear",
};

/**
 * Tint for a cell, scaled by that cell's share of its row. Only the outcomes
 * that indicate a problem are tinted warm; `completed` reads positive and
 * `unclear` stays neutral, because tinting an absence of judgement as a problem
 * is exactly the overclaim this grid exists to avoid.
 */
function cellTint(outcome: SessionOutcome, share: number): string {
  if (share <= 0) return "";
  const bucket = share >= 0.6 ? "strong" : share >= 0.3 ? "medium" : "weak";
  // Tinted surfaces take `text-<color>`, not `text-<color>-foreground`: the
  // foreground tokens pair with SOLID fills (success/destructive foreground is
  // white in both themes — see design-system tokens.css), so on a /25 tint over
  // a light page they render white-on-near-white. `warning` is the deliberate
  // exception: its foreground token IS theme-aware (dark in light mode), while
  // bare `text-warning` is a yellow that fails contrast on a light page.
  if (outcome === "completed") {
    return {
      strong: "bg-success/25 text-success",
      medium: "bg-success/15",
      weak: "bg-success/8",
    }[bucket];
  }
  if (outcome === "unresolved" || outcome === "errored") {
    return {
      strong: "bg-destructive/25 text-destructive",
      medium: "bg-destructive/15",
      weak: "bg-destructive/8",
    }[bucket];
  }
  if (outcome === "partial") {
    return {
      strong: "bg-warning/25 text-warning-foreground",
      medium: "bg-warning/15",
      weak: "bg-warning/8",
    }[bucket];
  }
  return "bg-muted/40";
}

function formatRate(rate: number | null): string {
  // Null means the denominator was zero. That is "unknown", not 0%, and
  // rendering it as 0% would be a claim we cannot support.
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function formatEntropy(entropy: number | null): string {
  if (entropy === null) return "—";
  return entropy.toFixed(2);
}

/**
 * Fold rows past the cap into a single "Other" row. Rates are recomputed from
 * the summed counts rather than averaged, so the row's numbers stay internally
 * consistent.
 *
 * Two route metrics are deliberately NOT aggregated and render as "—":
 * entropy, because entropy over a union of unrelated goals is not a meaningful
 * number; and the distinct-route count, because summing per-goal distinct
 * counts double-counts any path two folded goals share, which would overstate
 * it. Only the per-goal `pathDistribution` could union them correctly, and the
 * grid does not need that number badly enough to carry it.
 */
function foldOtherRow(rows: GoalFacet[]): GoalFacet | null {
  if (rows.length === 0) return null;
  const outcomes = {
    completed: 0,
    partial: 0,
    unresolved: 0,
    errored: 0,
    unclear: 0,
  };
  let total = 0;
  let unlabeled = 0;
  let retried = 0;
  for (const row of rows) {
    total += row.total;
    unlabeled += row.unlabeled;
    retried += row.retryRate * row.total;
    for (const outcome of SESSION_OUTCOMES) {
      outcomes[outcome] += row.outcomes[outcome];
    }
  }
  const labeled = SESSION_OUTCOMES.reduce(
    (sum, outcome) => sum + outcomes[outcome],
    0
  );
  const unresolvedTotal =
    outcomes.unresolved + outcomes.errored + outcomes.partial;
  return {
    clusterId: "__other__",
    label: `Other (${rows.length} goals)`,
    total,
    outcomes,
    unlabeled,
    unresolvedRate: labeled > 0 ? unresolvedTotal / labeled : null,
    errorRate: labeled > 0 ? outcomes.errored / labeled : null,
    retryRate: total > 0 ? retried / total : 0,
    toolDistribution: [],
    pathDistribution: [],
    // Not summed — see the note above. -1 marks "not aggregated" so the cell
    // renders "—" rather than a wrong number or a misleading 0.
    distinctPathCount: -1,
    routingEntropy: null,
  };
}

export function ChatboxGoalOutcomeGrid({
  breakdown,
  filter,
  onSelectCell,
}: ChatboxGoalOutcomeGridProps) {
  const [sortKey, setSortKey] = useState<SortKey>("volume");

  const facets = breakdown?.goalFacets ?? [];

  const { rows, otherRow } = useMemo(() => {
    const sorted = [...facets].sort((a, b) => {
      if (sortKey === "volume") return b.total - a.total;
      // Sorting by unresolved rate puts nulls last: a row with no labeled
      // sessions has no rate, and floating it to the top would rank an unknown
      // above a measured 90%.
      const left = a.unresolvedRate;
      const right = b.unresolvedRate;
      if (left === null && right === null) return b.total - a.total;
      if (left === null) return 1;
      if (right === null) return -1;
      if (right !== left) return right - left;
      return b.total - a.total;
    });
    return {
      rows: sorted.slice(0, MAX_GOAL_ROWS),
      otherRow: foldOtherRow(sorted.slice(MAX_GOAL_ROWS)),
    };
  }, [facets, sortKey]);

  const scan = breakdown?.scan;
  const signalsVersion = breakdown?.latestRun?.signalsVersion ?? null;

  if (!breakdown) {
    return (
      <div className="flex items-center justify-center px-5 py-10 text-xs text-muted-foreground">
        Loading goal outcomes…
      </div>
    );
  }

  if (facets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <Target className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No goal clusters yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {signalsVersion === null
            ? "The last rebuild ran before goal outcomes existed. Rebuild clusters to extract goals, outcomes, and tool routes."
            : "Rebuild clusters once this chatbox has enough sessions to cluster."}
        </p>
      </div>
    );
  }

  const allRows = otherRow ? [...rows, otherRow] : rows;

  return (
    <div className="flex flex-col gap-2 border-b px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Goals by outcome</h3>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About goal outcomes"
                className="text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              Rows are goal clusters. Outcome is inferred per session and capped
              at &ldquo;unclear&rdquo; for sessions that are still recent, since
              we have no signal that a session ended. Routes counts distinct
              tool paths taken to reach the same goal &mdash; high spread points
              at a missing capability or ambiguous tool descriptions.
            </TooltipContent>
          </Tooltip>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50"
          onClick={() =>
            setSortKey((prev) => (prev === "volume" ? "unresolved" : "volume"))
          }
        >
          <ArrowUpDown className="h-3 w-3" />
          {sortKey === "volume" ? "Sort by unresolved" : "Sort by volume"}
        </button>
      </div>

      {scan?.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Rates below cover the most recent {scan.matched.toLocaleString()}{" "}
            matching sessions, not the full history &mdash; the scan stops at{" "}
            {scan.maxSessions.toLocaleString()}. Older sessions are not
            included.
          </span>
        </div>
      ) : null}

      {/* Wide table scrolls inside its own container so the panel never scrolls
          horizontally. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Goal
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Sessions
              </th>
              {SESSION_OUTCOMES.map((outcome) => (
                <th
                  key={outcome}
                  scope="col"
                  className="px-2 py-1.5 text-right font-medium"
                >
                  {OUTCOME_LABELS[outcome]}
                </th>
              ))}
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Not analyzed
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Unresolved
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Errors
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Retries
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Routes
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span className="cursor-help border-b border-dotted border-muted-foreground/60">
                      Spread
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    Shannon entropy over this goal&rsquo;s tool routes, in bits.
                    0 means every session took the same route; higher means the
                    model could not decide which tool serves this goal.
                  </TooltipContent>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {allRows.map((facet) => {
              const isOther = facet.clusterId === "__other__";
              return (
                <tr
                  key={facet.clusterId}
                  className="border-t border-border/60 text-xs"
                >
                  <th
                    scope="row"
                    className="max-w-[220px] py-1.5 pr-3 text-left font-medium"
                  >
                    {/* It's a table, so the label is not truncated. */}
                    <span className={cn(isOther && "text-muted-foreground")}>
                      {facet.label}
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {facet.total.toLocaleString()}
                  </td>
                  {SESSION_OUTCOMES.map((outcome) => {
                    const count = facet.outcomes[outcome];
                    const share = facet.total > 0 ? count / facet.total : 0;
                    const selected =
                      !isOther &&
                      isCellSelected(filter, {
                        clusterId: facet.clusterId,
                        outcome,
                      });
                    const label = `${facet.label}, ${OUTCOME_LABELS[outcome]}: ${count} sessions`;
                    return (
                      <td key={outcome} className="px-1 py-1">
                        {isOther ? (
                          <span className="block px-1 py-0.5 text-right tabular-nums text-muted-foreground">
                            {count.toLocaleString()}
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label={label}
                            aria-pressed={selected}
                            disabled={count === 0}
                            onClick={() =>
                              onSelectCell({
                                clusterId: facet.clusterId,
                                clusterLabel: facet.label,
                                outcome,
                              })
                            }
                            className={cn(
                              "w-full rounded px-1.5 py-0.5 text-right tabular-nums transition",
                              count === 0
                                ? "cursor-default text-muted-foreground/40"
                                : "hover:ring-1 hover:ring-primary/40",
                              cellTint(outcome, share),
                              selected && "ring-2 ring-primary"
                            )}
                          >
                            {count.toLocaleString()}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-1 py-1">
                    {isOther ? (
                      <span className="block px-1 py-0.5 text-right tabular-nums text-muted-foreground">
                        {facet.unlabeled.toLocaleString()}
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${facet.label}, not analyzed: ${facet.unlabeled} sessions`}
                        aria-pressed={isCellSelected(filter, {
                          clusterId: facet.clusterId,
                          outcome: null,
                        })}
                        disabled={facet.unlabeled === 0}
                        onClick={() =>
                          onSelectCell({
                            clusterId: facet.clusterId,
                            clusterLabel: facet.label,
                            outcome: null,
                          })
                        }
                        className={cn(
                          "w-full rounded px-1.5 py-0.5 text-right tabular-nums text-muted-foreground transition",
                          facet.unlabeled === 0
                            ? "cursor-default text-muted-foreground/40"
                            : "hover:ring-1 hover:ring-primary/40",
                          isCellSelected(filter, {
                            clusterId: facet.clusterId,
                            outcome: null,
                          }) && "ring-2 ring-primary"
                        )}
                      >
                        {facet.unlabeled.toLocaleString()}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatRate(facet.unresolvedRate)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatRate(facet.errorRate)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatRate(facet.retryRate)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {facet.distinctPathCount < 0
                      ? "—"
                      : facet.distinctPathCount.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatEntropy(facet.routingEntropy)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {breakdown.labeledOutcomeCount.toLocaleString()} of{" "}
        {breakdown.totalSessions.toLocaleString()} scanned sessions have an
        inferred outcome. Rates use the labeled subset as the denominator;
        &ldquo;—&rdquo; means no labeled sessions to divide by.
      </p>
    </div>
  );
}
