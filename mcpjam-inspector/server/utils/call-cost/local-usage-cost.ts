import {
  parseModelCallCostEvidence,
  type ModelCallCostEvidence,
} from "@mcpjam/sdk";
import type { PersistedTurnTrace } from "../chat-ingestion.js";
import { waitAtMost } from "./wait-at-most.js";

/** How long saving the transcript waits for the writeback's price. */
const WRITEBACK_COST_WAIT_MS = 2_000;

/** The backend's priced record from a `/stream/org/local-usage` response. */
export function readLocalUsageCost(
  body: unknown,
): ModelCallCostEvidence | undefined {
  return body && typeof body === "object" && "cost" in body
    ? parseModelCallCostEvidence(body.cost)
    : undefined;
}

/**
 * Put the backend's price for a local org turn on the turn's llm span. The
 * Inspector never prices these calls itself: the organization's rates live in
 * the backend.
 *
 * The local runtime writes usage back once per turn, with the turn's tokens
 * summed. That price is one call's cost only when the turn made one call. A
 * turn of several calls was priced as if it were one request, which can cross
 * a context tier none of its calls crossed, so its spans keep no cost.
 */
export async function withLocalUsageCost(
  turnTrace: PersistedTurnTrace,
  cost: Promise<ModelCallCostEvidence | undefined>,
): Promise<PersistedTurnTrace> {
  const calls = turnTrace.spans.filter((span) => span.category === "llm");
  if (calls.length !== 1) return turnTrace;
  const priced = await waitAtMost(
    cost,
    WRITEBACK_COST_WAIT_MS,
    "usage writeback",
  );
  if (!priced) return turnTrace;
  return {
    ...turnTrace,
    spans: turnTrace.spans.map((span) =>
      span === calls[0] ? { ...span, cost: priced } : span,
    ),
  };
}
