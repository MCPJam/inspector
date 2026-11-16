import { makeFunctionReference } from "convex/server";
import {
  parseModelCallCostEvidence,
  readExecutionRecord,
  type ModelCallCostEvidence,
  type ModelCostRollup,
} from "@mcpjam/sdk/browser";
import { isConvexQueryNotServed } from "@/lib/convex-error";
import type { EvalIteration } from "../types";

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

function readCostRollup(value: unknown): ModelCostRollup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rollup = value as Partial<ModelCostRollup>;
  return rollup.currency === "USD" &&
    typeof rollup.knownSubtotalUsd === "number" &&
    typeof rollup.totalCalls === "number" &&
    Array.isArray(rollup.sources)
    ? (rollup as ModelCostRollup)
    : undefined;
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

/**
 * Calls the backend could not join to a step by a stable id. They are listed
 * apart and never attached to a span by model or time, which could put one
 * call's cost on another call's step.
 */
export function unmatchedModelCalls(
  calls: readonly IterationModelCall[] | undefined,
): UnmatchedModelCall[] {
  return (calls ?? [])
    .filter((call) => !call.matchedSpanId)
    .map((call) => ({
      generationId: call.generationId,
      modelId: call.modelId,
      cost: parseModelCallCostEvidence(call.cost),
    }));
}

/** The query is not deployed everywhere yet; until it is, it reads as absent. */
export function isIterationModelCallsUnavailable(error: Error): boolean {
  return isConvexQueryNotServed(error, ITERATION_MODEL_CALLS_QUERY);
}
