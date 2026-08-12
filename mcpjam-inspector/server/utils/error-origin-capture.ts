import { originOf, type ErrorOrigin, type NormalizedError } from "@mcpjam/sdk";
import {
  isOriginCaptureHandled,
  markOriginCaptureHandled,
} from "./error-capture-stamp.js";
import { captureOriginErrorToSentry } from "./logger.js";

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
 * The dedupe stamp lives in `error-capture-stamp.ts` and is re-exported here so
 * existing importers are unaffected. It is a separate module only because
 * `logger.ts` needs to read the stamp while this module needs to call into
 * `logger.ts` to capture — see the note on the capture call below.
 */
export {
  ensureStampable,
  isOriginCaptureHandled,
  markOriginCaptureHandled,
} from "./error-capture-stamp.js";

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
  }
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

  // Through `logger.ts`, never `Sentry.captureException` directly. AGENTS.md
  // makes the logger the server's single Sentry capture path so policy,
  // dedupe, and metadata cannot drift between two implementations, and this
  // module is a second capture POLICY, not a second capture MECHANISM.
  captureOriginErrorToSentry(
    raw instanceof Error ? raw : new Error(String(raw)),
    {
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
    }
  );

  return { origin, slug, captured: true };
}
