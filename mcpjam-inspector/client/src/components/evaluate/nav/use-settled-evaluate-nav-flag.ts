import { useEffect, useState } from "react";
import { useEvaluateNavEnabled } from "./use-evaluate-nav-enabled";

/** How long an address that depends on the flag waits for PostHog before reading it as off. */
export const NAV_FLAG_WAIT_MS = 2000;

/**
 * `evaluate-nav-enabled`, settled: `undefined` while PostHog loads, `false`
 * once it has not answered within {@link NAV_FLAG_WAIT_MS}. A caller waits on
 * `undefined` so the old screen never flashes before the new one (plan E10).
 */
export function useSettledEvaluateNavFlag(): boolean | undefined {
  const enabled = useEvaluateNavEnabled();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (enabled !== undefined) return;
    const timer = setTimeout(() => setExpired(true), NAV_FLAG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled]);
  return enabled ?? (expired ? false : undefined);
}
