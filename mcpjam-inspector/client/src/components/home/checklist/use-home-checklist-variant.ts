import { useEffect, useState } from "react";
import {
  useActiveFeatureFlags,
  useFeatureFlagVariantKey,
  usePostHog,
} from "posthog-js/react";

export const HOME_CHECKLIST_FLAG = "home-setup-checklist";

export type HomeChecklistVariant = "control" | "treatment";

/**
 * `treatment` for a multivariate rollout's treatment arm, and for a plain
 * boolean rollout (100%) that is on. Anything else is today's Home.
 */
export function normalizeHomeChecklistVariant(
  raw: string | boolean | undefined,
): HomeChecklistVariant {
  return raw === "treatment" || raw === true ? "treatment" : "control";
}

/**
 * The Home variant, fixed for the rest of the visit once flags load so a
 * late flag refresh can't swap the page under the user. Until flags load, and
 * when they never do, Home renders control.
 */
export function useHomeChecklistVariant(): HomeChecklistVariant {
  const posthog = usePostHog();
  // Reading the variant fires the PostHog exposure ($feature_flag_called).
  const raw = useFeatureFlagVariantKey(HOME_CHECKLIST_FLAG);
  // Re-renders when flags resolve, so `hasLoadedFlags` below is current.
  useActiveFeatureFlags();
  const flagsLoaded = posthog?.featureFlags?.hasLoadedFlags ?? false;
  const [committed, setCommitted] = useState<HomeChecklistVariant | null>(() =>
    flagsLoaded ? normalizeHomeChecklistVariant(raw) : null,
  );
  useEffect(() => {
    if (committed !== null || !flagsLoaded) return;
    setCommitted(normalizeHomeChecklistVariant(raw));
  }, [committed, flagsLoaded, raw]);
  return committed ?? "control";
}
