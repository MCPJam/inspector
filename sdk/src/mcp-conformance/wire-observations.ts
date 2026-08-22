/**
 * The run-wide record of what actually came off the wire.
 *
 * WHY THIS EXISTS. Before it, "everything this run observed" was not a thing
 * that existed anywhere. The raw check families (`protocol`, `security`,
 * `transport`, `modern`) run concurrently, each building its own requests and
 * reading its own responses; `ModernRunState.observed` was the closest thing
 * to a shared view and it covers exactly one family. So a check that has to
 * reason about EVERY message — which is what schema validation is — had no
 * input to read. This is that input.
 *
 * TWO FEEDS, NO OVERLAP.
 *   - The raw path records at one seam, inside `rawRequest`, so every raw
 *     probe in every family is covered by construction and a new check cannot
 *     forget to opt in.
 *   - The client path records by wrapping the fetch the official Client dials
 *     through, which is the only place its traffic is visible unnormalized
 *     (by the time a result reaches app code the client has already consumed
 *     the wire-only members a schema check exists to inspect).
 * The two never see the same exchange: `rawRequest` builds its own capturing
 * fetch over `ctx.fetchFn`, and the client wrapper sits on the Client's
 * `baseFetch`. Recording at both levels of one stack would double-count.
 *
 * CORRELATION IS THE POINT. A response validated against the generic
 * `JSONRPCMessage` union is nearly vacuous: the union's `Result` branch
 * carries `additionalProperties: {}` and requires almost nothing, so a
 * `tools/list` result missing `ttlMs` and `cacheScope` sails through. Only
 * knowing that a given response answers `tools/list` selects `ListToolsResult`
 * — which does require them. So each observation carries the METHOD of the
 * request it answers, paired by JSON-RPC id within the exchange that produced
 * it.
 */

import type { RawExchange } from "./raw-capture.js";

/** A JSON-RPC id as it appeared on the wire — including illegal values. */
export type ObservedRequestId = string | number | null | undefined;

export interface ObservedWireMessage {
  /** The message verbatim, before any normalization. */
  message: unknown;
  /**
   * The method of the request this message answers, when the recorder could
   * pair them. Absent for a notification, for a message whose id matched no
   * request in its exchange, and for anything observed without a request.
   */
  requestMethod?: string;
  /** The id carried by the message itself, for the failure report. */
  id?: ObservedRequestId;
  /**
   * Whether the REQUEST this message answers carried a determinable JSON-RPC
   * id. False for a body that did not parse as JSON, or that parsed without an
   * `id` member.
   *
   * Load-bearing for one narrow case: JSON-RPC 2.0 says an error response's id
   * "MUST be the same as the value of the id member in the Request Object" but
   * that "if there was an error in detecting the id … it MUST be Null". The
   * MCP schemas type `RequestId` as `["string","integer"]` and do not model
   * that null, so a server answering a deliberately malformed frame CORRECTLY
   * would otherwise be reported as violating the schema. Knowing whether the
   * id was detectable is what separates "answered a garbage frame properly"
   * from "dropped an id it had".
   */
  requestIdDeterminable?: boolean;
  /**
   * Set when the message paired with its request only after comparing ids
   * ACROSS types — the request sent `1` and the response echoed `"1"`, or the
   * reverse. Correlation still succeeds (see {@link sameId}), but the echo is
   * wrong: "the response MUST contain the same ID as the request", and `1` and
   * `"1"` are different JSON values. Reported by the wire check so a loose
   * pairing cannot silently absorb a real defect.
   */
  idEchoMismatch?: { sent: string | number; echoed: string | number };
  /** Human-readable provenance, e.g. `POST tools/list`. Never a verdict. */
  origin: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every JSON-RPC message an exchange's response carried, JSON body or SSE. */
function responseMessages(exchange: RawExchange): unknown[] {
  const { response } = exchange;
  if (response.sse) {
    return response.sse
      .map((event) => event.json)
      .filter((json): json is unknown => json !== undefined);
  }
  return response.json === undefined ? [] : [response.json];
}

/**
 * Ids compare by VALUE across types on purpose: JSON-RPC lets a server echo
 * `1` as `"1"`, and refusing to pair those would silently downgrade a
 * method-specific validation to the vacuous generic one — the check would go
 * quiet against exactly the servers that are loosest with the wire.
 */
function sameId(a: ObservedRequestId, b: ObservedRequestId): boolean {
  if (a === undefined || b === undefined) return false;
  // `null` means the id could not be DETECTED, not that it equals anything.
  // Two undeterminable ids are not evidence of one exchange, so treating
  // `null === null` as a match would attach a request's method to a response
  // that may answer something else entirely — and this correlation is the
  // load-bearing half of the wire check.
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

/**
 * The echo the spec actually requires: same value, same type. `sameId` is
 * deliberately looser so correlation survives a sloppy server; this is what
 * decides whether that looseness hid a defect.
 */
function idEchoMismatchOf(
  sent: ObservedRequestId,
  echoed: ObservedRequestId,
): ObservedWireMessage["idEchoMismatch"] {
  if (sent === undefined || echoed === undefined) return undefined;
  if (sent === null || echoed === null) return undefined;
  if (sent === echoed) return undefined;
  return { sent, echoed };
}

export class WireObservationRecorder {
  private readonly entries: ObservedWireMessage[] = [];

  /**
   * Record one bounded request/response exchange. The request side is read for
   * correlation only — the check judges what the SERVER sent, never what we
   * sent it.
   */
  recordExchange(exchange: RawExchange, origin?: string): void {
    const request = asRecord(exchange.request.json);
    const requestMethod =
      typeof request?.method === "string" ? request.method : undefined;
    const requestId = request?.id as ObservedRequestId;
    // A body that did not parse, or parsed without an `id`, gives the server
    // nothing to echo. `null` counts as undeterminable too: it is what a
    // client sends when it has no id to state.
    const requestIdDeterminable =
      request !== undefined && requestId !== undefined && requestId !== null;
    const label =
      origin ??
      `${exchange.request.method} ${requestMethod ?? exchange.request.url}`;

    for (const message of responseMessages(exchange)) {
      const record = asRecord(message);
      const id = record?.id as ObservedRequestId;
      this.entries.push({
        message,
        requestIdDeterminable,
        // A message with no `id` member is a notification: it answers nothing,
        // so attaching the exchange's request method would make the validator
        // grade it as that method's RESULT.
        ...(record !== undefined &&
        "id" in record &&
        sameId(id, requestId) &&
        requestMethod !== undefined
          ? { requestMethod }
          : {}),
        ...(record !== undefined && "id" in record ? { id } : {}),
        ...(record !== undefined && "id" in record && sameId(id, requestId)
          ? (() => {
              const mismatch = idEchoMismatchOf(requestId, id);
              return mismatch ? { idEchoMismatch: mismatch } : {};
            })()
          : {}),
        origin: label,
      });
    }
  }

  /**
   * Record messages read off a long-lived stream, which `recordExchange`
   * cannot cover: the capturing fetch reads a body to completion, and a
   * `subscriptions/listen` body legitimately never ends.
   */
  recordStreamMessages(
    messages: readonly unknown[],
    options: { origin: string; requestMethod?: string; requestId?: ObservedRequestId },
  ): void {
    for (const message of messages) {
      const record = asRecord(message);
      const id = record?.id as ObservedRequestId;
      this.entries.push({
        message,
        // A stream is only opened by a request the probe itself framed, so its
        // id was always determinable.
        requestIdDeterminable:
          options.requestId !== undefined && options.requestId !== null,
        ...(record !== undefined &&
        "id" in record &&
        sameId(id, options.requestId) &&
        options.requestMethod !== undefined
          ? { requestMethod: options.requestMethod }
          : {}),
        ...(record !== undefined && "id" in record ? { id } : {}),
        ...(record !== undefined &&
        "id" in record &&
        sameId(id, options.requestId)
          ? (() => {
              const mismatch = idEchoMismatchOf(options.requestId, id);
              return mismatch ? { idEchoMismatch: mismatch } : {};
            })()
          : {}),
        origin: options.origin,
      });
    }
  }

  get observations(): readonly ObservedWireMessage[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}
