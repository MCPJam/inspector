import { useFeatureFlagEnabled } from "posthog-js/react";

export const FAILURE_GROUPS_FEATURE_FLAG = "evaluate-failure-groups-enabled";

/**
 * Judge-rationale failure groups on the Evaluate run page.
 *
 * Fail-closed: `useFeatureFlagEnabled` is `undefined` while flags load, and
 * that is treated as off. Flag off means no query and no DOM — the card is
 * not mounted, so a flag-off page issues zero extra work.
 */
export function useFailureGroupsEnabled(): boolean {
  return useFeatureFlagEnabled(FAILURE_GROUPS_FEATURE_FLAG) === true;
}
