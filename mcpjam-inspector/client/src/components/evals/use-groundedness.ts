import { useCallback } from "react";
import { useInsight } from "./use-insight";
import type { EvalSuiteRun } from "./types";

/**
 * Request and track the Groundedness judge — the second named advisory judge.
 * Grades whether each case's final answer is SUPPORTED by its tool
 * trajectory (not whether the goal was accomplished; that's goal
 * completion's question). Thin wrapper around the generic `useInsight`
 * registry hook — one entry per named judge is the whole point of that
 * contract.
 *
 * `autoRequest: false` — spends an LLM call, so it only runs on an explicit
 * click. v1 has no config knobs: on-demand, default model + threshold.
 */
export function useGroundedness(run: EvalSuiteRun | null) {
  const hook = useInsight(
    run,
    {
      getStatus: (r) => r.groundednessStatus,
      getResult: (r) => r.groundedness,
      requestMutation: "groundedness:requestGroundedness",
      cancelMutation: "groundedness:cancelGroundedness",
    },
    { autoRequest: false },
  );

  const requestGroundedness = useCallback(
    (force?: boolean) => hook.requestInsight(force),
    [hook.requestInsight],
  );

  return {
    result: hook.result,
    pending: hook.pending,
    requested: hook.requested,
    failedGeneration: hook.failedGeneration,
    error: hook.error,
    unavailable: hook.unavailable,
    requestGroundedness,
  };
}
