import { useFeatureFlagVariantKey } from "posthog-js/react";

/**
 * PostHog A/B test deciding what a *first-time* viewer's personal
 * auto-connect preference starts as (PUR-22 ask #2 — default auto-connect
 * on for everyone, but roll it out behind an experiment so we can compare
 * connection-failure rates between the "on" and "off" cohorts before
 * fully committing).
 *
 * Two variants, both meaningful without the flag ever resolving:
 *  - "on"  — auto-connect defaults enabled (the target end state).
 *  - "off" — auto-connect defaults disabled (today's baseline behavior).
 *
 * This only decides the STARTING value. Once a viewer has an explicit
 * stored preference (they toggled the switch themselves, in either
 * direction), that opt-out/opt-in always wins — see the seeding effect in
 * `useAutoConnectProjectServers`. PostHog's own flag-evaluation call
 * already emits the `$feature_flag_called` exposure event, so no extra
 * tracking is needed to know who was bucketed into which arm; pair that
 * with the `auto_connect_batch_result` event (also emitted from
 * `useAutoConnectProjectServers`) to compare failure rates per variant.
 */
export const AUTO_CONNECT_DEFAULT_FEATURE_FLAG = "auto-connect-default";

export type AutoConnectDefaultVariant = "on" | "off";

/** `undefined` while PostHog is still loading (or the flag doesn't exist). */
export function useAutoConnectDefaultVariant():
  | AutoConnectDefaultVariant
  | undefined {
  const variant = useFeatureFlagVariantKey(AUTO_CONNECT_DEFAULT_FEATURE_FLAG);
  return variant === "on" || variant === "off" ? variant : undefined;
}
