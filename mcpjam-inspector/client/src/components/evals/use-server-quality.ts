import { useInsight } from "./use-insight";
import type { EvalSuiteRun } from "./types";

/**
 * Request and track server quality analysis (tool design + workflow efficiency).
 * Thin wrapper around the generic `useInsight` hook.
 */
export function useServerQuality(
  run: EvalSuiteRun | null,
  options?: { autoRequest?: boolean },
) {
  const hook = useInsight(run, {
    getStatus: (r) => r.serverQualityStatus,
    getResult: (r) => r.serverQuality,
    requestMutation: "serverQuality:requestServerQuality",
    cancelMutation: "serverQuality:cancelServerQuality",
  }, options);

  return {
    canRequest: hook.canRequest,
    error: hook.error,
    unavailable: hook.unavailable,
    requested: hook.requested,
    requestServerQuality: hook.requestInsight,
    cancelServerQuality: hook.cancelInsight,
    summary: hook.summary,
    pending: hook.pending,
    failedGeneration: hook.failedGeneration,
    result: hook.result,
  };
}
