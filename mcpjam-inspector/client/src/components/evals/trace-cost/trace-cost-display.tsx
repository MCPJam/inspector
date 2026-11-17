import { useMemo, type ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  COMPLETENESS_LABEL,
  describeRowCost,
  formatModelCost,
  rollupLlmSpanCosts,
  type CostView,
  type RowCost,
} from "./cost-view";

/**
 * Every component here renders nothing while the `trace-cost` flag is off,
 * so the timeline's DOM is the same as before the flag existed.
 */
function useCostView(cost: RowCost | undefined): CostView | undefined {
  const enabled = useTraceCostEnabled();
  return useMemo(
    () => (enabled && cost ? describeRowCost(cost) : undefined),
    [enabled, cost],
  );
}

/**
 * A dollar amount with the "≈" mark for estimates. With `slot`, the mark sits
 * in a fixed one-character slot even when absent, so dollar signs line up in
 * a column.
 */
export function CostAmount({
  amountUsd,
  estimated,
  slot = false,
}: {
  amountUsd: number;
  estimated: boolean;
  slot?: boolean;
}) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {estimated ? (
        <span className="inline-block w-[1ch] text-center">≈</span>
      ) : slot ? (
        <span aria-hidden className="inline-block w-[1ch]" />
      ) : null}
      {formatModelCost(amountUsd)}
    </span>
  );
}

/** Source, state, coverage and reason as a row of small facts. */
function CostFacts({ view }: { view: CostView }) {
  return (
    <>
      {view.sourceLabel ? (
        <Badge
          variant="outline"
          className="px-1.5 py-0 text-[10px] text-muted-foreground"
        >
          {view.sourceLabel}
        </Badge>
      ) : null}
      {view.completeness !== "complete" ? (
        <Badge
          variant="outline"
          className={cn(
            "px-1.5 py-0 text-[10px]",
            view.completeness === "partial"
              ? "border-warning/50 bg-warning/10 text-foreground"
              : "text-muted-foreground",
          )}
        >
          {COMPLETENESS_LABEL[view.completeness]}
        </Badge>
      ) : null}
      {view.coverage ? <span>{view.coverage}</span> : null}
      {view.note ? <span>{view.note}</span> : null}
    </>
  );
}

/** The amount, appended to the detail pane's duration and token line. */
export function TraceCostInline({ cost }: { cost: RowCost | undefined }) {
  const view = useCostView(cost);
  if (view?.amountUsd === undefined) return null;
  return (
    <span data-testid="trace-cost-inline">
      {" · "}
      <span className="font-medium text-foreground">
        <CostAmount amountUsd={view.amountUsd} estimated={view.estimated} />
      </span>
    </span>
  );
}

/** Where the amount came from and how complete it is, under the detail line. */
export function TraceCostChips({ cost }: { cost: RowCost | undefined }) {
  const view = useCostView(cost);
  if (!view) return null;
  return (
    <div
      data-testid="trace-cost-chips"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
    >
      <span className="text-muted-foreground/70">Cost</span>
      <CostFacts view={view} />
    </div>
  );
}

function HoverRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-popover-foreground/70">{label}</span>
      <span className="min-w-0 text-right font-medium text-popover-foreground">
        {children}
      </span>
    </div>
  );
}

/** The hover card's Cost block, under its Tokens block. */
export function TraceCostHoverBlock({ cost }: { cost: RowCost | undefined }) {
  const view = useCostView(cost);
  if (!view) return null;
  return (
    <div data-testid="trace-row-hover-cost" className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-popover-foreground/65">
        Cost
      </div>
      <div className="space-y-1 text-xs">
        <HoverRow label={cost?.kind === "rollup" ? "Total" : "Amount"}>
          {view.amountUsd === undefined ? (
            "Unavailable"
          ) : (
            <CostAmount
              amountUsd={view.amountUsd}
              estimated={view.estimated}
              slot
            />
          )}
        </HoverRow>
        {view.parts.map((part) => (
          <HoverRow key={part.label} label={part.label}>
            <CostAmount
              amountUsd={part.amountUsd}
              estimated={view.estimated}
              slot
            />
          </HoverRow>
        ))}
        {view.sourceLabel ? (
          <HoverRow label="Source">{view.sourceLabel}</HoverRow>
        ) : null}
        {view.completeness === "partial" ? (
          <HoverRow label="Status">{COMPLETENESS_LABEL.partial}</HoverRow>
        ) : null}
        {view.coverage ? (
          <HoverRow label="Coverage">{view.coverage}</HoverRow>
        ) : null}
        {view.note ? (
          <p className="text-popover-foreground/70">{view.note}</p>
        ) : null}
      </div>
    </div>
  );
}

/** The whole trace's total, above the timeline. */
export function TraceCostSummary({
  spans,
}: {
  spans: readonly EvalTraceSpan[] | null | undefined;
}) {
  const enabled = useTraceCostEnabled();
  const cost = useMemo<RowCost | undefined>(() => {
    if (!enabled) return undefined;
    const rollup = rollupLlmSpanCosts(spans ?? []);
    return rollup && { kind: "rollup", rollup };
  }, [enabled, spans]);
  const view = useCostView(cost);
  if (!view) return null;
  return (
    <div
      data-testid="trace-cost-summary"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide">
        Trace cost
      </span>
      {view.amountUsd !== undefined ? (
        <span className="text-sm font-semibold text-foreground">
          <CostAmount amountUsd={view.amountUsd} estimated={view.estimated} />
        </span>
      ) : null}
      <CostFacts view={view} />
    </div>
  );
}
