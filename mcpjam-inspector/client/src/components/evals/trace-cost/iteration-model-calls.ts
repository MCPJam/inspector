import { makeFunctionReference } from "convex/server";
import {
  parseModelCallCostEvidence,
  readExecutionRecord,
  type ModelCallCostEvidence,
  type ModelCostRollup,
} from "@mcpjam/sdk/browser";
import { isConvexQueryNotServed } from "@/lib/convex-error";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalIteration } from "../types";
import { COST_SOURCE_LABEL } from "./cost-view";

export const ITERATION_MODEL_CALLS_QUERY = "evalIterationModelCalls:list";

/** One provider call the backend recorded for an eval iteration. */
export type IterationModelCall = {
  generationId: string;
  requestId?: string;
  modelId: string;
  role?: "target" | "judge" | "persona" | "other";
  createdAt: number;
  cost?: unknown;
  /** Set only when a stable id joins the call to a step's span. */
  matchedSpanId?: string;
};

export const listIterationModelCalls = makeFunctionReference<
  "query",
  { iterationId: string },
  IterationModelCall[]
>(ITERATION_MODEL_CALLS_QUERY);

/** What the trace summary knows about an eval iteration beyond its spans. */
export type IterationCostContext = {
  iterationId: string;
  /** The backend's sum over every call it recorded, when it stored one. */
  rollup?: ModelCostRollup;
  /** A harness ran the iteration, so some calls may have no step span. */
  harness: boolean;
};

export type UnmatchedModelCall = {
  generationId: string;
  modelId: string;
  cost?: ModelCallCostEvidence;
};

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/** A stored rollup, only when every field the summary renders is valid. */
function readCostRollup(value: unknown): ModelCostRollup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rollup = value as Record<keyof ModelCostRollup, unknown>;
  const { knownSubtotalUsd: subtotal, sources } = rollup;
  const valid =
    rollup.currency === "USD" &&
    typeof subtotal === "number" &&
    Number.isFinite(subtotal) &&
    subtotal >= 0 &&
    ["complete", "partial", "unavailable"].includes(
      rollup.completeness as string,
    ) &&
    isCount(rollup.totalCalls) &&
    isCount(rollup.completeCalls) &&
    isCount(rollup.partialCalls) &&
    isCount(rollup.unavailableCalls) &&
    Array.isArray(sources) &&
    sources.every(
      (source) =>
        typeof source === "string" && Object.hasOwn(COST_SOURCE_LABEL, source),
    );
  return valid ? (value as ModelCostRollup) : undefined;
}

/**
 * `executionEngine` comes from the iteration's run when the host has it;
 * otherwise the iteration's own execution record says whether a harness ran.
 */
export function iterationCostContext(
  iteration: Pick<EvalIteration, "_id" | "usage" | "execution">,
  executionEngine?: string,
): IterationCostContext {
  const rollup = readCostRollup(iteration.usage?.costRollup);
  return {
    iterationId: iteration._id,
    ...(rollup ? { rollup } : {}),
    harness: executionEngine
      ? executionEngine.startsWith("harness:")
      : Boolean(readExecutionRecord(iteration.execution)?.harness),
  };
}

/** A harness iteration's calls read against its trace's llm spans. */
export type JoinedModelCalls = {
  /** The spans; an llm span with no cost of its own takes its call's. */
  spans: EvalTraceSpan[];
  /** Calls no llm span in this trace stands for. */
  unmatched: UnmatchedModelCall[];
};

/**
 * Join calls to llm spans by the backend's `matchedSpanId` alone, never by
 * model or time, which could put one call's cost on another call's step. A
 * span keeps its own cost; one without it (a harness span) takes its matched
 * call's evidence. A call whose span is not in this trace, or whose span
 * already stands for another call, is unmatched, so summing the spans and the
 * unmatched calls counts every call once.
 */
export function joinModelCalls(
  spans: readonly EvalTraceSpan[],
  calls: readonly IterationModelCall[] | undefined,
): JoinedModelCalls {
  const llmSpanIds = new Set(
    spans.filter((span) => span.category === "llm").map((span) => span.id),
  );
  const matchedCost = new Map<string, ModelCallCostEvidence | undefined>();
  const unmatched: UnmatchedModelCall[] = [];
  const seen = new Set<string>();
  for (const call of calls ?? []) {
    // The same generation reported twice is one call.
    if (seen.has(call.generationId)) continue;
    seen.add(call.generationId);
    const cost = parseModelCallCostEvidence(call.cost);
    const spanId = call.matchedSpanId;
    if (spanId && llmSpanIds.has(spanId) && !matchedCost.has(spanId)) {
      matchedCost.set(spanId, cost);
    } else {
      unmatched.push({
        generationId: call.generationId,
        modelId: call.modelId,
        cost,
      });
    }
  }
  return {
    spans: spans.map((span) => {
      const cost = span.cost ?? matchedCost.get(span.id);
      return cost === span.cost ? span : { ...span, cost };
    }),
    unmatched,
  };
}

/**
 * The query is not deployed everywhere yet; until it is, it reads as absent,
 * including a redacted "Server Error" (see `isConvexQueryNotServed`).
 */
export function isIterationModelCallsUnavailable(error: Error): boolean {
  return isConvexQueryNotServed(error, ITERATION_MODEL_CALLS_QUERY);
}
