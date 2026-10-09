import { useFeatureFlagEnabled } from "posthog-js/react";

/** Existing flag now enables access to Evaluate (Legacy). */
export const EVALUATE_FEATURE_FLAG = "evaluate-enabled";

export function useEvaluateEnabled(): boolean {
  return useFeatureFlagEnabled(EVALUATE_FEATURE_FLAG) === true;
}

/** Tri-state variant for consumers that need to distinguish loading. */
export function useEvaluateEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(EVALUATE_FEATURE_FLAG);
}
