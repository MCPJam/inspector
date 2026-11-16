import { useState } from "react";
import type { CostSource, ModelCostRollup } from "@mcpjam/sdk/browser";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import { selectRowCost } from "@/components/evals/trace-cost/cost-view";
import type { LiveChatTraceEnvelope } from "@/shared/live-chat-trace";
import type { MultiModelCardSummary } from "./model-compare-card-header";

/** The one scope a compare card's cost and its winner use, as tokens and latency do. */
export const COMPARE_COST_SCOPE_LABEL = "Latest turn";

type CostBasis = "reported" | "estimated";

export const COST_WINNER_LABEL: Record<CostBasis, string> = {
  reported: "Lowest cost",
  estimated: "Lowest estimated cost",
};

const ESTIMATE_SOURCES: ReadonlySet<CostSource> = new Set([
  "list_price",
  "customer_rate",
]);

/**
 * The latest turn's cost: its llm spans summed, grouped by prompt the way the
 * timeline groups them. Undefined when none of those spans carries a cost.
 */
export function latestTurnCost(
  trace: Pick<LiveChatTraceEnvelope, "turns" | "spans"> | null | undefined,
): ModelCostRollup | undefined {
  const turn = trace?.turns?.at(-1);
  if (!turn) return undefined;
  const cost = selectRowCost(
    { kind: "prompt", promptIndex: turn.promptIndex },
    trace?.spans,
  );
  return cost?.kind === "rollup" ? cost.rollup : undefined;
}

function sameRollup(
  left: ModelCostRollup | undefined,
  right: ModelCostRollup | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.knownSubtotalUsd === right.knownSubtotalUsd &&
    left.completeness === right.completeness &&
    left.totalCalls === right.totalCalls &&
    left.completeCalls === right.completeCalls &&
    left.partialCalls === right.partialCalls &&
    left.unavailableCalls === right.unavailableCalls &&
    left.sources.join() === right.sources.join()
  );
}

/**
 * The latest turn's cost for a card's summary; undefined while `trace-cost`
 * is off, so the summary is what it was before the flag. The live trace is
 * rebuilt on every streamed token, and every new summary is lifted into the
 * parent's state, so the same object comes back until a call's cost changes.
 */
export function useLatestTurnCost(
  trace: Pick<LiveChatTraceEnvelope, "turns" | "spans"> | null | undefined,
): ModelCostRollup | undefined {
  const enabled = useTraceCostEnabled();
  const next = enabled ? latestTurnCost(trace) : undefined;
  const [held, setHeld] = useState(next);
  if (sameRollup(held, next)) return held;
  setHeld(next);
  return next;
}

/** A turn's one pricing basis, or undefined when its calls mix bases. */
function costBasis(rollup: ModelCostRollup): CostBasis | undefined {
  const { sources } = rollup;
  if (sources.length === 0) return undefined;
  if (sources.every((source) => source === "provider_reported")) {
    return "reported";
  }
  return sources.every((source) => ESTIMATE_SOURCES.has(source))
    ? "estimated"
    : undefined;
}

type CostWinner = { amountUsd: number; basis: CostBasis; broadcastId: number };

/**
 * The lowest cost across every compared card, or undefined when the cards
 * cannot be fairly ranked. Each card must have answered the same broadcast
 * without an error or a stop, priced every call, and share one basis with the
 * others: a partial subtotal, a failed or stopped turn, a follow-up sent to
 * one card, or an estimate set against a reported amount would not be the
 * same bill.
 */
function findCostWinner(
  summaries: readonly MultiModelCardSummary[],
): CostWinner | undefined {
  const broadcastId = summaries[0]?.broadcastId;
  if (summaries.length < 2 || broadcastId === undefined) return undefined;
  let basis: CostBasis | undefined;
  const amounts: number[] = [];
  for (const summary of summaries) {
    const cost = summary.status === "ready" ? summary.cost : undefined;
    if (!cost || cost.completeness !== "complete") return undefined;
    if (summary.broadcastId !== broadcastId) return undefined;
    const cardBasis = costBasis(cost);
    if (!cardBasis || (basis && basis !== cardBasis)) return undefined;
    basis = cardBasis;
    amounts.push(cost.knownSubtotalUsd);
  }
  return basis && { amountUsd: Math.min(...amounts), basis, broadcastId };
}

/** "Lowest cost" or "Lowest estimated cost" when this card wins; otherwise undefined. */
export function costWinnerLabel(
  summary: MultiModelCardSummary | null,
  allSummaries: readonly MultiModelCardSummary[],
): string | undefined {
  const winner = findCostWinner(allSummaries);
  const cost = summary?.status === "ready" ? summary.cost : undefined;
  if (!winner || !cost || cost.completeness !== "complete") return undefined;
  return summary?.broadcastId === winner.broadcastId &&
    costBasis(cost) === winner.basis &&
    cost.knownSubtotalUsd === winner.amountUsd
    ? COST_WINNER_LABEL[winner.basis]
    : undefined;
}
