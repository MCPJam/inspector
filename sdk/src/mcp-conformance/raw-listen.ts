/**
 * Raw observation of a long-lived `subscriptions/listen` stream (Phase 7
 * §15.3, subscription MUSTs).
 *
 * `raw-http.ts` deliberately buffers a bounded exchange, and
 * {@link createCapturingFetch} reads the response body to completion to
 * capture it — neither can hold a listen stream open, and its own module
 * docstring says so. This is the second seam that docstring points at: it
 * drives ONE `subscriptions/listen` request and reads the SSE body
 * INCREMENTALLY, recording each frame in wire order until the subscription
 * completes, the stream ends, or a bounded observation window elapses.
 *
 * Why the wire and not the official client: the three facts the subscription
 * checks assert — that the acknowledgement precedes every notification, that
 * every message carries the subscription-id tag, and that a graceful close
 * delivers the completion result — are all consumed and normalized away
 * before app code sees them. `McpSubscription` exposes the honored filter and
 * a `closed` promise; it does not expose frame ORDER, the `_meta` tag, or the
 * completion result as separate observable facts. Only the frames prove them.
 *
 * Everything here is bounded: a conformance run must never hang on a stream a
 * server keeps open forever, so observation stops on the first of
 * (completion result | stream end | idle window | overall deadline) and then
 * aborts the request.
 */

import { SUBSCRIPTION_ID_META_KEY } from "../mcp-client-manager/subscription-coordinator.js";
import type { RawHttpCheckContext } from "./types.js";
import {
  getWireField,
  parseSseEvents,
  type RawSseEvent,
} from "./raw-capture.js";
import { baseHeaders, modernHeaders, modernRequestBody } from "./raw-http.js";

/** The `subscriptions/listen` method name, spelled once. */
export const LISTEN_METHOD = "subscriptions/listen";

/** The acknowledgement a conforming server emits before anything else. */
export const SUBSCRIPTION_ACK_METHOD =
  "notifications/subscriptions/acknowledged";

/**
 * Change-notification methods a subscription can carry, mapped to the filter
 * member that requests them. A method outside this map is neither a change
 * notification nor the ack, so the filter assertion ignores it (a server may
 * legitimately carry unrelated protocol traffic on the stream).
 */
export const SUBSCRIPTION_NOTIFICATION_FILTER_KEYS = {
  "notifications/tools/list_changed": "toolsListChanged",
  "notifications/prompts/list_changed": "promptsListChanged",
  "notifications/resources/list_changed": "resourcesListChanged",
  "notifications/resources/updated": "resourceSubscriptions",
} as const satisfies Record<string, keyof SubscriptionFilterWire>;

export type SubscriptionNotificationMethod =
  keyof typeof SUBSCRIPTION_NOTIFICATION_FILTER_KEYS;

/** Wire shape of a `subscriptions/listen` filter (`params.notifications`). */
export interface SubscriptionFilterWire {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

/** How the observation ended. Every value is a bounded, deliberate stop. */
export type ListenObservationOutcome =
  /** The completion result for the listen request arrived (graceful close). */
  | "completed"
  /** The body ended cleanly with no completion result. */
  | "stream-ended"
  /** The window elapsed while the stream was still open and healthy. */
  | "still-open"
  /** The response was not an SSE stream (e.g. an in-band JSON-RPC error). */
  | "not-a-stream"
  /** The body could not be read to the stopping point. */
  | "stream-error";

export interface ListenObservation {
  status: number;
  /** Response headers, names lowercased. */
  headers: Record<string, string>;
  contentType: string;
  /** The listen request's JSON-RPC id — the id a conforming server stamps. */
  subscriptionId: number;
  /** The filter the probe asked for, verbatim. */
  requestedFilter: SubscriptionFilterWire;
  outcome: ListenObservationOutcome;
  /** SSE frames in wire order (comment/keepalive frames excluded by the parser). */
  frames: RawSseEvent[];
  /** The JSON-RPC messages those frames carried, in wire order. */
  messages: Array<Record<string, unknown>>;
  /** The listen completion result, when one arrived. */
  completionResult?: Record<string, unknown>;
  /** Parsed body of a non-stream response (`outcome: "not-a-stream"`). */
  json?: unknown;
  /** Why the body could not be read (`outcome: "stream-error"`). */
  streamError?: string;
  /** How long the stream was observed for. */
  observedMs: number;
}

export interface ListenObservationOptions {
  /** JSON-RPC id for the listen request; becomes the subscription id. */
  id: number;
  filter: SubscriptionFilterWire;
  protocolVersion: string;
  /** Hard cap on the observation. Default {@link LISTEN_OBSERVATION_WINDOW_MS}. */
  maxMs?: number;
  /** Stop this long after the last frame. Default {@link LISTEN_IDLE_WINDOW_MS}. */
  idleMs?: number;
}

/**
 * Hard cap on how long one subscription probe observes a stream. A server is
 * free to keep a subscription open forever — that is the normal case — so the
 * probe, not the server, decides when it has seen enough.
 */
export const LISTEN_OBSERVATION_WINDOW_MS = 2_000;

/**
 * Quiet period that ends the observation early. A conforming server emits the
 * ack immediately, so silence this long after the last frame means the stream
 * has nothing more to show within this run.
 */
export const LISTEN_IDLE_WINDOW_MS = 400;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** The subscription-id tag a conforming server stamps on a stream message. */
export function subscriptionTagOf(message: Record<string, unknown>): unknown {
  return (
    getWireField(message, ["params", "_meta", SUBSCRIPTION_ID_META_KEY]) ??
    getWireField(message, ["result", "_meta", SUBSCRIPTION_ID_META_KEY])
  );
}

/** Whether `method` is a change notification a listen filter governs. */
export function isSubscriptionNotificationMethod(
  method: string
): method is SubscriptionNotificationMethod {
  return method in SUBSCRIPTION_NOTIFICATION_FILTER_KEYS;
}

/** Whether `filter` asked for `method` (URI-aware for resource updates). */
export function filterRequests(
  filter: SubscriptionFilterWire,
  method: SubscriptionNotificationMethod,
  uri: unknown
): boolean {
  if (method === "notifications/resources/updated") {
    return (
      typeof uri === "string" &&
      (filter.resourceSubscriptions ?? []).includes(uri)
    );
  }
  return Boolean(filter[SUBSCRIPTION_NOTIFICATION_FILTER_KEYS[method]]);
}

/** Complete SSE frames sitting in `buffer`, plus the unconsumed remainder. */
function drainFrames(buffer: string): {
  frames: RawSseEvent[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const lastDelimiter = normalized.lastIndexOf("\n\n");
  if (lastDelimiter === -1) {
    return { frames: [], rest: normalized };
  }
  const complete = normalized.slice(0, lastDelimiter + 2);
  return {
    frames: parseSseEvents(complete),
    rest: normalized.slice(lastDelimiter + 2),
  };
}

/**
 * Open one `subscriptions/listen` stream and record it frame by frame.
 *
 * The request is framed exactly like any other modern probe (full `_meta`
 * envelope, `Mcp-Method` mirror) so a conforming server never rejects it for
 * framing reasons — the point is to observe the stream, not to test the
 * envelope, which the other modern checks already do.
 */
export async function observeListenStream(
  ctx: RawHttpCheckContext,
  options: ListenObservationOptions
): Promise<ListenObservation> {
  const maxMs = options.maxMs ?? LISTEN_OBSERVATION_WINDOW_MS;
  const idleMs = options.idleMs ?? LISTEN_IDLE_WINDOW_MS;
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;

  const headers = new Headers(baseHeaders(ctx));
  for (const [name, value] of Object.entries(
    modernHeaders({
      protocolVersion: options.protocolVersion,
      method: LISTEN_METHOD,
    })
  )) {
    headers.set(name, value);
  }

  const controller = new AbortController();
  const response = await ctx.fetchFn(ctx.serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(
      modernRequestBody({
        id: options.id,
        method: LISTEN_METHOD,
        params: { notifications: options.filter },
        protocolVersion: options.protocolVersion,
      })
    ),
    signal: controller.signal,
  });

  const base = {
    status: response.status,
    headers: headersToObject(response.headers),
    contentType: response.headers.get("content-type") ?? "",
    subscriptionId: options.id,
    requestedFilter: options.filter,
  };

  if (!base.contentType.includes("text/event-stream") || !response.body) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return {
      ...base,
      outcome: "not-a-stream",
      frames: [],
      messages: [],
      json,
      observedMs: Date.now() - startedAt,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: RawSseEvent[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let completionResult: Record<string, unknown> | undefined;
  let buffer = "";
  let outcome: ListenObservationOutcome = "still-open";
  let streamError: string | undefined;

  while (completionResult === undefined) {
    const budget = Math.min(idleMs, deadline - Date.now());
    if (budget <= 0) {
      outcome = "still-open";
      break;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<"idle">((resolve) => {
      timer = setTimeout(() => resolve("idle"), budget);
    });

    let chunk: ReadableStreamReadResult<Uint8Array> | "idle";
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
      outcome = "stream-error";
      break;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (chunk === "idle") {
      outcome = "still-open";
      break;
    }
    if (chunk.done) {
      outcome = "stream-ended";
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const drained = drainFrames(buffer);
    buffer = drained.rest;
    for (const frame of drained.frames) {
      frames.push(frame);
      const message = asRecord(frame.json);
      if (!message) continue;
      messages.push(message);
      const result = asRecord(message.result);
      if (message.id === options.id && result) {
        completionResult = result;
        outcome = "completed";
      }
    }
  }

  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // The stream is already gone; the frames we collected are the evidence.
  }

  return {
    ...base,
    outcome,
    frames,
    messages,
    ...(completionResult ? { completionResult } : {}),
    ...(streamError ? { streamError } : {}),
    observedMs: Date.now() - startedAt,
  };
}
