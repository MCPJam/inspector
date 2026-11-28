import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { ErrorBoundary } from "@/components/ui/error-boundary";
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
import {
  isIterationModelCallsUnavailable,
  joinModelCalls,
  listIterationModelCalls,
  type IterationCostContext,
  type IterationModelCall,
  type UnmatchedModelCall,
} from "./iteration-model-calls";

const NO_UNMATCHED_CALLS: UnmatchedModelCall[] = [];

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

/** A trace's spans as cost reads them, and the calls no span stands for. */
export type TraceCostSpans = {
  /** An llm span without its own cost carries its matched call's. */
  spans: EvalTraceSpan[] | null | undefined;
  unmatched: UnmatchedModelCall[];
  /** Mount it beside the trace: it fetches a harness iteration's calls. */
  loader: ReactNode;
};

type LoadedCalls = { iterationId: string; calls: IterationModelCall[] };

/**
 * Joins a harness iteration's calls to its spans once, so the summary, the
 * detail pane and the hover card count the same evidence. The original spans
 * pass through untouched until calls arrive, and nothing is fetched with the
 * flag off or for an iteration no harness ran.
 */
export function useTraceCostSpans(
  spans: EvalTraceSpan[] | null | undefined,
  iteration: IterationCostContext | undefined,
): TraceCostSpans {
  const enabled = useTraceCostEnabled();
  const iterationId =
    enabled && iteration?.harness ? iteration.iterationId : undefined;
  const [loaded, setLoaded] = useState<LoadedCalls>();
  const calls = loaded?.iterationId === iterationId ? loaded?.calls : undefined;
  const joined = useMemo(
    () => (calls ? joinModelCalls(spans ?? [], calls) : undefined),
    [spans, calls],
  );
  // Until every deployment serves the query, a failed fetch leaves the
  // spans as they are and lists no unmatched calls. A fetch that fails after
  // one succeeded drops those calls too, rather than showing stale ones.
  const forgetCalls = useCallback(() => setLoaded(undefined), []);
  const loader = iterationId ? (
    <ErrorBoundary
      key={iterationId}
      name="trace-cost-model-calls"
      isExpectedError={isIterationModelCallsUnavailable}
      onError={forgetCalls}
      fallback={null}
    >
      <ModelCallsLoader iterationId={iterationId} onLoad={setLoaded} />
    </ErrorBoundary>
  ) : null;
  return {
    spans: joined?.spans ?? spans,
    unmatched: joined?.unmatched ?? NO_UNMATCHED_CALLS,
    loader,
  };
}

function ModelCallsLoader({
  iterationId,
  onLoad,
}: {
  iterationId: string;
  onLoad: (loaded: LoadedCalls) => void;
}) {
  const calls = useQuery(listIterationModelCalls, { iterationId });
  useEffect(() => {
    if (calls) onLoad({ iterationId, calls });
  }, [calls, iterationId, onLoad]);
  return null;
}

type SummaryProps = {
  /** From `useTraceCostSpans`, so harness spans carry their calls' cost. */
  spans: readonly EvalTraceSpan[] | null | undefined;
  /** Set for an eval iteration: its stored total and whether a harness ran it. */
  iteration?: IterationCostContext;
  unmatched?: UnmatchedModelCall[];
};

/** The whole trace's total, above the timeline. */
export function TraceCostSummary({
  spans,
  iteration,
  unmatched = NO_UNMATCHED_CALLS,
}: SummaryProps) {
  const enabled = useTraceCostEnabled();
  // The iteration's stored total already counts every call it recorded,
  // unmatched ones included; without it, unmatched calls join the spans' sum
  // (a harness span carries its matched call's cost; see `joinModelCalls`).
  const cost = useMemo<RowCost | undefined>(() => {
    if (!enabled) return undefined;
    const rollup =
      iteration?.rollup ??
      rollupLlmSpanCosts(
        spans ?? [],
        unmatched.map((call) => call.cost),
      );
    return rollup && { kind: "rollup", rollup };
  }, [enabled, spans, iteration?.rollup, unmatched]);
  const view = useCostView(cost);
  if (!view) return null;
  return (
    <div
      data-testid="trace-cost-summary"
      className="shrink-0 space-y-2 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
      {unmatched.length > 0 ? <UnmatchedCalls calls={unmatched} /> : null}
    </div>
  );
}

/** Harness calls no step's span stands for, each with its own cost. */
function UnmatchedCalls({ calls }: { calls: UnmatchedModelCall[] }) {
  return (
    <div data-testid="trace-cost-unmatched-calls" className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide">
        Model calls not matched to a step
      </div>
      {/* Capped: the summary sits outside the timeline's scroll area, so a
          long list would squeeze the waterfall. */}
      <ul
        data-testid="trace-cost-unmatched-list"
        className="max-h-40 space-y-0.5 overflow-y-auto"
      >
        {calls.map((call) => {
          const view =
            call.cost && describeRowCost({ kind: "call", cost: call.cost });
          return (
            <li
              key={call.generationId}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="min-w-0 truncate font-mono text-foreground">
                {call.modelId}
              </span>
              <span className="font-medium text-foreground">
                {view?.amountUsd !== undefined ? (
                  <CostAmount
                    amountUsd={view.amountUsd}
                    estimated={view.estimated}
                  />
                ) : (
                  "Cost unavailable"
                )}
              </span>
              {view?.sourceLabel ? <span>{view.sourceLabel}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
