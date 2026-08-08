import posthog from "posthog-js";
import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { standardEventProps } from "./PosthogUtils";

/**
 * The single client-side capture entrypoint. Only client-authoritative event
 * names registered in shared/analytics-events.ts are accepted (server twins
 * like `send_message_server` are rejected at the type level so the browser
 * can't emit them); standard props (location, platform, environment) are
 * injected automatically and are authoritative — a caller cannot override
 * them via props.
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
  event: ClientAnalyticsEventName,
  props: Record<string, unknown> & { location?: string } = {},
): void {
  // Drop platform/environment from the caller's props rather than relying
  // on spread order alone: standardEventProps() OMITS `environment` when
  // VITE_ENVIRONMENT is unset (so the registered super-property can win),
  // and an omitted key can't override anything on the spread below — a
  // caller-supplied `environment: undefined` would otherwise survive into
  // the captured event and reintroduce the exact clobber bug this guards
  // against.
  const {
    location = "unknown",
    platform: _platform,
    environment: _environment,
    ...rest
  } = props;
  posthog.capture(event, { ...rest, ...standardEventProps(location) });
}
