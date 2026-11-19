import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import {
  COMPLETENESS_LABEL,
  describeRowCost,
} from "@/components/evals/trace-cost/cost-view";
import { CostAmount } from "@/components/evals/trace-cost/trace-cost-display";
import { COMPARE_COST_SCOPE_LABEL, costWinnerLabel } from "./compare-cost";
import type { MultiModelCardSummary } from "./model-compare-card-header";

/**
 * The compare header's Cost row, under Tokens: the latest turn's amount on a
 * bar scaled to the costliest card, then its scope, the winner label, or what
 * the amount is missing. Renders nothing while `trace-cost` is off.
 */
export function CompareCostRow({
  summary,
  allSummaries,
}: {
  summary: MultiModelCardSummary | null;
  allSummaries: MultiModelCardSummary[];
}) {
  const enabled = useTraceCostEnabled();
  if (!enabled) return null;

  const view = summary?.cost
    ? describeRowCost({ kind: "rollup", rollup: summary.cost })
    : undefined;
  const isRunning = summary?.status === "running";
  const winnerLabel = costWinnerLabel(summary, allSummaries);
  const maxAmount = Math.max(
    0,
    ...allSummaries.map((item) =>
      item.cost && item.cost.completeness !== "unavailable"
        ? item.cost.knownSubtotalUsd
        : 0,
    ),
  );
  const barPct =
    view?.amountUsd !== undefined && maxAmount > 0
      ? Math.min(100, Math.max(4, (view.amountUsd / maxAmount) * 100))
      : 0;
  const notes = [
    COMPARE_COST_SCOPE_LABEL,
    view?.completeness === "partial" ? COMPLETENESS_LABEL.partial : undefined,
    view && view.completeness !== "complete" ? view.coverage : undefined,
  ].filter((note): note is string => Boolean(note));

  return (
    <div data-testid="compare-cost-row" className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="flex w-[52px] shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          <span>Cost</span>
          {isRunning ? (
            <Loader2
              data-testid="metric-running-spinner"
              className="h-3 w-3 shrink-0 animate-spin"
              aria-hidden
            />
          ) : null}
        </span>
        <div className="relative flex min-w-0 flex-1 items-center">
          <div className="h-[14px] w-full overflow-hidden rounded-sm bg-muted/40">
            {barPct > 0 ? (
              <div
                className={cn(
                  "h-full rounded-sm transition-all duration-300",
                  winnerLabel
                    ? "bg-emerald-500/25 dark:bg-emerald-400/20"
                    : "bg-accent",
                )}
                style={{ width: `${barPct}%` }}
              />
            ) : null}
          </div>
          <span
            title={view?.sourceLabel}
            className={cn(
              "absolute inset-0 flex items-center px-1.5 text-[10px] font-medium tabular-nums",
              winnerLabel
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-foreground",
            )}
          >
            {view?.amountUsd !== undefined ? (
              <CostAmount
                amountUsd={view.amountUsd}
                estimated={view.estimated}
              />
            ) : !summary?.hasMessages || isRunning ? (
              "—"
            ) : (
              COMPLETENESS_LABEL.unavailable
            )}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-1 pl-[60px] text-[10px] leading-tight text-muted-foreground">
        {notes.map((note, index) => (
          <span key={note} className="flex items-center gap-x-1">
            {index > 0 ? <span aria-hidden>·</span> : null}
            {note}
          </span>
        ))}
        {winnerLabel ? (
          <span className="flex items-center gap-x-1 font-medium text-emerald-700 dark:text-emerald-400">
            <span aria-hidden className="font-normal text-muted-foreground">
              ·
            </span>
            {winnerLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
