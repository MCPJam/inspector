/**
 * The MCP event that started an agent turn, as the turn records it.
 *
 * One shape in four places: the turn trace sent to `/ingest-chat`
 * (`turnTrace.eventAtTurn`), what the backend's turn-trace readers return, the
 * live `turn_start` trace event, and each turn of the public
 * `GET /v1/chat-sessions/:id/trace` read (as `event`). Every value here is
 * identity, never payload: nothing from the event's `data` or `_meta` is ever
 * copied into it.
 *
 * Two writers build it. The hosted executor builds it from the run's frozen
 * input, and the Playground builds it from the feed entry it dispatches. Both
 * go through {@link buildEventAtTurn}, so both clip the same way and map the
 * source's origin the same way.
 */
import type { EventsFeedEntryView } from "./events-api";

/** `server`: the server sent it. `simulation`: a test event. `replay`: reserved. */
export type EventAtTurnOrigin = "server" | "simulation" | "replay";

/** How the subscription receives its events. */
export type EventDeliveryMode = "poll" | "push" | "webhook";

export interface EventAtTurn {
  /** The event's name, 1 to 512 characters. */
  name: string;
  /** The server's event id, 1 to 1,024 characters. */
  eventId?: string;
  /** When the server says the event occurred, exactly as sent; 1 to 64 characters. */
  timestamp?: string;
  /** When MCPJam received the event, in milliseconds since the epoch. */
  receivedAt: number;
  /** The subscription's delivery mode, when known. */
  delivery?: EventDeliveryMode;
  origin: EventAtTurnOrigin;
  /** MCPJam's subscription id, 1 to 256 characters. */
  subscriptionId?: string;
  /** The background trigger that ran the turn; hosted runs only. 1 to 256 characters. */
  triggerId?: string;
}

/**
 * Upper bounds in UTF-16 code units, the unit the hosted inbox counts in. Name
 * and id match what the inbox accepts, so an event it took never loses its
 * label here.
 */
export const EVENT_AT_TURN_LIMITS = {
  name: 512,
  eventId: 1024,
  timestamp: 64,
  subscriptionId: 256,
  triggerId: 256,
} as const;

const DELIVERY_MODES: readonly string[] = ["poll", "push", "webhook"];
const ORIGINS: readonly string[] = ["server", "simulation", "replay"];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `value` cut to at most `maxUnits` UTF-16 code units, at a code-point
 * boundary: a surrogate pair is kept whole or dropped whole, never split. A
 * lone surrogate already in `value` becomes U+FFFD, so the result is always
 * well-formed Unicode, which the backend requires of every stored string.
 */
export function clipAtCodePoint(value: string, maxUnits: number): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let codePoint: string;
    if (
      isHighSurrogate(code) &&
      index + 1 < value.length &&
      isLowSurrogate(value.charCodeAt(index + 1))
    ) {
      codePoint = value.slice(index, index + 2);
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      codePoint = "�";
    } else {
      codePoint = value[index]!;
    }
    if (out.length + codePoint.length > maxUnits) break;
    out += codePoint;
    index += codePoint === "�" ? 1 : codePoint.length;
  }
  return out;
}

/**
 * The record's `origin` and `delivery` from a source's origin: the feed
 * entry's, or the run snapshot's `event.origin`.
 *
 * A delivery mode (`webhook`, `poll`, `push`) is an event the server sent.
 * `simulation` and `replay` keep their origin and take the subscription's own
 * delivery mode, when it is known. Anything else is read as the server's, with
 * no delivery mode: a value this code does not know never invents one.
 */
export function eventOriginAtTurn(
  sourceOrigin: unknown,
  subscriptionMode?: unknown,
): { origin: EventAtTurnOrigin; delivery?: EventDeliveryMode } {
  if (typeof sourceOrigin === "string" && DELIVERY_MODES.includes(sourceOrigin)) {
    return { origin: "server", delivery: sourceOrigin as EventDeliveryMode };
  }
  if (sourceOrigin === "simulation" || sourceOrigin === "replay") {
    return typeof subscriptionMode === "string" &&
      DELIVERY_MODES.includes(subscriptionMode)
      ? {
          origin: sourceOrigin,
          delivery: subscriptionMode as EventDeliveryMode,
        }
      : { origin: sourceOrigin };
  }
  return { origin: "server" };
}

/** A clipped optional string; absent when missing, not a string, or empty. */
function optionalText(
  value: unknown,
  limit: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const clipped = clipAtCodePoint(value, limit);
  return clipped.length > 0 ? clipped : undefined;
}

/**
 * Whether `receivedAt` is a time the backend stores: from the epoch up to the
 * last moment a `Date` can hold (8.64e15 ms). Ingest drops an event outside
 * it, so a turn that showed one live would lose it on reload.
 */
function isStorableReceivedAt(receivedAt: number): boolean {
  return receivedAt >= 0 && !Number.isNaN(new Date(receivedAt).getTime());
}

/** What a writer knows about the event, before clipping. */
export interface EventAtTurnSource {
  name: string;
  eventId?: string | null;
  timestamp?: string | null;
  receivedAt: number;
  /** The source's origin: the feed entry's, or the snapshot's `event.origin`. */
  origin?: string | null;
  /** The subscription's delivery mode, for a test or replayed event. */
  subscriptionMode?: string | null;
  subscriptionId?: string | null;
  triggerId?: string | null;
}

/**
 * The record for one event, every string clipped to its limit. `undefined`
 * when there is no event to name: an empty name, or no receive time the
 * backend stores ({@link isStorableReceivedAt}).
 */
export function buildEventAtTurn(
  source: EventAtTurnSource,
): EventAtTurn | undefined {
  const name = optionalText(source.name, EVENT_AT_TURN_LIMITS.name);
  if (!name || !isStorableReceivedAt(source.receivedAt)) return undefined;
  const { origin, delivery } = eventOriginAtTurn(
    source.origin,
    source.subscriptionMode,
  );
  const eventId = optionalText(source.eventId, EVENT_AT_TURN_LIMITS.eventId);
  const timestamp = optionalText(
    source.timestamp,
    EVENT_AT_TURN_LIMITS.timestamp,
  );
  const subscriptionId = optionalText(
    source.subscriptionId,
    EVENT_AT_TURN_LIMITS.subscriptionId,
  );
  const triggerId = optionalText(
    source.triggerId,
    EVENT_AT_TURN_LIMITS.triggerId,
  );
  return {
    name,
    ...(eventId ? { eventId } : {}),
    ...(timestamp ? { timestamp } : {}),
    receivedAt: source.receivedAt,
    ...(delivery ? { delivery } : {}),
    origin,
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(triggerId ? { triggerId } : {}),
  };
}

/** The Playground's record for a feed entry it dispatches; no trigger id. */
export function eventAtTurnFromFeedEntry(
  entry: Pick<
    EventsFeedEntryView,
    "name" | "eventId" | "timestamp" | "receivedAt" | "origin" | "logicalSubscriptionId"
  >,
  subscriptionMode?: string,
): EventAtTurn | undefined {
  return buildEventAtTurn({
    name: entry.name ?? "",
    eventId: entry.eventId,
    timestamp: entry.timestamp,
    receivedAt: entry.receivedAt,
    origin: entry.origin,
    subscriptionMode,
    subscriptionId: entry.logicalSubscriptionId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent, `null`, or a string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * A record read off a wire (a chat request body, a backend reader), as a fresh
 * object with only the fields above, every string clipped. `undefined` when
 * the value is not one: no name, no storable receive time, an origin or a
 * delivery mode outside its set, or an optional field of the wrong type.
 * Unknown fields are left behind.
 */
export function readEventAtTurn(raw: unknown): EventAtTurn | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    typeof raw.name !== "string" ||
    typeof raw.receivedAt !== "number" ||
    typeof raw.origin !== "string" ||
    !ORIGINS.includes(raw.origin) ||
    !(
      raw.delivery === undefined ||
      raw.delivery === null ||
      (typeof raw.delivery === "string" && DELIVERY_MODES.includes(raw.delivery))
    ) ||
    !isOptionalString(raw.eventId) ||
    !isOptionalString(raw.timestamp) ||
    !isOptionalString(raw.subscriptionId) ||
    !isOptionalString(raw.triggerId)
  ) {
    return undefined;
  }
  const event = buildEventAtTurn({
    name: raw.name,
    eventId: raw.eventId as string | null | undefined,
    timestamp: raw.timestamp as string | null | undefined,
    receivedAt: raw.receivedAt,
    subscriptionId: raw.subscriptionId as string | null | undefined,
    triggerId: raw.triggerId as string | null | undefined,
  });
  if (!event) return undefined;
  // The origin and delivery mode are already the record's own, so they are
  // copied as they are rather than mapped again from a source origin.
  return {
    ...event,
    ...(typeof raw.delivery === "string"
      ? { delivery: raw.delivery as EventDeliveryMode }
      : {}),
    origin: raw.origin as EventAtTurnOrigin,
  };
}
