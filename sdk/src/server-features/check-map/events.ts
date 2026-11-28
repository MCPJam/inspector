import type { EventsCheckFeatureMap } from "./types.js";

/** Events suite check → catalog features (family 22). */
export const EVENTS_CHECK_FEATURES = {
  "events-capability-declared": ["events.capability"],
  "events-list-shape": ["events.list"],
  "events-poll-null-cursor": ["events.poll"],
  "events-subscribe-rejects-http-callback": ["events.webhook-subscribe"],
  "events-subscribe-rejects-invalid-secret": ["events.webhook-subscribe"],
  "events-subscribe-result-shape": ["events.webhook-subscribe"],
  "events-subscribe-idempotent": ["events.webhook-subscribe"],
  "events-granted-lifetime": ["events.webhook-subscribe"],
  "events-no-expiry-only-when-requested": ["events.webhook-subscribe"],
  "events-receiver-consent": ["events.endpoint-verification"],
  "events-consent-failure-blocks-delivery": ["events.endpoint-verification"],
  "events-no-redirect-follow": ["events.endpoint-verification"],
  "events-private-callback-rejected": ["events.endpoint-verification"],
  "events-delivery-signature": ["events.webhook-subscribe"],
  "events-webhook-id-equals-event-id": ["events.webhook-subscribe"],
  "events-webhook-message-id": ["events.webhook-subscribe"],
  "events-subscription-id-header": ["events.webhook-subscribe"],
  "events-delivery-content-type": ["events.webhook-subscribe"],
  "events-delivery-body-size": ["events.webhook-subscribe"],
  "events-unsubscribe-twice": ["events.unsubscribe"],
  "events-push-heartbeat": ["events.stream"],
  // ChatGPT readiness grades host compatibility (which modes, versions and
  // transports ChatGPT accepts), not a server feature. A server offering
  // another valid subset is not missing anything.
  "chatgpt-readiness-webhook-listed": "excluded",
  "chatgpt-readiness-protocol-version": "excluded",
  "chatgpt-readiness-transport": "excluded",
} as const satisfies EventsCheckFeatureMap;
