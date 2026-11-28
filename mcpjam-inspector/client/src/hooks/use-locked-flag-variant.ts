import { useEffect, useState } from "react";
import { useActiveFeatureFlags, usePostHog } from "posthog-js/react";

/**
 * A flag's variant, fixed while mounted; null until flags load (and if they
 * never do). Never commits on a timeout. Callers pass `raw` from a literal-key
 * `useFeatureFlagVariantKey` so the allowlist ratchet sees it.
 */
export function useLockedFlagVariant<V extends string>(
  raw: string | boolean | undefined,
  normalize: (raw: string | boolean | undefined) => V,
): V | null {
  const posthog = usePostHog();
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
