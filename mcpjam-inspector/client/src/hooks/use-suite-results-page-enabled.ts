import { useFeatureFlagEnabled } from "posthog-js/react";

/** The read-only Suite page: Runs card, header and results only (EFTW-16). */
export const SUITE_RESULTS_PAGE_FEATURE_FLAG = "eval-suite-results-page";

/** `undefined` while flags load; the Suite page shows today's layout until `true`. */
export function useSuiteResultsPageEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(SUITE_RESULTS_PAGE_FEATURE_FLAG);
}
