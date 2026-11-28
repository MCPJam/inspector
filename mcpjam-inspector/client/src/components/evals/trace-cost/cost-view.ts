import {
  aggregateModelCallCosts,
  type CostParts,
  type CostSource,
  type MissingCostComponent,
  type ModelCallCostEvidence,
  type ModelCostRollup,
  type UnavailableCostReason,
} from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";

/** What a timeline row costs: one call's stored evidence, or a sum of calls. */
export type RowCost =
  | { kind: "call"; cost: ModelCallCostEvidence }
  | { kind: "rollup"; rollup: ModelCostRollup };

/** The timeline row shapes this reads; structural so its private row types fit. */
export type CostRowTarget =
  | { kind: "prompt"; promptIndex: number }
  | { kind: "span"; span: EvalTraceSpan }
  | { kind: "interaction" };

/**
 * Sum the costs on llm spans, the only spans that carry one. Undefined when
 * none does: a trace recorded before costs were captured shows no cost rather
 * than "unavailable" on every call. Once one call has evidence, a call
 * without it counts as unpriced. `unplacedCalls` are calls no span stands
 * for, such as a harness call no step matched; each counts once.
 */
export function rollupLlmSpanCosts(
  spans: readonly EvalTraceSpan[],
  unplacedCalls: ReadonlyArray<ModelCallCostEvidence | undefined> = [],
): ModelCostRollup | undefined {
  const llm = spans.filter((span) => span.category === "llm");
  if (!llm.some((span) => span.cost) && unplacedCalls.length === 0) {
    return undefined;
  }
  return aggregateModelCallCosts([
    ...llm.map((span) => span.cost),
    ...unplacedCalls,
  ]);
}

export function selectRowCost(
  row: CostRowTarget | null | undefined,
  spans: readonly EvalTraceSpan[] | null | undefined,
): RowCost | undefined {
  if (!row || row.kind === "interaction") return undefined;
  if (row.kind === "span") {
    const { span } = row;
    if (span.category !== "llm") return undefined;
    // `spans` may carry a matched harness call's cost the row's span lacks.
    const cost = span.cost ?? spans?.find(({ id }) => id === span.id)?.cost;
    return cost ? { kind: "call", cost } : undefined;
  }
  // Same grouping as the timeline: a span without a prompt index is prompt 0.
  const rollup = rollupLlmSpanCosts(
    (spans ?? []).filter((span) => (span.promptIndex ?? 0) === row.promptIndex),
  );
  return rollup ? { kind: "rollup", rollup } : undefined;
}

/**
 * Dollars on a trace. Four decimals below $1 so a call's parts visibly add up
 * to its total; a bound below what four decimals can state, so a real
 * fraction of a cent never reads as zero. Only an exact zero is `$0.00`.
 */
export function formatModelCost(amountUsd: number): string {
  if (amountUsd === 0) return "$0.00";
  if (amountUsd < 0.0001) return "<$0.0001";
  // Choose the form on the rounded value: 0.99996 rounds to a dollar and must
  // read "$1.00", not "$1.0000".
  const fourPlaces = amountUsd.toFixed(4);
  if (Number(fourPlaces) < 1) return `$${fourPlaces}`;
  return `$${amountUsd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const COST_SOURCE_LABEL: Record<CostSource, string> = {
  provider_reported: "Provider-reported",
  list_price: "Estimated at list price",
  customer_rate: "Estimated at your rates",
  runner_reported: "Runner-reported",
};

/** What an amount is missing, beside it; a complete amount needs no word. */
export const COMPLETENESS_LABEL = {
  partial: "Partial",
  unavailable: "Cost unavailable",
} as const;

const isEstimate = (source: CostSource) =>
  source === "list_price" || source === "customer_rate";

const UNAVAILABLE_REASON: Record<UnavailableCostReason, string> = {
  no_usage: "No token usage was reported for this call.",
  no_rate: "No price is on record for this model.",
  invalid_rate:
    "The price on record for this model was invalid. An organization admin can set a price under Model prices to price future calls.",
  unsupported_currency: "The price on record is not in US dollars.",
};

const MISSING_PART: Record<MissingCostComponent, string> = {
  usage: "unreported usage",
  input_tokens: "input tokens",
  output_tokens: "output tokens",
  rate: "tokens without a rate",
  cache_read_rate: "cache reads",
  cache_write_rate: "cache writes",
  cache_write_1h_rate: "one-hour cache writes",
  web_search_rate: "web searches",
};

const PART_LABEL: Record<keyof CostParts, string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  webSearch: "Web search",
};

/** Everything the cost UI shows for one row, decided in one place. */
export type CostView = {
  /** The amount, or the known subtotal when partial. Absent when unavailable. */
  amountUsd?: number;
  /** Shows the "≈" mark: some of the amount is an estimate, not a report. */
  estimated: boolean;
  sourceLabel?: string;
  completeness: "complete" | "partial" | "unavailable";
  /** "N of M calls priced", for sums; partly priced calls count as priced. */
  coverage?: string;
  /** Why a call is partial or unavailable. */
  note?: string;
  parts: Array<{ label: string; amountUsd: number }>;
};

function rollupSourceLabel(sources: CostSource[]): string | undefined {
  if (sources.length <= 1) return sources[0] && COST_SOURCE_LABEL[sources[0]];
  const estimates = sources.filter(isEstimate).length;
  if (estimates === sources.length) return "Estimated";
  return estimates > 0 ? "Reported and estimated" : "Reported";
}

function describeCall(cost: ModelCallCostEvidence): CostView {
  const missing = (cost.missing ?? []).map((part) => MISSING_PART[part]);
  const note =
    cost.completeness === "unavailable"
      ? cost.reason
        ? UNAVAILABLE_REASON[cost.reason]
        : "No price is on record for this call."
      : cost.completeness === "partial"
        ? missing.length > 0
          ? `Excludes ${missing.join(", ")}.`
          : "Some charges on this call are not priced."
        : undefined;
  const parts = Object.entries(PART_LABEL).flatMap(([key, label]) => {
    const amountUsd = cost.parts?.[key as keyof CostParts];
    return typeof amountUsd === "number" ? [{ label, amountUsd }] : [];
  });
  return {
    amountUsd: cost.amountUsd,
    estimated: cost.source ? isEstimate(cost.source) : false,
    sourceLabel: cost.source ? COST_SOURCE_LABEL[cost.source] : undefined,
    completeness: cost.completeness,
    note,
    parts,
  };
}

function describeRollup(rollup: ModelCostRollup): CostView {
  const priced = rollup.totalCalls - rollup.unavailableCalls;
  const noun = rollup.totalCalls === 1 ? "call" : "calls";
  const partly =
    rollup.partialCalls > 0 ? `, ${rollup.partialCalls} partly` : "";
  return {
    amountUsd:
      rollup.completeness === "unavailable"
        ? undefined
        : rollup.knownSubtotalUsd,
    estimated: rollup.sources.some(isEstimate),
    sourceLabel: rollupSourceLabel(rollup.sources),
    completeness: rollup.completeness,
    coverage: `${priced} of ${rollup.totalCalls} ${noun} priced${partly}`,
    parts: [],
  };
}

export function describeRowCost(cost: RowCost): CostView {
  return cost.kind === "call"
    ? describeCall(cost.cost)
    : describeRollup(cost.rollup);
}
