import posthog from "posthog-js";
import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { standardEventProps } from "./PosthogUtils";

const ORGANIZATION_GROUP_ONLY_EVENT_PREFIXES = [
  "billing_",
  "credit_topup_",
  "plan_limit_",
  "pricing_",
] as const;

function usesOrganizationGroupOnly(event: ClientAnalyticsEventName): boolean {
  return ORGANIZATION_GROUP_ONLY_EVENT_PREFIXES.some((prefix) =>
    event.startsWith(prefix),
  );
}

function isForbiddenBillingProperty(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "organization_id" ||
    normalized === "package_id" ||
    normalized === "price_cents" ||
    normalized === "price_paid_cents" ||
    normalized === "granted_credits" ||
    normalized === "amount_credits" ||
    normalized === "error" ||
    normalized === "error_name" ||
    normalized === "error_message" ||
    normalized.startsWith("stripe_") ||
    normalized.startsWith("invoice_") ||
    normalized === "checkout_session_id" ||
    normalized === "payment_intent_id"
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
  try {
    const organizationGroupOnlyEvent = usesOrganizationGroupOnly(event);
    const suppliedOrganizationId = organizationGroupOnlyEvent
      ? rest.organization_id
      : undefined;
    const billingOrganizationId =
      typeof suppliedOrganizationId === "string" &&
      suppliedOrganizationId.length > 0
        ? suppliedOrganizationId
        : undefined;
    const eventProperties = organizationGroupOnlyEvent
      ? Object.fromEntries(
          Object.entries(rest).filter(
            ([name]) => !isForbiddenBillingProperty(name),
          ),
        )
      : rest;
    posthog.capture(event, {
      ...eventProperties,
      ...standardEventProps(location),
      // Keep the raw id in PostHog's native organization group only. An
      // explicit null prevents the registered super-property from duplicating
      // it into every billing event's ordinary property bag.
      ...(organizationGroupOnlyEvent
        ? {
            organization_id: null,
            ...(billingOrganizationId
              ? {
                  $groups: {
                    organization: billingOrganizationId,
                  },
                }
              : {}),
          }
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
