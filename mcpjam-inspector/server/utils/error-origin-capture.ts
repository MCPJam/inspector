import * as Sentry from "@sentry/node";
import { originOf, type ErrorOrigin, type NormalizedError } from "@mcpjam/sdk";

/**
 * ONE capture decision for every server error envelope.
 *
 * Background: `/api/web/*` routes *return* their error envelopes rather than
 * throwing (`web.onError` converts every throw into a `webError` response and
 * never rethrows), so `app.onError -> logger.error -> Sentry` is unreachable
 * for the whole hosted surface. Hosted connect 502s were Axiom-only and
 * Sentry-blind. Meanwhile the `/api/mcp/*` routes call `logger.error` in ~30
 * catch blocks, and `logger.error` captures unconditionally — so a user's dead
 * MCP server pages us today. Blindness and noise are two halves of the same
 * accident, and both are fixed by asking one question at the envelope: whose
 * fault is this?
 *
 * Policy: capture `origin === "mcpjam"` and nothing else.
 *
 * Not even `ambiguous` at warning level. The shipped taxonomy deliberately
 * puts every timeout, reset, and fetch failure in `ambiguous` — on hosted that
 * bucket is dominated by flaky user servers, and this project has effectively
 * zero production events today. Flooding it with warnings on day one would
 * bury the signal this helper exists to create. `ambiguous` volume is measured
 * for free in Axiom instead (`http.request.failed` now carries `origin` and
 * `slug`), so promoting it later is a data decision rather than a guess.
 */

/**
 * Capture-dedupe stamp.
 *
 * A single failure commonly passes two capture points: a route logs it
 * (`logger.error`) and then serializes it into an envelope (`jsonError`), both
 * holding the same object. Symbol-keyed and non-enumerable so it never reaches
 * a JSON body, a log payload, or a structured clone.
 */
const CAPTURE_STAMP = Symbol.for("mcpjam.errorOriginCaptureHandled");

type Stampable = Record<PropertyKey, unknown>;

function isStampable(value: unknown): value is Stampable {
  return typeof value === "object" && value !== null;
}

/**
 * Mark a value as "capture already decided". Non-enumerable and
 * non-writable-by-accident; a frozen or exotic object silently declines the
 * stamp rather than throwing — stamping is an optimization, and failing to
 * stamp can only cost a duplicate event, never correctness.
 */
export function markOriginCaptureHandled(value: unknown): void {
  if (!isStampable(value)) return;
  try {
    Object.defineProperty(value, CAPTURE_STAMP, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen/sealed/proxy-trapped target. Nothing to do.
  }
}

/**
 * Return a value the stamp can actually attach to.
 *
 * `throw "failure"` and `Promise.reject(null)` are legal, and a primitive
 * cannot carry a symbol property. Without this, the capture decision for such
 * a throw would be invisible to every later reader: a declined user-fault
 * primitive would still be captured by `logger.error` (the noise this exists
 * to remove), and an escalated MCPJam-fault one would be captured twice.
 *
 * Deliberately NOT solved with a set of "recently handled values": primitives
 * are compared by value, so two unrelated failures that both threw
 * `"failure"` would dedupe against each other and the second would vanish.
 *
 * The wrapper preserves `String(value)` as its message, so classification and
 * the Axiom row read identically to the raw throw. Objects are returned
 * unchanged — identity matters for the `.cause` walk.
 */
export function ensureStampable(value: unknown): unknown {
  if (isStampable(value)) return value;
  return new Error(String(value));
}

/** How far to walk a `.cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when this error (or anything in its cause chain, or its memoized
 * `normalized` block) has already been through a capture decision.
 *
 * The cause walk matters because `mapRuntimeError` constructs a *fresh*
 * `WebRouteError` for a non-`WebRouteError` input: the stamp lives on the
 * original, and only the `cause` link this module also sets makes it
 * reachable. The `normalized` check covers the mirror case — a `WebRouteError`
 * carries the same `NormalizedError` object across repeated `mapRuntimeError`
 * calls, so stamping the block dedupes even when the error identity changed.
 */
export function isOriginCaptureHandled(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isStampable(current) || seen.has(current)) return false;
    seen.add(current);
    if (current[CAPTURE_STAMP] === true) return true;
    const normalized = current.normalized;
    if (isStampable(normalized) && normalized[CAPTURE_STAMP] === true) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `rawMessage` is already redacted by the describer, but not bounded — an MCP
 * server can return an arbitrarily large body that ends up quoted into the
 * message.
 */
const MAX_EXTRA_CHARS = 2000;

export type OriginCaptureSource =
  // Envelopes.
  | "web.mapRuntimeError"
  | "mcp.jsonError"
  | "mcp.localRouteError"
  | "v1.mapErrorToV1"
  // Hand-rolled error paths that never reach an envelope.
  | "mcp.chat-v2.request"
  | "mcp.chat-v2.stream"
  | "mcp.list-tools"
  | "app.onError"
  // Individual route catch-sites, via `reportRouteFailure`. Free-form by
  // design: there are ~70 of them, and an exhaustive union would be churn
  // without safety — the value is a Sentry tag, not a branch condition.
  | `route:${string}`;

/**
 * Caller-declared boundary, for the sites where the slug alone is not the
 * whole story.
 *
 * `"mcpjam_internal"` means: the hop that failed was MCPJam's own code or
 * MCPJam's own infrastructure, not the user's MCP server. It promotes
 * `ambiguous` — and only `ambiguous` — to a capture, because `ambiguous` is
 * where `internal/unknown` lands, and `internal/unknown` raised inside our own
 * request handler is our bug by default. It deliberately does NOT promote
 * `user_server` or `user_config`: those slugs carry positive evidence about
 * who owns the failure, and a boundary declaration should not overrule
 * evidence.
 *
 * Use it only where the failing hop is genuinely ours. On a route that
 * proxies to a user-supplied MCP server, the honest answer is no declaration.
 */
export type OriginCaptureBoundary = "mcpjam_internal";

export type OriginCaptureDecision = {
  origin: ErrorOrigin;
  /** Catalog slug, for the Axiom-side origin measurement. */
  slug?: string;
  /** Whether this call sent an event to Sentry. */
  captured: boolean;
};

/**
 * Decide, once, whether an error is MCPJam's fault and page on it if so.
 *
 * Returns the decision so callers can attach `origin`/`slug` to the response
 * envelope and to `webErrorMeta` — the measurement half of this change is as
 * important as the capture half, and it is free.
 *
 * Always safe to call twice on the same error: the second call short-circuits
 * on the stamp and reports `captured: false`.
 */
export function maybeCaptureOriginError(
  raw: unknown,
  normalized: NormalizedError | undefined,
  options: {
    source: OriginCaptureSource;
    boundary?: OriginCaptureBoundary;
    extra?: Record<string, unknown>;
  },
): OriginCaptureDecision {
  const declared = originOf(normalized);
  const slug = normalized?.slug;
  const origin =
    declared === "ambiguous" && options.boundary === "mcpjam_internal"
      ? "mcpjam"
      : declared;

  if (isOriginCaptureHandled(raw)) {
    return { origin, slug, captured: false };
  }

  // Stamp regardless of the verdict. "We looked at this and decided not to
  // page" must dedupe exactly as strongly as "we paged", or a downstream
  // `logger.error` would re-capture the user-fault error this helper just
  // declined — which is the noise half of the problem.
  markOriginCaptureHandled(raw);
  markOriginCaptureHandled(normalized);

  if (origin !== "mcpjam") {
    return { origin, slug, captured: false };
  }

  Sentry.captureException(raw instanceof Error ? raw : new Error(String(raw)), {
    tags: {
      error_origin: origin,
      ...(slug ? { error_slug: slug } : {}),
      capture_source: options.source,
      ...(options.boundary ? { error_boundary: options.boundary } : {}),
    },
    extra: {
      source: options.source,
      // Kept distinct from the effective origin so a triager can see when a
      // capture happened because of a boundary declaration rather than the
      // catalog.
      declaredOrigin: declared,
      ...(slug ? { slug } : {}),
      ...(normalized?.rawMessage
        ? { rawMessage: normalized.rawMessage.slice(0, MAX_EXTRA_CHARS) }
        : {}),
      ...(options.extra ?? {}),
    },
  });

  return { origin, slug, captured: true };
}
