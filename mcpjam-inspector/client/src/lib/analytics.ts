import posthog from "posthog-js";
import type { AnalyticsEventName } from "@/shared/analytics-events";
import { standardEventProps } from "./PosthogUtils";

/**
 * The single client-side capture entrypoint. Only event names registered in
 * shared/analytics-events.ts are accepted; standard props (location,
 * platform, environment) are injected automatically.
 *
 * Raw `posthog.capture(...)` calls outside this file are frozen by the
 * ratchet test (__tests__/analytics-ratchet.test.ts): legacy call sites stay
 * where they are until their area migrates, but new ones must go through
 * here.
 *
 * The posthog-js singleton is the same instance PostHogProvider initializes
 * (the provider is given an apiKey, which inits the global instance), and it
 * already honors VITE_DISABLE_POSTHOG_LOCAL via opt_out_capturing_by_default
 * — no disabled-state branching needed here.
 */
export function track(
  event: AnalyticsEventName,
  props: Record<string, unknown> & { location?: string } = {},
): void {
  const { location = "unknown", ...rest } = props;
  posthog.capture(event, { ...standardEventProps(location), ...rest });
}
