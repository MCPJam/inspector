import { useFeatureFlagEnabled } from "posthog-js/react";

export const EVALUATOR_LIBRARY_FEATURE_FLAG = "evaluator-library";

/**
 * Whether the evaluator library shows in suite settings. Off while flags
 * load: a button that appears late is better than one that vanishes.
 */
export function useEvaluatorLibraryEnabled(): boolean {
  return useFeatureFlagEnabled(EVALUATOR_LIBRARY_FEATURE_FLAG) === true;
}
