/**
 * Family 22: Events (design sketch). The capability is top-level
 * `capabilities.events`, not an `extensions` id. Error codes differ by
 * profile: MCPJam's pinned draft@28ec35e uses -32011..-32015 and the current
 * provisional sketch uses -32023..-32027. Either is accepted; summaries name
 * the profile instead of judging the server.
 */

import { DRAFT_PROFILE_ID } from "../../../events/profiles.js";
import type {
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
  ProbeSurface,
} from "../../types.js";
import {
  capabilitiesOf,
  familyFeature,
  isRecord,
  probeBlocker,
  probeBoolean,
  probeNumber,
  probeStrings,
  recordAt,
  specAt,
  unlessParentAbsent,
} from "./shared.js";

/** Delivery modes as `events/list` names them (see `events/profiles.ts`). */
type DeliveryMode = "poll" | "push" | "webhook";

const feature = familyFeature("events", "sketch");
const NO_EVENTS = "The server does not declare capabilities.events.";

function capabilityOutcome(surface: DeclaredSurface): FeatureRuleOutcome {
  const capabilities = capabilitiesOf(surface);
  if (!capabilities) {
    return {
      kind: "unknown",
      reason: "The server's capabilities were not captured.",
    };
  }
  const events = capabilities.events;
  if (events === undefined) return { kind: "absent", basis: ["capabilities"] };
  if (!isRecord(events)) {
    return {
      kind: "unknown",
      reason: "capabilities.events is not an object, so clients ignore it.",
    };
  }
  return {
    kind: "present",
    via: "advertised",
    detail:
      events.listChanged === true ? "listChanged: true" : "capabilities.events",
  };
}

function dependsOnEvents(surface: DeclaredSurface): FeatureRuleOutcome {
  return unlessParentAbsent(surface, capabilityOutcome(surface), NO_EVENTS);
}

/** Whether events/list names a delivery mode, from the `events-list` probe. */
function deliveryModeOutcome(mode: DeliveryMode) {
  return (probes: ProbeSurface): FeatureRuleOutcome => {
    const probe = probes["events-list"];
    const blocked = probeBlocker(probe, "events/list");
    if (blocked !== undefined || !probe) return blocked ?? null;
    if (probeBoolean(probe.values.listed) !== true) return null;
    const modes = probeStrings(probe.values.deliveryModes) ?? [];
    if (modes.includes(mode)) {
      return {
        kind: "present",
        // Naming a mode in the listing declares it; nothing was delivered.
        via: "advertised",
        detail: `events/list offers ${modes.join(", ")}`,
      };
    }
    if (modes.length === 0 || probe.coverage !== "complete") return null;
    return {
      kind: "absent",
      basis: [],
      detail: `events/list offers ${modes.join(", ")}`,
    };
  };
}

function observedEvent(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec">
): FeatureDefinition {
  return feature({
    ...input,
    assessment: {
      primary: "observed",
      observable: true,
      declared: dependsOnEvents,
    },
  });
}

function webhookFeature(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec">
): FeatureDefinition {
  return feature({
    parent: "events.webhooks",
    ...input,
    assessment: {
      primary: "configured",
      setup: "event-webhook",
      declared: dependsOnEvents,
    },
  });
}

const SUBSCRIBE_IN_PLAYGROUND =
  "Subscribe to one of the server's events in MCPJam and watch Tracing.";
const SET_UP_WEBHOOK =
  "Accept webhook subscriptions and deliver events to the subscriber's URL. You can subscribe a webhook from the Events tab; this page does not record deliveries yet.";

export const EVENTS_FEATURES: readonly FeatureDefinition[] = [
  feature({
    id: "events.capability",
    name: "capabilities.events (listChanged)",
    summary:
      "Tells clients the server has events they can poll, stream or receive by webhook.",
    howTo:
      "Declare a top-level capabilities.events object, with listChanged: true if your event list can change.",
    spec: specAt("events", "capability-declaration"),
    assessment: { primary: "declared", declared: capabilityOutcome },
  }),
  feature({
    id: "events.list",
    name: "events/list",
    summary:
      "Lists each event with its description, input and payload schemas, and delivery modes.",
    howTo:
      "Answer events/list with name, description, delivery, inputSchema and payloadSchema per event.",
    spec: specAt("events", "listing-available-events"),
    assessment: {
      primary: "probed",
      declared: dependsOnEvents,
      probed: (probes) => {
        const probe = probes["events-list"];
        const blocked = probeBlocker(probe, "events/list");
        if (blocked !== undefined || !probe) return blocked ?? null;
        if (probeBoolean(probe.values.listed) !== true) {
          return { kind: "unknown", reason: "events/list did not answer." };
        }
        return {
          kind: "present",
          via: "probed",
          count: probeNumber(probe.values.eventCount) ?? 0,
        };
      },
    },
  }),
  feature({
    id: "events.list-changed",
    name: "notifications/events/list_changed",
    summary: "Tells clients when the server's event list changes.",
    howTo:
      "Send notifications/events/list_changed after the event list changes.",
    spec: specAt("events", "dynamic-event-types"),
    assessment: {
      primary: "observed",
      observable: true,
      declared: (surface) => {
        const outcome = capabilityOutcome(surface);
        if (outcome?.kind !== "present") return dependsOnEvents(surface);
        const events = recordAt(capabilitiesOf(surface), "events");
        if (events?.listChanged === true) {
          return {
            kind: "unknown",
            reason:
              "The server promises list change notifications. None has been seen yet.",
          };
        }
        return { kind: "absent", basis: ["capabilities"] };
      },
    },
  }),
  feature({
    id: "events.poll",
    name: "events/poll",
    summary: "Clients fetch new occurrences with a cursor at their own pace.",
    howTo:
      "Offer poll delivery in events/list and answer events/poll.",
    spec: specAt("events", "poll-based-delivery"),
    assessment: {
      primary: "checked",
      observable: true,
      declared: dependsOnEvents,
      probed: deliveryModeOutcome("poll"),
    },
  }),
  feature({
    id: "events.stream",
    name: "events/stream with event and heartbeat notifications",
    summary: "The server pushes occurrences and heartbeats on an open stream.",
    howTo: `Offer push delivery in events/list and answer events/stream. ${SUBSCRIBE_IN_PLAYGROUND}`,
    spec: specAt("events", "push-based-delivery"),
    assessment: {
      primary: "observed",
      observable: true,
      declared: dependsOnEvents,
      probed: deliveryModeOutcome("push"),
    },
  }),
  feature({
    id: "events.webhooks",
    name: "Webhook delivery",
    summary:
      "The server delivers occurrences to a webhook the client registers.",
    howTo: SET_UP_WEBHOOK,
    spec: specAt("events", "webhook-based-delivery"),
    assessment: {
      primary: "configured",
      setup: "event-webhook",
      declared: dependsOnEvents,
      probed: deliveryModeOutcome("webhook"),
    },
  }),
  feature({
    id: "events.webhook-subscribe",
    parent: "events.webhooks",
    name: "events/subscribe (Standard Webhooks, TTL and refreshBefore)",
    summary:
      "Registers a signed webhook subscription that the client refreshes before it expires.",
    howTo: SET_UP_WEBHOOK,
    spec: specAt("events", "webhook-based-delivery"),
    assessment: {
      primary: "configured",
      setup: "event-webhook",
      declared: dependsOnEvents,
      probed: deliveryModeOutcome("webhook"),
    },
  }),
  webhookFeature({
    id: "events.endpoint-verification",
    name: "Webhook endpoint verification",
    summary:
      "The server confirms the receiver consents before delivering, by challenge, allowlist or well-known file.",
    howTo: SET_UP_WEBHOOK,
    spec: specAt("events", "webhook-security"),
  }),
  webhookFeature({
    id: "events.unsubscribe",
    name: "events/unsubscribe",
    summary: "Ends a webhook subscription.",
    howTo: SET_UP_WEBHOOK,
    spec: specAt("events", "unsubscribing"),
  }),
  webhookFeature({
    id: "events.delivery-status",
    name: "deliveryStatus",
    summary: "Reports whether recent webhook deliveries succeeded.",
    howTo: SET_UP_WEBHOOK,
    spec: specAt("events", "webhook-delivery-status"),
  }),
  observedEvent({
    id: "events.terminated",
    name: "notifications/events/terminated",
    summary: "Tells the client a subscription or stream has ended and why.",
    howTo: SUBSCRIBE_IN_PLAYGROUND,
    spec: specAt("events", "authorization"),
  }),
  observedEvent({
    id: "events.cursor-replay",
    name: "Cursor replay, maxAgeMs and truncation",
    summary:
      "Clients resume from a cursor and learn when old occurrences were dropped.",
    howTo: SUBSCRIBE_IN_PLAYGROUND,
    spec: specAt("events", "cursor-lifecycle"),
  }),
  observedEvent({
    id: "events.error-codes",
    name: "Events error codes",
    summary: `Events errors use -32011 to -32015 in MCPJam's pinned ${DRAFT_PROFILE_ID} profile or -32023 to -32027 in the current provisional sketch, and either is accepted.`,
    howTo: SUBSCRIBE_IN_PLAYGROUND,
    spec: specAt("events", "error-codes"),
  }),
];
