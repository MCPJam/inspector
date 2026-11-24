import { useFeatureFlagEnabled } from "posthog-js/react";

export const CLIMBS_FEATURE_FLAG = "climbs-enabled";

/**
 * One flag for climbs and the mock servers they run on.
 *
 * Fail-closed: `useFeatureFlagEnabled` is `undefined` while flags load, and
 * that is off. With it off no climb screen, tab or badge is mounted and the
 * screens send no request.
 */
export function useClimbsEnabled(): boolean {
  return useFeatureFlagEnabled(CLIMBS_FEATURE_FLAG) === true;
}
