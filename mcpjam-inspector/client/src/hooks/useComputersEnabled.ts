import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for ALL Project Computers UI (the host-editor computer
 * toggle, the Computer nav tab, and the Computer view/terminal). Flag off ⇒
 * the feature is invisible, so we can roll it out per-user / by percentage
 * without a deploy. This is the visibility gate; a deployment still needs the
 * backend computer config (E2B creds + the data-plane secrets) for the
 * feature to actually function once a user is flagged in.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (`=== true`) so the UI never flickers the feature on before PostHog
 * resolves.
 */
export const COMPUTERS_FEATURE_FLAG = "computers-enabled";

export function useComputersEnabled(): boolean {
  return useFeatureFlagEnabled(COMPUTERS_FEATURE_FLAG) === true;
}
