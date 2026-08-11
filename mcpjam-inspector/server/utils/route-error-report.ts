import type { ErrorOrigin, NormalizedError } from "@mcpjam/sdk";
import { describeError } from "@mcpjam/sdk";
import { logger } from "./logger.js";
import {
  ensureStampable,
  maybeCaptureOriginError,
  type OriginCaptureBoundary,
} from "./error-origin-capture.js";

/**
 * What a route catch-site says about the hop that failed.
 *
 * This is the question every one of these catch blocks was silently answering
 * "MCPJam's" to, by calling `logger.error` — which captures unconditionally.
 * On a route that proxies into a user-supplied MCP server that answer is wrong
 * most of the time, and it is why #mcpjam-alerts pages on other people's
 * outages.
 *
 * - `"user_server_hop"` — the request crossed into the user's own MCP server
 *   (or its authorization server). The error catalog's verdict stands on its
 *   own; only slugs that positively identify MCPJam escalate. THIS IS THE
 *   DEFAULT for anything under `/api/mcp/*` that proxies.
 * - `"mcpjam_internal"` — the failing hop was MCPJam's own code or
 *   infrastructure: our Convex backend, our storage, our bundler, our tunnel
 *   service. An unrecognized failure here is ours by default, so `ambiguous`
 *   is promoted to a capture. It still does not overrule positive evidence —
 *   an ECONNREFUSED classified `user_config` stays quiet, which is the
 *   documented gap: an internal-infrastructure connection refusal is not
 *   captured until the classifier can tell the two apart.
 */
export type RouteFailureHop = "user_server_hop" | "mcpjam_internal";

const BOUNDARY_FOR_HOP: Record<
  RouteFailureHop,
  OriginCaptureBoundary | undefined
> = {
  user_server_hop: undefined,
  mcpjam_internal: "mcpjam_internal",
};

/**
 * A malformed request body is never MCPJam's fault, whatever the hop says.
 *
 * Several handlers call `await c.req.json()` inside the same `try` whose catch
 * declares `mcpjam_internal`. Without this, anyone holding a session could page
 * the on-call by POSTing invalid JSON: the `SyntaxError` classifies
 * `internal/unknown`, the boundary promotes it to `mcpjam`, and Sentry fires —
 * precisely the false attribution this whole change removes, arriving through
 * the fix for it.
 *
 * Handled here rather than by restructuring each handler because it is a
 * property of the ERROR, not of any one route: a body-parse failure cannot be
 * ours no matter where it is caught, and a rule in one place also covers the
 * catch-sites nobody has audited yet.
 *
 * Narrow on purpose. Only `SyntaxError` — a real syntax error in our own
 * shipped code would be a load-time failure, not something a request handler
 * catches at runtime.
 */
function isClientInputFault(error: unknown): boolean {
  return error instanceof SyntaxError;
}

export type RouteFailureOptions = {
  /**
   * Stable identifier for this catch-site, e.g. `"mcp.resources.read"`.
   * Becomes a Sentry tag and an Axiom field.
   */
  source: string;
  /** Whose hop failed. Required — this is the decision the sweep exists to make. */
  hop: RouteFailureHop;
  /** Extra structured context, forwarded to Axiom and Sentry. */
  context?: Record<string, unknown>;
  /**
   * A describe result the caller already computed. Saves a second
   * classification pass when the route also puts `normalized` on its response.
   */
  normalized?: NormalizedError;
};

export type RouteFailureReport = {
  normalized: NormalizedError;
  /**
   * The origin the capture decision was ACTUALLY made on, including the
   * `mcpjam_internal` promotion of `ambiguous`.
   *
   * Not `originOf(normalized)`. Recomputing from the catalog drops the
   * promotion, which would let a response body and an `http.request.failed`
   * row say `ambiguous` about a failure Sentry was paged for as `mcpjam` —
   * exactly the attribution drift this work exists to remove.
   */
  origin: ErrorOrigin;
};

/**
 * Report a route failure: classify it, page only if it is MCPJam's fault, and
 * always keep the Axiom row.
 *
 * Drop-in replacement for `logger.error(message, error, context)` at any route
 * catch-site. The ordering is load-bearing: the capture decision runs FIRST so
 * it can stamp the error, after which `logger.error` skips its own
 * unconditional Sentry capture and only ships to Axiom. Calling `logger.error`
 * first would page before anyone asked whose fault the failure was — which is
 * the behavior being removed.
 */
export function reportRouteFailure(
  message: string,
  error: unknown,
  options: RouteFailureOptions,
): RouteFailureReport {
  // A primitive throw (`throw "failure"`, `Promise.reject(null)`) cannot carry
  // the capture stamp, so the decision made just below would be invisible to
  // the `logger.error` call after it — a declined user-fault primitive would
  // page anyway, and an escalated one would be captured twice. Wrap once, up
  // front, and use the SAME value for both, so the stamp survives.
  const reported = ensureStampable(error);
  const normalized = options.normalized ?? describeError(reported);
  const boundary = isClientInputFault(error)
    ? undefined
    : BOUNDARY_FOR_HOP[options.hop];
  const { origin, captured } = maybeCaptureOriginError(reported, normalized, {
    source: `route:${options.source}`,
    boundary,
    extra: options.context,
  });

  logger.error(message, reported, {
    ...options.context,
    source: options.source,
    hop: options.hop,
    // Recorded on the Axiom row so the "how much are we NOT paging on, and
    // was that right?" question is answerable without re-deriving it.
    origin,
    slug: normalized.slug,
    captured,
  });

  return { normalized, origin };
}

/**
 * Alias kept for call sites that read as "report and serialize".
 *
 * Identical to `reportRouteFailure` — it used to re-derive the origin from the
 * catalog here, which silently disagreed with the capture decision on any
 * internal-hop failure.
 */
export const reportRouteFailureForResponse = reportRouteFailure;
