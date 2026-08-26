import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the pre-run disclosure hint (the info icon beside
 * "Run all"). Sibling of `useCreditEstimateEnabled` — same reasoning applies:
 * the backend contract is not promoted to production yet (g4a), so without
 * this gate every prod user who hovers the icon fires a request that 422s
 * with a consent-flavored "not available on this deployment" message, with
 * no way to turn it off short of a revert.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` both while flags
 * load AND when the flag does not exist, and both are treated as "not
 * enabled" (`=== true`). Flag off means the hint does not render AND the
 * disclosure fetch never fires — the backend query is read-only and fully
 * authorized, so the gate exists purely to control rollout, not access.
 */
export const RUN_DISCLOSURE_FEATURE_FLAG = "run-disclosure-enabled";

export function useRunDisclosureEnabled(): boolean {
  return useFeatureFlagEnabled(RUN_DISCLOSURE_FEATURE_FLAG) === true;
}
