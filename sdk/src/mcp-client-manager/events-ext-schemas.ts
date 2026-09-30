/**
 * PIN: modelcontextprotocol/experimental-ext-triggers-events @ 28ec35e905daa241f019981e2836b4a02f1c0368 (`docs/design-sketch-proposal.md`).
 * Re-diff against that commit when re-syncing.
 */
/**
 * Runtime validation for MCP Events (triggers) payloads.
 *
 * VENDORED-FROM-EVENTS-DRAFT — zod mirrors of the extension's wire shapes.
 * The working-group draft ships prose and JSONC examples rather than a
 * `schema.json`, so these mirrors are hand-derived from the draft body; the
 * `PIN` above is what a re-sync diffs against.
 *
 * Every payload here comes from an untrusted server (or, for webhook bodies,
 * from whoever can reach a public URL), and each one feeds a state machine:
 * a cursor that is persisted and replayed, a `refreshBefore` that schedules a
 * refresh, an `eventId` that deduplicates. So a `typeof` sniff is not enough —
 * a malformed `refreshBefore` that slips through becomes a refresh loop that
 * fires at `NaN`.
 *
 * Unknown keys are PASSED THROUGH (`.loose()`): a debugger must show whatever
 * the server actually sent, and the draft is still growing fields.
 *
 * ## Absent means `null`
 * The draft is explicit (*Cursor Lifecycle → Absent means `null`*): an absent
 * `cursor` MUST be treated identically to `cursor: null`, in both directions.
 * The schemas therefore accept absence; {@link normalizeCursor} is the single
 * place that turns it into `null`, so no consumer re-derives the rule.
 */

import { z } from "zod";

/** The three delivery modes the draft defines. */
export const EVENT_DELIVERY_MODES = ["poll", "push", "webhook"] as const;
export type EventDeliveryMode = (typeof EVENT_DELIVERY_MODES)[number];

/**
 * A cursor as it appears on the wire: opaque string, `null`, or absent.
 * Never interpreted by the client — only stored and replayed.
 */
const wireCursorSchema = z.string().nullable().optional();

/**
 * The single normalization point for the draft's "absent means `null`" rule.
 */
export function normalizeCursor(cursor: string | null | undefined): string | null {
  return cursor === undefined ? null : cursor;
}

/**
 * One event type, as returned by `events/list`.
 *
 * `delivery` is kept as `string[]` rather than an enum of the three known
 * modes: a server that advertises a mode this draft does not define must
 * survive parsing so the UI can show it, and the coordinator simply never
 * selects it. Non-empty is a draft rule ("any non-empty subset"), so an empty
 * list IS rejected — a type nobody can subscribe to is a server defect worth
 * naming, not an entry to render.
 */
export const eventDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    delivery: z.array(z.string().min(1)).min(1),
    inputSchema: z.looseObject({}).optional(),
    payloadSchema: z.looseObject({}).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const eventsListResultSchema = z
  .object({
    events: z.array(eventDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .loose();

/**
 * `EventOccurrence` — the entry in `events/poll` results, the params of
 * `notifications/events/event`, and the body of a webhook event delivery.
 *
 * `timestamp` is validated as a parseable date, not as a strict RFC 3339
 * pattern: ordering is its only use here, and a debugger should show a
 * slightly-off timestamp rather than drop the event. `data` is REQUIRED and
 * must be an object (the draft types it `object`).
 */
export const eventOccurrenceSchema = z
  .object({
    eventId: z.string().min(1),
    name: z.string().min(1),
    timestamp: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "timestamp must be an ISO 8601 date-time",
      }),
    data: z.looseObject({}),
    cursor: wireCursorSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/**
 * `events/poll` result.
 *
 * `nextPollMs` is non-negative: it flows straight into a timer, and the
 * coordinator applies its own floor on top (the draft's default is 1000 ms).
 */
export const eventsPollResultSchema = z
  .object({
    events: z.array(eventOccurrenceSchema),
    cursor: wireCursorSchema,
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    nextPollMs: z.number().nonnegative().optional(),
  })
  .loose();

/** The `lastError` categories the draft fixes (never raw endpoint detail). */
export const DELIVERY_ERROR_CATEGORIES = [
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
] as const;
export type DeliveryErrorCategory = (typeof DELIVERY_ERROR_CATEGORIES)[number];

export const deliveryStatusSchema = z
  .object({
    active: z.boolean(),
    lastDeliveryAt: z.string().nullable().optional(),
    // A string, not the enum: an unknown category must survive to be SHOWN
    // (and flagged by conformance) rather than erase the whole status.
    lastError: z.string().nullable().optional(),
    failedSince: z.string().nullable().optional(),
    throttled: z.boolean().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .loose();

/**
 * `events/subscribe` result.
 *
 * `refreshBefore` is "always present, nullable" in the draft. It is accepted
 * as absent here anyway, and {@link assertEventsSubscribeResult} reports the
 * omission as a wire error rather than inventing a grant: a client that
 * silently read "absent" as "no expiry" would stop refreshing a subscription
 * the server is about to reap.
 */
export const eventsSubscribeResultSchema = z
  .object({
    id: z.string().min(1),
    refreshBefore: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "refreshBefore must be an ISO 8601 date-time or null",
      })
      .nullable()
      .optional(),
    cursor: wireCursorSchema,
    truncated: z.boolean().optional(),
    deliveryStatus: deliveryStatusSchema.optional(),
  })
  .loose();

/** `events/unsubscribe` result — an empty object. */
export const eventsUnsubscribeResultSchema = z.looseObject({});

/** The nested JSON-RPC error carried by `terminated` / `notifications/events/error`. */
export const eventsNestedErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Webhook control envelopes (a body with a top-level `type`)
// ---------------------------------------------------------------------------

export const gapEnvelopeSchema = z
  .object({
    type: z.literal("gap"),
    cursor: wireCursorSchema,
  })
  .loose();

export const terminatedEnvelopeSchema = z
  .object({
    type: z.literal("terminated"),
    error: eventsNestedErrorSchema,
  })
  .loose();

export const verificationEnvelopeSchema = z
  .object({
    type: z.literal("verification"),
    challenge: z.string().min(1),
  })
  .loose();

// ---------------------------------------------------------------------------
// Push notifications (`notifications/events/*`)
// ---------------------------------------------------------------------------

/**
 * The SEP-2575 correlation key. Every push notification carries the JSON-RPC
 * id of its parent `events/stream` request here, so several concurrent
 * streams on one connection (stdio especially) can be demultiplexed.
 */
export const EVENTS_SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId" as const;

const pushMetaSchema = z
  .object({
    [EVENTS_SUBSCRIPTION_ID_META_KEY]: z.union([z.string(), z.number()]),
  })
  .loose();

export const eventsActiveNotificationParamsSchema = z
  .object({
    cursor: wireCursorSchema,
    truncated: z.boolean().optional(),
    _meta: pushMetaSchema,
  })
  .loose();

export const eventsEventNotificationParamsSchema = eventOccurrenceSchema.extend({
  _meta: pushMetaSchema,
});

export const eventsHeartbeatNotificationParamsSchema = z
  .object({
    cursor: wireCursorSchema,
    _meta: pushMetaSchema,
  })
  .loose();

export const eventsErrorNotificationParamsSchema = z
  .object({
    error: eventsNestedErrorSchema,
    _meta: pushMetaSchema,
  })
  .loose();

export type EventDescriptorWire = z.infer<typeof eventDescriptorSchema>;
export type EventsListResultWire = z.infer<typeof eventsListResultSchema>;
export type EventOccurrenceWire = z.infer<typeof eventOccurrenceSchema>;
export type EventsPollResultWire = z.infer<typeof eventsPollResultSchema>;
export type DeliveryStatusWire = z.infer<typeof deliveryStatusSchema>;
export type EventsSubscribeResultWire = z.infer<
  typeof eventsSubscribeResultSchema
>;
export type EventsNestedErrorWire = z.infer<typeof eventsNestedErrorSchema>;
export type GapEnvelopeWire = z.infer<typeof gapEnvelopeSchema>;
export type TerminatedEnvelopeWire = z.infer<typeof terminatedEnvelopeSchema>;
export type VerificationEnvelopeWire = z.infer<
  typeof verificationEnvelopeSchema
>;
export type EventsActiveNotificationParamsWire = z.infer<
  typeof eventsActiveNotificationParamsSchema
>;
export type EventsEventNotificationParamsWire = z.infer<
  typeof eventsEventNotificationParamsSchema
>;
export type EventsHeartbeatNotificationParamsWire = z.infer<
  typeof eventsHeartbeatNotificationParamsSchema
>;
export type EventsErrorNotificationParamsWire = z.infer<
  typeof eventsErrorNotificationParamsSchema
>;
