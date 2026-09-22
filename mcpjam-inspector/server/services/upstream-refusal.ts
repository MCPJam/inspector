/**
 * ONE reader for a non-ok response from MCPJam's OWN backend.
 *
 * The generation adapters in this directory each had their own version of
 * `if (!response.ok) throw new Error(...)`, and every one of them flattened the
 * upstream JSON envelope — status AND `code` — into a message string. A string
 * is all `classifyRuntimeError` then has to work with, and its fallback is
 * `500 INTERNAL_ERROR`, so a backend 429 that said exactly when to come back
 * reached the caller as an MCPJam fault. That is not only the wrong answer to
 * the user: `inspector-5xx-rate`, `inspector-v1-5xx-rate` and
 * `inspector-mcpjam-fault` all count 5xx, so a customer hitting their own
 * daily allowance paged the on-call.
 *
 * The pattern copied here is the one `routes/shared/markdown-case-import.ts`
 * already uses: on a refusal the backend owns, re-emit what it said at the
 * status it said it with. The difference is that this produces a typed
 * `WebRouteError` rather than a raw `Response`, so the same refusal travels
 * both surfaces — the hosted `/api/web/*` envelope via `webErrorFromRoute`,
 * and the public `/api/v1` envelope via `mapErrorToV1` (which maps
 * `RATE_LIMITED` onto the published `RateLimited` response and forwards
 * `headers`).
 *
 * DELIBERATELY 4xx ONLY. A backend 5xx keeps whatever treatment its caller
 * already gave it — `web/swarm-generate.ts` masks it behind a correlation id
 * because the upstream message names the Convex deployment, and the eval
 * adapters let the runtime classifier see the flattened text. Changing that in
 * the same pass would move a redaction decision under cover of a status fix.
 */
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { upstreamRetryAfter } from "./swarm-agent.js";

/**
 * Upstream 4xx → the internal code a caller can branch on.
 *
 * Byte-identical to `FORWARDED_ERROR_CODES` in `routes/web/swarm-generate.ts`,
 * which this module replaces — 429 is the entry that matters, because it is
 * the one an HTTP client already knows how to retry. Unmapped 4xx fall back to
 * `VALIDATION_ERROR` rather than `INTERNAL_ERROR`: whatever the backend
 * refused, it refused the REQUEST, and answering 5xx for it is the misreport
 * this module exists to remove.
 */
const UPSTREAM_STATUS_TO_ERROR_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/**
 * Shape gate for the backend's own refusal `code` (`platform_capacity`,
 * `user_rate_limit`, `free_tier_model_restricted`, …). Same pattern
 * `web/swarm-generate.ts` uses before putting an upstream string into a log
 * dimension, and for the same reason: a body that is not that envelope (a WAF
 * interstitial, a proxy error page) must yield nothing rather than an
 * arbitrary upstream string on our wire.
 */
const UPSTREAM_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The backend refusal envelope, as far as this module reads it. */
interface UpstreamRefusalEnvelope extends Record<string, unknown> {
  ok?: unknown;
  code?: unknown;
  error?: unknown;
  retryAfterMs?: unknown;
}

/**
 * The parsed refusal envelope, or `undefined` when the body is not one.
 *
 * Recognized by SHAPE, not by content-type: the requirement is only that this
 * is the `{ok:false, code, error, …}` object the backend's HTTP routes answer
 * refusals with. Anything else — HTML, a bare string, an array — is not
 * something we can attribute to a deliberate refusal, so nothing from it
 * reaches the response.
 */
function parseRefusalEnvelope(
  bodyText: string,
): UpstreamRefusalEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const envelope = parsed as UpstreamRefusalEnvelope;
  const hasCode =
    typeof envelope.code === "string" &&
    UPSTREAM_CODE_PATTERN.test(envelope.code);
  return envelope.ok === false || hasCode ? envelope : undefined;
}

/** The backend's user-facing `error` copy, when it sent usable copy. */
function refusalCopy(
  envelope: UpstreamRefusalEnvelope | undefined,
): string | undefined {
  return typeof envelope?.error === "string" && envelope.error.length > 0
    ? envelope.error
    : undefined;
}

/**
 * `Retry-After`, preferring the header the backend actually sent.
 *
 * The header is authoritative and already shape-checked by
 * {@link upstreamRetryAfter}; `retryAfterMs` off the body is the fallback for
 * a route that answers the field without the header. Seconds, rounded UP — a
 * client that retries at `floor` retries before the window lifts and gets
 * refused a second time.
 */
function retryAfterHeaders(
  retryAfter: string | undefined,
  envelope: UpstreamRefusalEnvelope | undefined,
): Record<string, string> | undefined {
  if (retryAfter) return { "Retry-After": retryAfter };
  const ms = envelope?.retryAfterMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
    return { "Retry-After": String(Math.ceil(ms / 1000)) };
  }
  return undefined;
}

export interface UpstreamRefusal {
  /** The upstream HTTP status, preserved onto our own response. */
  status: number;
  /** The raw upstream body. Read for its envelope; never echoed blind. */
  bodyText: string;
  /**
   * The user-facing message, when the caller already derived one (see
   * `services/swarm-generate.ts`, which applies its own redaction policy to
   * pick between the backend's copy and a generic sentence). Omit to let this
   * module prefer the envelope's `error` copy over {@link fallbackMessage}.
   */
  message?: string;
  /** Used when neither {@link message} nor the envelope carries usable copy. */
  fallbackMessage: string;
  /** Verbatim upstream `Retry-After`, if the caller already read it. */
  retryAfter?: string;
}

/**
 * A 4xx refusal the backend owns → `WebRouteError`, or `undefined` for
 * anything else (see the module doc: 5xx is the caller's decision).
 *
 * The envelope rides along in `details` rather than being re-derived by every
 * reader. That is load-bearing for the client and not just tidy: the top-up
 * dialog reads the refusal `code` and the `organizationId` out of whatever it
 * is handed (`client/src/lib/mcpjam-limit.ts`), and until now it found them
 * only by parsing the JSON that had been glued onto the message. Shape-gated,
 * so a non-envelope body contributes no `details` at all.
 */
export function upstreamRefusalRouteError(
  refusal: UpstreamRefusal,
): WebRouteError | undefined {
  if (refusal.status < 400 || refusal.status >= 500) return undefined;
  const envelope = parseRefusalEnvelope(refusal.bodyText);
  const message =
    refusal.message ?? refusalCopy(envelope) ?? refusal.fallbackMessage;
  const routeError = new WebRouteError(
    refusal.status,
    UPSTREAM_STATUS_TO_ERROR_CODE[refusal.status] ?? ErrorCode.VALIDATION_ERROR,
    message,
    envelope,
  );
  const headers = retryAfterHeaders(refusal.retryAfter, envelope);
  return headers ? routeError.withHeaders(headers) : routeError;
}

/**
 * Read a non-ok backend `Response` once and produce the error to throw.
 *
 * 4xx comes back as a {@link upstreamRefusalRouteError}; everything else keeps
 * today's shape — a plain `Error` carrying `context` plus the flattened body —
 * so the runtime classifier and each surface's 5xx handling are untouched.
 *
 * `context` is the sentence a reader sees when the backend sent no copy of its
 * own, e.g. "Failed to generate test cases".
 */
export async function upstreamRefusalFromResponse(
  response: Response,
  context: string,
): Promise<Error> {
  const bodyText = await response.text().catch(() => "");
  const routeError = upstreamRefusalRouteError({
    status: response.status,
    bodyText,
    fallbackMessage: `${context} (${response.status}).`,
    retryAfter: upstreamRetryAfter(response),
  });
  return routeError ?? new Error(`${context}: ${bodyText}`);
}
