import { useEffect, useState } from "react";
import {
  useActiveFeatureFlags,
  useFeatureFlagEnabled,
  usePostHog,
} from "posthog-js/react";
import { BOOTSTRAP_FLAGS_TIMEOUT_MS } from "@/lib/server-feature-flags";

/** Client flag for the Evaluate navigation rework (E10). */
export const EVALUATE_NAV_FEATURE_FLAG = "evaluate-nav-enabled";

/** How long a page waits for the flag before showing today's page. */
export const EVALUATE_NAV_FLAG_TIMEOUT_MS = BOOTSTRAP_FLAGS_TIMEOUT_MS;

/**
 * `undefined` while the flag is loading, so new pages can wait for a boolean
 * and a flag-on user never sees today's page flash first. It settles to
 * `false` when the flag cannot arrive:
 *
 * - Flags loaded without this one. Flag values come only from our server
 *   (`server-feature-flags.ts`); a failed bootstrap or refresh still loads a
 *   set, an empty one, so `hasLoadedFlags` with no value means it failed.
 * - Nothing loaded within {@link EVALUATE_NAV_FLAG_TIMEOUT_MS}. The answer
 *   stays `false` for this mount even if the flag arrives later, so the page
 *   does not swap under the user.
 */
export function useEvaluateNavEnabled(): boolean | undefined {
  const value = useFeatureFlagEnabled(EVALUATE_NAV_FEATURE_FLAG);
  const posthog = usePostHog();
  // Subscribed for its re-render when flags load: `useFeatureFlagEnabled`
  // does not re-render when this flag stays absent.
  useActiveFeatureFlags();
  const flagsLoaded = posthog?.featureFlags?.hasLoadedFlags === true;
  const settled = value !== undefined || flagsLoaded;
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (settled || timedOut) return;
    const timer = setTimeout(
      () => setTimedOut(true),
      EVALUATE_NAV_FLAG_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [settled, timedOut]);

  if (timedOut) return false;
  if (value !== undefined) return value;
  return flagsLoaded ? false : undefined;
}
