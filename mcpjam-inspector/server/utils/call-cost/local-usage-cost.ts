import {
  parseModelCallCostEvidence,
  type ModelCallCostEvidence,
} from "@mcpjam/sdk";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";
import type { PersistedTurnTrace } from "../chat-ingestion.js";
import { waitAtMost } from "./wait-at-most.js";

/** How long saving the transcript waits for the writeback's prices. */
const WRITEBACK_COST_WAIT_MS = 2_000;

/** The most calls the backend takes in one writeback. */
export const MAX_WRITEBACK_CALLS = 100;

/** One provider request of a turn, as the usage writeback reports it. */
export type TurnModelCall = {
  /** `<turnId>:<stepIndex>`: stable, so a retried writeback stores it once. */
  callId: string;
  stepIndex: number;
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  /** When the step finished, ms since epoch. */
  finishedAt: number;
};

/**
 * The writeback body's `calls`: one entry per provider request. A call the
 * provider reported no usage for is sent with none, rather than left out.
 */
export function localUsageCallsBody(calls: TurnModelCall[]) {
  return calls.map((call) => ({
    requestId: call.callId,
    usage: call.usage ?? {},
    ...(call.finishReason ? { finishReason: call.finishReason } : {}),
    finishedAt: call.finishedAt,
  }));
}

/**
 * The backend's price for each call, keyed by call id, from a
 * `/stream/org/local-usage` response. Malformed entries are skipped.
 */
export function readLocalUsageCosts(
  body: unknown,
): Record<string, ModelCallCostEvidence> {
  const costs =
    body && typeof body === "object" && "costs" in body ? body.costs : null;
  const priced: Record<string, ModelCallCostEvidence> = {};
  if (!costs || typeof costs !== "object") return priced;
  for (const [callId, raw] of Object.entries(costs)) {
    const cost = parseModelCallCostEvidence(raw);
    if (cost) priced[callId] = cost;
  }
  return priced;
}

/**
 * Put the backend's price for each call of a local org turn on that call's
 * llm span. The Inspector never prices these calls itself: the
 * organization's rates live in the backend, which prices each provider
 * request on its own usage, so a context tier is crossed per call.
 */
export async function withLocalUsageCost(
  turnTrace: PersistedTurnTrace,
  calls: TurnModelCall[],
  costs: Promise<Record<string, ModelCallCostEvidence> | undefined>,
): Promise<PersistedTurnTrace> {
  if (!calls.length) return turnTrace;
  const priced = await waitAtMost(
    costs,
    WRITEBACK_COST_WAIT_MS,
    "usage writeback",
  );
  if (!priced) return turnTrace;
  const callIdByStep = new Map(
    calls.map((call) => [call.stepIndex, call.callId]),
  );
  return {
    ...turnTrace,
    spans: turnTrace.spans.map((span) => {
      if (span.category !== "llm" || span.stepIndex === undefined) return span;
      const cost = priced[callIdByStep.get(span.stepIndex) ?? ""];
      return cost ? { ...span, cost } : span;
    }),
  };
}
