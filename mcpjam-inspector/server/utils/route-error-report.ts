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
 * A malformed REQUEST body, thrown by {@link readRequestJson}.
 *
 * Several handlers call `await c.req.json()` inside the same `try` whose catch
 * declares `mcpjam_internal`. Without a marker, anyone holding a session could
 * page the on-call by POSTing invalid JSON: the parse error classifies
 * `internal/unknown`, the boundary promotes it to `mcpjam`, and Sentry fires —
 * precisely the false attribution this whole change removes, arriving through
 * the fix for it.
 *
 * An explicit class rather than `error instanceof SyntaxError`, because that
 * test cannot tell a REQUEST body apart from a RESPONSE body. `models.ts`
 * parses our own Convex backend's JSON inside an internal catch, and malformed
 * output from our backend IS our problem — a type-based rule would have
 * silently stopped capturing it.
 */
export class ClientInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ClientInputError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}

/**
 * Read and parse a request body, marking a parse failure as the caller's.
 *
 * Use instead of a bare `await c.req.json()` in any handler whose catch
 * declares `mcpjam_internal`.
 *
 * `T` defaults to `any` to match what `c.req.json()` already returns, so this
 * is a true drop-in — swapping it in must not silently start type-erroring
 * call sites that were compiling before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readRequestJson<T = any>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch (error) {
    throw new ClientInputError("Invalid JSON body", { cause: error });
  }
  // `null` is the ONLY parseable JSON body whose destructuring throws:
  // `const {x} = null` is a `TypeError`, an unmarked error an internal hop
  // would happily promote to a page. Rejecting it here closes that hole for
  // all ~48 call sites at once.
  //
  // Deliberately NOT `typeof parsed !== "object"`. `const {x} = 42` and
  // `const {x} = "str"` do not throw — they yield `undefined`, the handler's
  // own required-field check fires, and the caller gets the route's 400. A
  // blanket non-object guard would turn every one of those into this
  // `ClientInputError` and therefore a 500, replacing precise validation
  // responses with a generic failure. Arrays are objects and pass; a handler
  // that wants one still validates it.
  if (parsed === null || parsed === undefined) {
    throw new ClientInputError("Request body must not be null");
  }
  return parsed as T;
}

function isClientInputFault(error: unknown): boolean {
  return error instanceof ClientInputError;
}

/**
 * A failure the code DELIBERATELY answered with a 4xx.
 *
 * Routes routinely throw `new WebRouteError(400, VALIDATION_ERROR, …)` for
 * ordinary user outcomes — "No tools found for selected servers" when someone
 * generates eval tests against servers that expose none — and catch it in the
 * same block that declares `mcpjam_internal`. Those errors classify
 * `internal/unknown` (the describer reads transport shapes, not our status
 * codes), so the boundary would promote a routine validation result into a
 * page. A 4xx is a statement that the REQUEST was wrong; that is never
 * evidence of an MCPJam fault, so it blocks the promotion.
 *
 * Structural rather than `instanceof WebRouteError`: upstream HTTP errors from
 * the SDK carry a numeric `status` too, and a 404 from a user's own server
 * deserves exactly the same treatment. 5xx is untouched — that one really can
 * be ours.
 */
function isDeclaredClientOutcome(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Marker for a failure that crossed into the USER's MCP server, thrown from
 * inside a `try` whose catch declares `mcpjam_internal`.
 *
 * A catch block declares one hop, but a long handler does not have one. The
 * chat route's outer catch genuinely wraps MCPJam-owned work — config
 * resolution, backend dispatch, stream setup — yet it also receives whatever
 * `prepareChatV2` threw, and the first thing `prepareChatV2` awaits is
 * `getToolsForAiSdk` against the user's own servers. Under the boundary
 * declaration alone, every dead or slow user MCP server would page the on-call
 * through the tool-listing step: the exact false attribution this work removes,
 * arriving through the route that started it.
 *
 * Marking is per-error rather than per-catch because splitting the handler
 * would mean duplicating its 500 envelope. Symbol-keyed and non-enumerable, so
 * it never reaches a JSON body; found through the `.cause` chain, so a wrapper
 * built above it still carries the verdict.
 */
const USER_SERVER_HOP = Symbol.for("mcpjam.errorUserServerHop");

/**
 * Tag a value as having failed on a hop into the user's MCP server.
 *
 * Returns the marked value, which may be a WRAPPER: `throw "failure"`, a
 * frozen error, and a sealed error all refuse the property, and a mark that
 * silently fails is worse than no mark at all — the outer catch would declare
 * `mcpjam_internal`, promote the still-ambiguous failure, and page for
 * somebody else's server. `ensureStampable` produces a wrapper that keeps the
 * message and links the original as `cause`, so the walk below still finds
 * everything and the diagnostics are unchanged.
 */
export function markUserServerHop(error: unknown): unknown {
  const target = ensureStampable(error);
  try {
    Object.defineProperty(target, USER_SERVER_HOP, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // An exotic object that passed `ensureStampable` and still refuses the
    // property. The mark degrades to the boundary's default.
  }
  return target;
}

/** How far to walk a `.cause` chain before giving up. Mirrors the capture walk. */
const MAX_CAUSE_DEPTH = 8;

function isUserServerHopFault(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if ((current as Record<PropertyKey, unknown>)[USER_SERVER_HOP] === true) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  // Classify the ORIGINAL, never the wrapper. `describeError` reads `code` /
  // `status` off the TOP-LEVEL object and does not follow `.cause`, so
  // describing a wrapper would drop a frozen error's `code: "ECONNREFUSED"`,
  // resolve `internal/unknown`, and let an internal boundary promote somebody
  // else's dead server into a page — reintroducing the exact false
  // attribution, for the very case the wrapper exists to handle.
  const normalized = options.normalized ?? describeError(error);
  const boundary =
    isClientInputFault(error) ||
    isUserServerHopFault(error) ||
    isDeclaredClientOutcome(error)
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
