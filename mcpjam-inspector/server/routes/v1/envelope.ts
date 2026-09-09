/**
 * Hono glue for the v1 public envelope.
 *
 * The pure contract lives in `contract.ts` (shared, framework-agnostic). This
 * module adapts it to Hono `c.json(...)` responses and bridges the Inspector's
 * existing error classification (`mapRuntimeError` + `ErrorCode`) onto the
 * public code union, upgrading MCP auth failures to OAUTH_REQUIRED.
 */
import type { Context } from "hono";
import { describeError, isMCPAuthError, type ErrorOrigin } from "@mcpjam/sdk";
import {
  ErrorCode,
  mapRuntimeError,
  type MapRuntimeErrorOptions,
} from "../web/errors.js";
import { maybeCaptureOriginError } from "../../utils/error-origin-capture.js";
import {
  v1ErrorBody,
  v1Page,
  V1_ERROR_STATUS,
  mapInternalCode,
  type V1ErrorCode,
} from "./contract.js";
import { translateStructuredConvexRefusal } from "./convex-errors.js";

/** Canonical error response. */
export function v1Error(
  c: Context,
  code: V1ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  /**
   * Wire headers the FAILURE owns — `Retry-After` on a 429, today's only user.
   *
   * The published spec `$ref`s `RateLimited` (which documents `Retry-After`)
   * from 87 of its 88 operations, and until this parameter existed only one
   * code path in the whole product could honor it: the `sk_` branch of the
   * bearer middleware, which returns its own `c.json` and never touches this
   * envelope. Every 429 raised inside a v1 handler promised a header it had no
   * way to send.
   */
  headers?: Record<string, string>
) {
  // Backstop for the RETURNED path. `v1OnError` stashes richer meta (with
  // origin and slug) for anything that throws, but a route that returns
  // `v1Error(...)` directly never reaches it — `eval-ingest`'s TIMEOUT is a
  // 504 taking exactly that path — and those rows still logged as the bare
  // `internal_error` fallback with no message.
  //
  // Only when nothing has stashed yet, so this can never overwrite
  // `v1OnError`'s attribution: that handler sets meta and THEN calls this
  // function, and a blind write here would erase the origin one line later.
  if (typeof c?.set === "function" && !readWebErrorMeta(c)) {
    c.set("webErrorMeta", {
      // Same v1 status `v1OnError` uses, for the same reason: the middleware
      // only trusts meta whose status matches the response it observed.
      status: V1_ERROR_STATUS[code],
      code,
      message,
    });
  }
  // Cast the dynamic numeric status to satisfy Hono's literal StatusCode union
  // (the web routes sidestep this by typing `c` as `any` in `webError`).
  //
  // The third argument stays `undefined` when there are no headers rather than
  // an empty object: several route tests pass a context double whose `json`
  // only accepts two arguments, and handing them `{}` would change behavior on
  // every error path to plumb a header almost none of them carry.
  return c.json(
    v1ErrorBody(code, message, details),
    V1_ERROR_STATUS[code] as any,
    headers && Object.keys(headers).length > 0 ? headers : undefined
  );
}

/** Tolerates the non-Hono context doubles several route tests pass in. */
function readWebErrorMeta(c: Context): unknown {
  try {
    return typeof c?.get === "function"
      ? (c as { get: (k: string) => unknown }).get("webErrorMeta")
      : undefined;
  } catch {
    return undefined;
  }
}

/** Single-resource success: the resource object returned directly. */
export function v1Resource(c: Context, resource: unknown, status = 200) {
  return c.json(resource as Record<string, unknown>, status as any);
}

/** Collection success: the canonical { items, nextCursor? } page. */
export function v1PageJson<T>(c: Context, items: T[], nextCursor?: string) {
  return c.json(v1Page(items, nextCursor));
}

export type MapErrorToV1Options = MapRuntimeErrorOptions;

export interface V1ErrorMapping {
  code: V1ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** Wire headers off the underlying `WebRouteError` — see `v1Error`. */
  headers?: Record<string, string>;
  /**
   * The EFFECTIVE origin the capture decision produced, including any
   * `mcpjam_internal` promotion — not the declared catalog value, which would
   * report `ambiguous` for a failure Sentry was just paged for as `mcpjam`.
   * Returned so `v1OnError` can put it on `webErrorMeta`; the measurement half
   * of the capture policy is what keeps the paging half narrow.
   */
  origin?: ErrorOrigin;
  /** Catalog slug behind `origin`, e.g. `transport/econnrefused`. */
  slug?: string;
}

/**
 * Map any thrown error onto a public v1 code. MCP auth failures (the upstream
 * server demanding an OAuth grant) become OAUTH_REQUIRED so callers can drive
 * the grant; everything else flows through the Inspector's runtime classifier
 * and the internal->public code map.
 *
 * Hosted authorize/connect is *upstream* of the MCP SDK — it rejects a server
 * that needs OAuth before any SDK call runs, throwing
 * `WebRouteError(UNAUTHORIZED, details: { oauthRequired: true })` (see
 * `routes/web/auth.ts`). The MCP-SDK predicate above can't see those, so we
 * also promote them here. Without this branch, callers can't tell "your bearer
 * is bad" from "this server needs OAuth" — both flatten to UNAUTHORIZED.
 */
export function mapErrorToV1(
  error: unknown,
  options?: MapErrorToV1Options
): V1ErrorMapping {
  // The two branches below return BEFORE `mapRuntimeError`, which is where the
  // v1 chain would otherwise make its capture decision. Classify them here so
  // no path out of this function escapes unclassified — both are non-MCPJam in
  // practice (an upstream server demanding a grant, or not implementing a
  // primitive), so in practice this records the verdict and pages on nothing.
  //
  // They run AHEAD of the caller's boundary declaration on purpose, and this
  // ordering is the whole reason the boundary is threaded through the mapping
  // rather than declared by `v1OnError` before it. Capturing with
  // `mcpjam_internal` first would stamp these two before they were classified,
  // and an upstream server that demands OAuth or does not implement a primitive
  // would page us as an MCPJam internal failure — someone else's server, on our
  // on-call rotation. Their verdicts have to win, so they are taken first.
  if (safeIsMcpAuthError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const decision = maybeCaptureOriginError(error, describeError(error), {
      source: "v1.mapErrorToV1",
      extra: { code: "OAUTH_REQUIRED" },
    });
    return {
      code: "OAUTH_REQUIRED",
      message,
      origin: decision.origin,
      slug: decision.slug,
    };
  }
  if (isMcpMethodNotFound(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const decision = maybeCaptureOriginError(error, describeError(error), {
      source: "v1.mapErrorToV1",
      extra: { code: "FEATURE_NOT_SUPPORTED" },
    });
    return {
      code: "FEATURE_NOT_SUPPORTED",
      message,
      origin: decision.origin,
      slug: decision.slug,
    };
  }
  // A DELIBERATE backend refusal — `ConvexError({ code, message })` — is
  // translated BEFORE the runtime classifier sees it.
  //
  // The classifier has nothing to key on for one of these: a `ConvexError`
  // is not a transport failure, not an MCP error, and its `error.message` is
  // Convex's own framing wrapped around the JSON of its data. So it fell to
  // `internal/unknown`, and a refusal the backend wrote a remedy for reached
  // the caller as `500 INTERNAL_ERROR: "[Request ID: …] Server Error"` — the
  // production failure that motivated this branch, where the actual cause
  // (`ENV_MATERIALIZED_SECRETS_UNSUPPORTED`, naming the fix in its message)
  // was visible only in `convex logs --prod`.
  //
  // Routes that call `translateConvexWriteError` themselves are unaffected:
  // they throw a `WebRouteError`, which the helper declines. This is the
  // backstop for the ones that do not, and it is scoped to the boundary
  // rather than sprayed across every route.
  //
  // The translated error goes THROUGH `mapRuntimeError` rather than around
  // it so the capture decision, the origin stamp and the `normalized` block
  // are made exactly once, in the one place that makes them — and so a
  // deliberate 4xx is not paged for, like every other 4xx a v1 handler
  // throws.
  const routeError = mapRuntimeError(
    translateStructuredConvexRefusal(error) ?? error,
    options,
  );
  if (
    routeError.code === ErrorCode.UNAUTHORIZED &&
    routeError.details?.oauthRequired === true
  ) {
    return {
      code: "OAUTH_REQUIRED",
      message: routeError.message,
      details: routeError.details,
      headers: routeError.headers,
      origin: routeError.origin,
      slug: routeError.normalized?.slug,
    };
  }
  // The upstream server refused the credentials we presented. Mapped HERE
  // rather than in the shared `INTERNAL_TO_V1_CODE` table on purpose:
  // `UPSTREAM_AUTH_FAILED` is an Inspector-internal code that the Convex
  // backend never emits, and that table is a SHARED contract the backend
  // keeps a byte-identical copy of (see ./contract.ts) — pushing an
  // Inspector-only concept into it would make the two surfaces drift for a
  // value one of them can never produce. Without this branch `mapInternalCode`
  // falls through its unknown-code default and answers 500 INTERNAL_ERROR, the
  // exact misreport this classification exists to remove, on the surface the
  // CLI and the MCP worker read.
  //
  // FORBIDDEN, not OAUTH_REQUIRED: a genuine `MCPAuthError` was already
  // promoted to OAUTH_REQUIRED at the top of this function, so what reaches
  // here did NOT identify as an MCP auth failure (a transport error carrying
  // 403, or a message-pattern match) and carries no grant for the caller to
  // drive. 403 also matches the status the hosted `/api/web/*` twin returns
  // for the same throw.
  if (routeError.code === ErrorCode.UPSTREAM_AUTH_FAILED) {
    return {
      code: "FORBIDDEN",
      message: routeError.message,
      details: routeError.details,
      headers: routeError.headers,
      origin: routeError.origin,
      slug: routeError.normalized?.slug,
    };
  }
  return {
    code: mapInternalCode(routeError.code),
    message: routeError.message,
    details: routeError.details,
    headers: routeError.headers,
    origin: routeError.origin,
    slug: routeError.normalized?.slug,
  };
}

function safeIsMcpAuthError(error: unknown): boolean {
  try {
    return isMCPAuthError(error);
  } catch {
    return false;
  }
}

/**
 * MCP JSON-RPC "Method not found" (-32601): the target server doesn't
 * implement the requested primitive (e.g. `prompts/get` against a server
 * that never declared the prompts capability). The public contract reserves
 * FEATURE_NOT_SUPPORTED (422) for exactly this; without the branch it falls
 * through the runtime classifier as a 500 INTERNAL_ERROR. Duck-typed on the
 * numeric JSON-RPC code so it matches `McpError` across SDK copies.
 */
const JSONRPC_METHOD_NOT_FOUND = -32601;

function isMcpMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === JSONRPC_METHOD_NOT_FOUND
  );
}

/**
 * Hono onError handler for the v1 router.
 *
 * Two jobs beyond returning the envelope, both of which `/api/v1/*` went
 * without entirely: a CAPTURE decision, and the LOG metadata behind it.
 *
 * Capture: the v1 router's handlers are ours and its only outbound hop is our
 * own Convex deployment, so an unclassified throw reaching here is our bug by
 * default — declared with `boundary: "mcpjam_internal"`. Passed INTO the
 * mapping rather than applied around it because `maybeCaptureOriginError`
 * stamps an error the first time anyone asks; a capture bolted on after
 * `mapErrorToV1` would find the stamp already set and promote nothing. See
 * `effectiveBoundary` in `web/errors.ts` for why the declaration reaches only
 * the unclassified 500 and not the deliberate 404s v1 handlers throw as
 * ordinary control flow.
 *
 * Logging: `requestLogContextMiddleware` sees a RETURNED response, not the
 * throw (Hono runs `onError` inside `next()`), so without the stash below
 * every v1 failure row in Axiom carried the `errorCode: "internal_error"`
 * fallback with no message, origin or slug — the same blind spot `app.onError`
 * and `webError` already fixed for their surfaces.
 */
export function v1OnError(error: unknown, c: Context) {
  const { code, message, details, headers, origin, slug } = mapErrorToV1(
    error,
    { boundary: "mcpjam_internal" }
  );
  const status = V1_ERROR_STATUS[code];
  // The middleware only trusts meta whose status matches the response it
  // observed, so this has to be the v1 status — which is not always the
  // internal one the mapper started from (UPSTREAM_AUTH_FAILED is a 403 here
  // and a 502 there).
  c.set("webErrorMeta", {
    status,
    code,
    message,
    ...(origin ? { origin } : {}),
    ...(slug ? { slug } : {}),
  });
  return v1Error(c, code, message, details, headers);
}
