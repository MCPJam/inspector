import posthog from "posthog-js";
import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { standardEventProps } from "./PosthogUtils";

const PRIVATE_ORGANIZATION_EVENT_PREFIXES = [
  "billing_",
  "credit_topup_",
  "plan_limit_",
  "pricing_",
] as const;

function mustRedactOrganizationContext(
  event: ClientAnalyticsEventName,
): boolean {
  return PRIVATE_ORGANIZATION_EVENT_PREFIXES.some((prefix) =>
    event.startsWith(prefix),
  );
}

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
 * inherits the rich person created by usePostHogIdentify (WorkOS id, email,
 * name, occupation, and deployment). Keep PII on that person profile instead
 * of copying it onto every event payload.
 * The client also honors VITE_DISABLE_POSTHOG_LOCAL via
 * opt_out_capturing_by_default — no disabled-state branching needed here.
 */
export function track(
  event: ClientAnalyticsEventName,
  props: Record<string, unknown> & { location?: string } = {}
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
  try {
    posthog.capture(event, {
      ...rest,
      ...standardEventProps(location),
      // Billing identifiers must stay opaque. An explicit null overrides the
      // raw organization_id registered as a PostHog super-property without
      // changing organization context for unrelated product events.
      ...(mustRedactOrganizationContext(event)
        ? { organization_id: null }
        : {}),
    });
  } catch (error) {
    // Product analytics is best-effort. Ad blockers, initialization races, or
    // an SDK failure must never stop the user action that emitted the event.
    // Keep the failure observable without including event props, which may
    // contain sensitive product data.
    console.warn(`[analytics] Failed to capture ${event}`, error);
  }
}
