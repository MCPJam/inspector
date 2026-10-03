/**
 * MCP Events (triggers) client operations — the pinned working-group draft
 * `draft@28ec35e` (see `events-ext-schemas.ts` for the pin).
 *
 * Like skills, `events/*` is on neither protocol era's method list, so the
 * schema-less `Protocol.request` overload would throw "'…' is not a spec
 * method". Every request therefore rides `requestWithSchema` with a
 * deliberately loose wire schema, and the real validation is the zod mirror in
 * `events-ext-guards.ts`.
 *
 * What this module deliberately does NOT do:
 *   - run poll loops, refresh loops or streams — that is the coordinator's job
 *     (`../events/coordinator.ts`), which owns every lifecycle transition;
 *   - choose a callback URL or hold a secret — the event inbox allocates the
 *     receiver slot and the secret before `events/subscribe` is sent (C3);
 *   - log anything. The request carries `delivery.secret`, and the only place
 *     it may be copied is the wire. Redaction happens at the RPC capture
 *     boundary (`rpc-log-redaction.ts`), never here.
 */

import { z } from "zod";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import type { ClientRequestOptions } from "./types.js";
import {
  assertEventsListResult,
  assertEventsPollResult,
  assertEventsSubscribeResult,
  assertEventsUnsubscribeResult,
  classifyEventsRpcError,
} from "./events-ext-guards.js";
import type {
  EventsListResultWire,
  EventsPollResultWire,
  EventsSubscribeResultWire,
} from "./events-ext-schemas.js";

export const EventsListMethod = "events/list" as const;
export const EventsPollMethod = "events/poll" as const;
export const EventsStreamMethod = "events/stream" as const;
export const EventsSubscribeMethod = "events/subscribe" as const;
export const EventsUnsubscribeMethod = "events/unsubscribe" as const;

export const EventsRequestMethods = [
  EventsListMethod,
  EventsPollMethod,
  EventsStreamMethod,
  EventsSubscribeMethod,
  EventsUnsubscribeMethod,
] as const;
export type EventsRequestMethod = (typeof EventsRequestMethods)[number];

export const EventsListChangedNotificationMethod =
  "notifications/events/list_changed" as const;
export const EventsActiveNotificationMethod =
  "notifications/events/active" as const;
export const EventsEventNotificationMethod =
  "notifications/events/event" as const;
export const EventsHeartbeatNotificationMethod =
  "notifications/events/heartbeat" as const;
export const EventsErrorNotificationMethod =
  "notifications/events/error" as const;
export const EventsTerminatedNotificationMethod =
  "notifications/events/terminated" as const;

/**
 * Every `notifications/events/*` method. All of them live outside both spec
 * codecs, so the official client only accepts handlers for them through the
 * three-argument schema form (see `official-sdk-client-adapter.ts`).
 */
export const EventsNotificationMethods = [
  EventsListChangedNotificationMethod,
  EventsActiveNotificationMethod,
  EventsEventNotificationMethod,
  EventsHeartbeatNotificationMethod,
  EventsErrorNotificationMethod,
  EventsTerminatedNotificationMethod,
] as const;

/** The draft's default floor on `nextPollMs` (Client SDK Guidance). */
export const DEFAULT_POLL_FLOOR_MS = 1000;

const EVENTS_WIRE_RESULT_SCHEMA = z.looseObject({});

export interface EventsCallContext {
  client: ManagedMcpClient;
  options?: ClientRequestOptions;
}

async function sendEventsRequest(
  ctx: EventsCallContext,
  method: EventsRequestMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  return ctx.client.requestWithSchema(
    { method, params },
    EVENTS_WIRE_RESULT_SCHEMA,
    ctx.options
  );
}

/** `events/list` — one page. */
export async function listEventsExt(
  ctx: EventsCallContext,
  params?: { cursor?: string }
): Promise<EventsListResultWire> {
  const result = await sendEventsRequest(
    ctx,
    EventsListMethod,
    // Presence, not truthiness: `""` is a valid continuation cursor.
    params?.cursor !== undefined ? { cursor: params.cursor } : {}
  );
  return assertEventsListResult(result);
}

export interface EventsPollParams {
  name: string;
  arguments: Record<string, unknown>;
  /** `null` = start from now (no replay). */
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

/**
 * `events/poll` — one request. `cursor` is always SENT, as an explicit `null`
 * when there is nothing persisted: absence and `null` are equivalent by the
 * draft, and sending the explicit form keeps the wire log unambiguous.
 */
export async function pollEventsExt(
  ctx: EventsCallContext,
  params: EventsPollParams
): Promise<EventsPollResultWire> {
  const result = await sendEventsRequest(ctx, EventsPollMethod, {
    name: params.name,
    arguments: params.arguments,
    cursor: params.cursor,
    ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
    ...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {}),
  });
  return assertEventsPollResult(result);
}

export interface EventsSubscribeParams {
  name: string;
  arguments: Record<string, unknown>;
  delivery: { url: string; secret: string };
  cursor: string | null;
  maxAgeMs?: number;
  /**
   * Suggested lifetime. `undefined` = server default (field omitted);
   * `null` = request no expiry (sent as an explicit `null`).
   */
  ttlMs?: number | null;
}

/**
 * `events/subscribe` — create or refresh a webhook subscription.
 *
 * Idempotent on `(principal, delivery.url, name, arguments)`: a refresh is the
 * same call with the same key. `delivery.mode: "webhook"` is always sent — the
 * draft's example carries it and ChatGPT sends it.
 */
export async function subscribeEventsExt(
  ctx: EventsCallContext,
  params: EventsSubscribeParams
): Promise<EventsSubscribeResultWire> {
  const result = await sendEventsRequest(ctx, EventsSubscribeMethod, {
    name: params.name,
    arguments: params.arguments,
    delivery: {
      mode: "webhook",
      url: params.delivery.url,
      secret: params.delivery.secret,
    },
    cursor: params.cursor,
    ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
    ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
  });
  return assertEventsSubscribeResult(result);
}

export type EventsUnsubscribeOutcome = "removed" | "already-gone";

/**
 * `events/unsubscribe` — eager cleanup.
 *
 * A second unsubscribe MAY answer `-32011 NotFound` on the wire; the client
 * treats that as "already gone", which is the outcome the caller wanted.
 * Every other error propagates.
 */
export async function unsubscribeEventsExt(
  ctx: EventsCallContext,
  params: {
    name: string;
    arguments: Record<string, unknown>;
    delivery: { url: string };
  }
): Promise<EventsUnsubscribeOutcome> {
  try {
    const result = await sendEventsRequest(ctx, EventsUnsubscribeMethod, {
      name: params.name,
      arguments: params.arguments,
      delivery: { mode: "webhook", url: params.delivery.url },
    });
    assertEventsUnsubscribeResult(result);
    return "removed";
  } catch (error) {
    if (
      classifyEventsRpcError(EventsUnsubscribeMethod, error)?.kind ===
      "NotFound"
    ) {
      return "already-gone";
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const WHSEC_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Generate a Standard Webhooks symmetric secret from a CSPRNG — the draft's
 * "client SDKs SHOULD generate it" rule. 32 bytes sits in the middle of the
 * 24–64 window every conforming server must accept.
 */
export function generateWebhookSecret(byteLength = 32): string {
  if (byteLength < MIN_SECRET_BYTES || byteLength > MAX_SECRET_BYTES) {
    throw new RangeError(
      `Webhook secrets must be ${MIN_SECRET_BYTES}–${MAX_SECRET_BYTES} bytes`
    );
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${WHSEC_PREFIX}${bytesToBase64(bytes)}`;
}

/**
 * Decode a `whsec_` secret to its key bytes, or `undefined` when it is not a
 * value a conforming server must accept (wrong prefix, bad base64, or outside
 * 24–64 bytes).
 */
export function decodeWebhookSecret(secret: string): Uint8Array | undefined {
  if (!secret.startsWith(WHSEC_PREFIX)) return undefined;
  const bytes = base64ToBytes(secret.slice(WHSEC_PREFIX.length));
  if (!bytes) return undefined;
  if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
    return undefined;
  }
  return bytes;
}

export function isValidWebhookSecret(secret: string): boolean {
  return decodeWebhookSecret(secret) !== undefined;
}
