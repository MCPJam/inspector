import { useInsight } from "./use-insight";
import type { EvalSuiteRun } from "./types";

export const RUN_INSIGHTS_PENDING_STALE_MS = 120_000;

/**
 * Request and track diff-based run insights (`runInsights` on `testSuiteRun`).
 * Thin wrapper around the generic `useInsight` hook.
 */
export function useRunInsights(
  run: EvalSuiteRun | null,
  options?: { autoRequest?: boolean },
) {
  const hook = useInsight(
    run,
    {
      getStatus: (r) => r.runInsightsStatus,
      getResult: (r) => r.runInsights,
      requestMutation: "runInsights:requestRunInsights",
      cancelMutation: "runInsights:cancelRunInsights",
    },
    options,
  );

  // Preserve the original API shape for existing consumers.
  return {
    canRequest: hook.canRequest,
    error: hook.error,
    unavailable: hook.unavailable,
    requested: hook.requested,
    requestRunInsights: hook.requestInsight,
    cancelRunInsights: hook.cancelInsight,
    summary: hook.summary,
    pending: hook.pending,
    failedGeneration: hook.failedGeneration,
  };
}
