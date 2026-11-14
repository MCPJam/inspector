import { useFeatureFlagEnabled } from "posthog-js/react";

export const RUN_RESULT_PAGES_FEATURE_FLAG = "evaluate-run-result-pages";

/** `undefined` while flags load, so a page link can wait instead of guessing. */
export function useRunResultPagesEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(RUN_RESULT_PAGES_FEATURE_FLAG);
}
