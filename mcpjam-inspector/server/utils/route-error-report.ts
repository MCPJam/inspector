import { describeError, originOf, type NormalizedError } from "@mcpjam/sdk";
import { logger } from "./logger.js";
import {
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
): NormalizedError {
  const normalized = options.normalized ?? describeError(error);
  const { origin, captured } = maybeCaptureOriginError(error, normalized, {
    source: `route:${options.source}`,
    boundary: BOUNDARY_FOR_HOP[options.hop],
    extra: options.context,
  });

  logger.error(message, error, {
    ...options.context,
    source: options.source,
    hop: options.hop,
    // Recorded on the Axiom row so the "how much are we NOT paging on, and
    // was that right?" question is answerable without re-deriving it.
    origin,
    slug: normalized.slug,
    captured,
  });

  return normalized;
}

/**
 * `reportRouteFailure` for a site that also serializes `normalized` /`origin`
 * into its response body, returning both so the caller doesn't classify twice.
 */
export function reportRouteFailureForResponse(
  message: string,
  error: unknown,
  options: RouteFailureOptions,
): { normalized: NormalizedError; origin: ReturnType<typeof originOf> } {
  const normalized = reportRouteFailure(message, error, options);
  return { normalized, origin: originOf(normalized) };
}
