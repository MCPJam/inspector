/**
 * Redaction at the RPC capture boundary (MCP Events contract C8).
 *
 * `events/subscribe` carries the webhook signing secret in
 * `params.delivery.secret`. `wrapTransportForLogging` hands every outgoing
 * frame to the RPC logger, and from there a frame reaches the wire-log bus,
 * replay buffers, hosted RPC logs, exports and CLI output — five places a
 * secret must never land. Redacting in each consumer would be five chances to
 * forget one, so the logger is handed a sanitized COPY instead, once, before
 * any consumer sees it. The frame passed to the real transport is never
 * touched: the server must receive the exact secret, and a signature test
 * over the raw body must see the bytes that were signed.
 *
 * Cost discipline: this runs on every frame of every connection. The common
 * case (a frame with no `delivery` and no `events/*` method) is decided by
 * two property reads and returns the input BY IDENTITY — no copy, no walk.
 */

import { redactUrlSecrets } from "../conformance-redaction.js";

export const REDACTED_WEBHOOK_SECRET = "whsec_<redacted>" as const;

/**
 * A Standard Webhooks secret ANYWHERE in a string — not only a whole-string
 * match: a server rejecting a secret quotes it inside prose ("refusing
 * delivery.secret whsec_…"), and that sentence is exactly what ends up in an
 * error log.
 */
const WHSEC_SUBSTRING = /whsec_[A-Za-z0-9+/=_-]{8,}/g;

/** Deep-walk budget for `events/*` frames: enough for any real payload. */
const MAX_WALK_NODES = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventsMethod(method: unknown): boolean {
  return (
    typeof method === "string" &&
    (method.startsWith("events/") || method.startsWith("notifications/events/"))
  );
}

/**
 * Replace every `whsec_` string in a JSON value. Bounded: past the node
 * budget the remaining subtree is replaced wholesale rather than logged
 * unexamined — over-redacting a pathological frame is the safe failure.
 */
function redactSecretsDeep(value: unknown, budget: { left: number }): unknown {
  if (budget.left-- <= 0) return "<redacted:unexamined>";
  if (typeof value === "string") {
    return value.includes("whsec_")
      ? value.replace(WHSEC_SUBSTRING, REDACTED_WEBHOOK_SECRET)
      : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const redacted = redactSecretsDeep(entry, budget);
      if (redacted !== entry) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const redacted = redactSecretsDeep(entry, budget);
      if (redacted !== entry) changed = true;
      next[key] = redacted;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * `params.delivery` on ANY request, method-independent: a future method (or a
 * misspelled one a debugger is poking at) that carries a callback secret is
 * redacted by shape, not by a method allowlist that would lag behind it.
 */
function redactDelivery(delivery: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...delivery };
  if ("secret" in next) next.secret = REDACTED_WEBHOOK_SECRET;
  if (typeof next.url === "string") next.url = redactUrlSecrets(next.url);
  return next;
}

/**
 * Returns a copy of `message` that is safe to hand to any logger, or
 * `message` itself when nothing in it needs redacting.
 *
 * Stateless: it cannot tell which request a RESULT answers, so results are
 * left alone here. {@link createRpcLogRedactor} adds the id correlation that
 * lets a response to an `events/*` request be walked too.
 */
export function redactRpcMessageForLog<T>(message: T): T {
  if (!isRecord(message)) return message;
  const method = message.method;
  const params = message.params;
  const hasDelivery = isRecord(params) && isRecord(params.delivery);

  let next: Record<string, unknown> = message;
  if (hasDelivery || isEventsMethod(method)) {
    let nextParams: unknown = params;
    if (hasDelivery) {
      nextParams = {
        ...(params as Record<string, unknown>),
        delivery: redactDelivery(
          (params as Record<string, unknown>).delivery as Record<string, unknown>
        ),
      };
    }
    if (isEventsMethod(method)) {
      nextParams = redactSecretsDeep(nextParams, { left: MAX_WALK_NODES });
    }
    next = { ...next, params: nextParams };
  }
  // Error responses are small, and a server rejecting a bad secret is exactly
  // the one likely to quote it back ("delivery.secret 'whsec_…' is not
  // valid"). Always walked.
  if (message.error !== undefined) {
    const error = redactSecretsDeep(message.error, { left: MAX_WALK_NODES });
    if (error !== message.error) next = { ...next, error };
  }
  return next as T;
}

/** Bound on correlated in-flight `events/*` ids per connection. */
const MAX_TRACKED_IDS = 256;

/**
 * A per-connection redactor: {@link redactRpcMessageForLog} plus id
 * correlation, so the RESULT of an `events/*` request is walked as well
 * (without stringifying every tool result on the connection to find out).
 */
export function createRpcLogRedactor(): (
  direction: "send" | "receive",
  message: unknown
) => unknown {
  const pending = new Set<string>();
  return (direction, message) => {
    if (!isRecord(message)) return message;
    const id = message.id;
    if (
      direction === "send" &&
      id !== undefined &&
      id !== null &&
      isEventsMethod(message.method)
    ) {
      if (pending.size >= MAX_TRACKED_IDS) pending.clear();
      pending.add(String(id));
    }
    const redacted = redactRpcMessageForLog(message);
    if (
      direction === "receive" &&
      message.method === undefined &&
      id !== undefined &&
      id !== null &&
      pending.delete(String(id)) &&
      message.result !== undefined
    ) {
      const result = redactSecretsDeep(message.result, {
        left: MAX_WALK_NODES,
      });
      if (result !== message.result) {
        return { ...(redacted as Record<string, unknown>), result };
      }
    }
    return redacted;
  };
}
