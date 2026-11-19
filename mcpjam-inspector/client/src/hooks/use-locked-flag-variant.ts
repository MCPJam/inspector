import { useEffect, useState } from "react";
import {
  useActiveFeatureFlags,
  useFeatureFlagVariantKey,
  usePostHog,
} from "posthog-js/react";

/**
 * A PostHog flag's variant, fixed for as long as the caller stays mounted so a
 * late flag refresh can't swap the screen under the user. Null until flags
 * load, and for good when they never do (an ad blocker, say): the caller picks
 * its fallback, and should hold any exposure-dependent tracking until then.
 * It never commits on a timeout, which would misattribute a slow user whose
 * flag resolves late.
 */
export function useLockedFlagVariant<V extends string>(
  flag: string,
  normalize: (raw: string | boolean | undefined) => V,
): V | null {
  const posthog = usePostHog();
  // Reading the variant fires the PostHog exposure ($feature_flag_called).
  const raw = useFeatureFlagVariantKey(flag);
  // Subscribed for its re-render when flags resolve, even when this flag is
  // absent, so the `hasLoadedFlags` read below stays current.
  useActiveFeatureFlags();
  const flagsLoaded = posthog?.featureFlags?.hasLoadedFlags ?? false;
  // Initialized synchronously when flags are already loaded, so there is no
  // fallback-to-variant flicker.
  const [committed, setCommitted] = useState<V | null>(() =>
    flagsLoaded ? normalize(raw) : null,
  );
  useEffect(() => {
    if (committed !== null || !flagsLoaded) return;
    setCommitted(normalize(raw));
  }, [committed, flagsLoaded, raw, normalize]);
  return committed;
}
