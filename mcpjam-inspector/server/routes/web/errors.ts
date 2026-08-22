import { z } from "zod";
import {
  describeError,
  isAuthError,
  isUnauthorized401,
  originOf,
  type ErrorOrigin,
  type NormalizedError,
} from "@mcpjam/sdk";
import { extractInsufficientScopeChallenge } from "../../utils/mcp-error-serialize.js";
import {
  markOriginCaptureHandled,
  maybeCaptureOriginError,
  type OriginCaptureBoundary,
} from "../../utils/error-origin-capture.js";
import { PROTOCOL_VERSION_PIN_SLUG } from "../../../shared/protocol-version-pin.js";

export const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  // A write rejected because the resource isn't in a state that accepts it
  // (HTTP 409) — the request was well-formed, so VALIDATION_ERROR would
  // misreport it, and retrying it verbatim won't help. Project Environments
  // report stale `expectedRevision`, duplicate live names, and archive-state
  // rejections this way; the more specific ENVIRONMENT_REVISION_CONFLICT below
  // stays for the hosted UI, and collapses onto this code publicly.
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // A billing/entitlement cap was hit (HTTP 402). The structured billing
  // payload (code "billing_limit_reached" / "billing_feature_not_included",
  // limit, allowedValue, plan, resetsAt, …) rides along in the WebRouteError
  // `details` so the client can rebuild a ConvexError and render the proper
  // upgrade message instead of a generic failure.
  BILLING_LIMIT_REACHED: "BILLING_LIMIT_REACHED",
  // A host with the enterprise-managed authorization POLICY connected an
  // `auto` server that has no stored XAA client registration. 409 (config
  // conflict), never a silent downgrade to the discover/OAuth ladder.
  // "Not configured", deliberately NOT "not enrolled": xaaConfigured proves
  // an IdP mode + client id registered at the resource authorization
  // server, not IdP enrollment — XAA_NOT_ENROLLED is reserved for the
  // future issuer-policy evaluator's denied verdicts. NOTE the local route
  // envelope (respondWithLocalRouteError) spreads `details` top-level and
  // drops `code`; clients branch on the top-level `reason:
  // "xaa_connection_not_configured"`, not this code.
  XAA_CONNECTION_NOT_CONFIGURED: "XAA_CONNECTION_NOT_CONFIGURED",
  // A project-environment eval launch resolved one environment revision but
  // the environment changed before `startTestSuiteRun` inserted the run
  // (`expectedEnvironmentRevision` mismatch, backend ENV_REVISION_CONFLICT).
  // 409; interactive callers surface "Environment changed — retry the run",
  // the scheduled worker retries through its trigger/idempotency path.
  ENVIRONMENT_REVISION_CONFLICT: "ENVIRONMENT_REVISION_CONFLICT",
  // A task read/write hit JSON-RPC -32602: the server no longer knows the
  // task. Distinct from a structureless 404 (route missing on an older
  // replica during a mixed-version rollout) and from a transient connect
  // failure, so the client can mark the handle "unavailable" instead of
  // retrying forever or dropping it.
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  // A tasks request the resolved wire cannot serve: no tasks wire at all, a
  // method that does not exist on that wire (`tasks/result` on the extension),
  // or an undeclared capability. A caller/feature error (400), never a 500.
  TASKS_UNSUPPORTED: "TASKS_UNSUPPORTED",
  // A scenario-scoped turn was refused by the backend when the route
  // re-resolved the authoritative runtime config (403). Deliberately
  // collapses "no such scenario" and "no grant for this caller" into one
  // code — the anti-probing collapse the backend already performs — so the
  // browser learns "you cannot run this turn" without learning whether the
  // scenario exists. Distinct from INTERNAL_ERROR so the client can attempt a
  // re-redeem instead of dead-ending on a generic failure banner.
  SCENARIO_ACCESS_DENIED: "SCENARIO_ACCESS_DENIED",
  // The caller's cached `accessVersion` is behind the scenario's current one
  // (409): a rebind, mode change, or republish moved the authoritative
  // config out from under an open tab. Recoverable — re-redeem the share
  // token and replay the turn. Emitted once the backend enforces the
  // version it already advertises.
  SCENARIO_ACCESS_STALE: "SCENARIO_ACCESS_STALE",
  // The USER'S MCP server refused the credentials MCPJam presented. Their
  // failure, not ours — it was the single largest error class on
  // `/api/web/tools/list` (3,706 events in 30 days) and every one of them
  // logged as INTERNAL_ERROR, spending the 5xx budget and hiding real internal
  // faults behind them.
  //
  // Served at 403, deliberately NOT 401. `authFetch` retries any 401 from an
  // `/api/web/*` path when the actor has no WorkOS session
  // (`shouldRetryApiAuth401`: `!isAuthenticated && !hasSession`) by clearing
  // the bearer cache, force-refreshing the guest session and replaying the
  // request; the hosted `webError` envelope has no way to set the
  // `X-MCP-Auth-Required: oauth` header that suppresses it (only the LOCAL
  // `respondWithLocalRouteError` does). Mapping thousands of upstream auth
  // rejections onto 401 would therefore make every guest burn a guest-token
  // refresh and a replay on a failure the replay cannot fix. 403 is also the
  // honest HTTP answer: the CALLER's credentials are not the problem, so
  // re-authenticating with MCPJam will not change the outcome — the user has
  // to reconnect the upstream server.
  UPSTREAM_AUTH_FAILED: "UPSTREAM_AUTH_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class WebRouteError extends Error {
  status: number;
  code: ErrorCode;
  details?: Record<string, unknown>;
  /**
   * Optional normalized describe-error block. When present, `webError`
   * forwards it onto the JSON response body so the client can render a
   * rich ErrorCard without re-classifying from the raw message.
   */
  normalized?: NormalizedError;
  /**
   * The EFFECTIVE origin — the catalog value after any internal-boundary
   * promotion, i.e. the same value the Sentry capture decision used.
   *
   * Distinct from `originOf(this.normalized)`, which is only the DECLARED
   * catalog value. A route that reports through an `mcpjam_internal` boundary
   * gets `mcpjam` back and pages Sentry, but the catalog slug underneath is
   * usually `ambiguous`; recomputing from `normalized` at serialization time
   * silently reports `ambiguous` for a failure we just paged ourselves for.
   * That drift is why `origin=mcpjam` never appeared in Axiom.
   *
   * Populated by `mapRuntimeError`. Absent when nothing made a capture
   * decision, in which case the declared value is the best available answer.
   */
  origin?: ErrorOrigin;

  /**
   * Response headers this error must carry to the wire.
   *
   * The body is not always enough. `Retry-After` is the case that forced this:
   * the published spec promises it on every `RateLimited` response, and the v1
   * error path had no channel for it at all — `mapErrorToV1` returned
   * `{code,message,details}` and `v1Error` called the two-argument `c.json`, so
   * a 429 that knew exactly when to come back could only say so in a details
   * field no HTTP client reads. A generic client retries on the header or not
   * at all.
   *
   * Deliberately narrow: this is for protocol headers that belong to the
   * FAILURE, not a general response-header bag. Anything a successful response
   * would also carry belongs in middleware.
   */
  headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    normalized?: NormalizedError
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.normalized = normalized;
  }

  /**
   * Attach wire headers, chainable so a throw site stays one expression:
   * `throw new WebRouteError(429, …).withHeaders({ "Retry-After": "30" })`.
   *
   * Added as a method rather than a sixth constructor parameter because
   * `normalized` already occupies the fifth slot and the overwhelming majority
   * of the ~200 throw sites pass three arguments — a positional header bag
   * behind two optionals nobody sets is a parameter no one would find.
   */
  withHeaders(headers: Record<string, string>): this {
    this.headers = { ...(this.headers ?? {}), ...headers };
    return this;
  }
}

export function webError(
  c: any,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  extras?: Record<string, unknown>
) {
  // `extras` is permissive (rpc-log collectors, etc.). If it carries a
  // `normalized` key, hoist it to the top-level response body — clients
  // pluck the rich block off the JSON envelope without re-classifying.
  const { normalized, effectiveOrigin, responseHeaders, ...restExtras } =
    (extras ?? {}) as Record<string, unknown> & {
      normalized?: NormalizedError;
      effectiveOrigin?: ErrorOrigin;
      // Destructured OUT of the body spread on purpose: everything left in
      // `restExtras` is spread into the JSON, so a header bag left in there
      // would ship as a response FIELD instead of as headers.
      responseHeaders?: Record<string, string>;
    };
  // Prefer the effective origin (post internal-boundary promotion) over the
  // declared catalog value. `originOf(normalized)` alone reports `ambiguous`
  // for failures Sentry was just paged for as `mcpjam`, which made
  // `origin=mcpjam` unreachable in Axiom and left M2 with nothing to gate on.
  const reportedOrigin = normalized
    ? effectiveOrigin ?? originOf(normalized)
    : effectiveOrigin;
  // Stash the real code/message for `requestLogContextMiddleware`. A route that
  // *returns* an error response (rather than throwing) leaves the middleware
  // with nothing but a status code, so every such 5xx used to log as the
  // catch-all "internal_error" regardless of its actual cause.
  //
  // `origin`/`slug` ride along so `http.request.failed` can be sliced by whose
  // fault the failure was. That measurement is the reason the Sentry policy can
  // afford to be strict: `ambiguous` volume is visible in Axiom for free, so
  // promoting it to a paging bucket later is a data decision rather than a
  // guess.
  if (typeof c?.set === "function") {
    c.set("webErrorMeta", {
      status,
      code,
      message,
      ...(reportedOrigin ? { origin: reportedOrigin } : {}),
      ...(normalized ? { slug: normalized.slug } : {}),
    });
  }
  return c.json(
    {
      ...restExtras,
      code,
      message,
      ...(details ? { details } : {}),
      ...(normalized ? { normalized } : {}),
      ...(reportedOrigin ? { origin: reportedOrigin } : {}),
    },
    status,
    // Also a HEADER, because the body does not always survive to the reader
    // that needs it. The chat client's reporter runs after the AI SDK has
    // consumed the Response into `new Error(await response.text())`, leaving
    // only the status — from which it would guess `mcpjam` for any 5xx and
    // page us for a user's own MCP server. `/api/web/chat-v2` is the primary
    // hosted chat path, so putting this on `webError` rather than on one
    // route covers every `/api/web/*` envelope at once.
    //
    // `responseHeaders` rides in alongside it — `Retry-After` on a 429 is the
    // only user today, and it is the same argument one level up: a generic
    // HTTP client retries on the header or not at all.
    reportedOrigin || responseHeaders
      ? {
          ...(responseHeaders ?? {}),
          ...(reportedOrigin
            ? { "x-mcpjam-error-origin": reportedOrigin }
            : {}),
        }
      : undefined
  );
}

/**
 * Send a mapped `WebRouteError` as a `webError`, WITH its normalized block.
 *
 * Exists because forgetting the last argument is silent and costly: several
 * hosted connect/auth catches called `mapRuntimeError(error)` and then passed
 * `routeError.details` but not `routeError.normalized`, so the failure was
 * classified for capture and still produced no `origin`/`slug` on
 * `http.request.failed` and no attribution in the client's error card. That is
 * the measurement half of this work quietly missing on exactly the paths the
 * reported 502s travel.
 *
 * Prefer this over calling `webError` with a mapped error by hand.
 */
export function webErrorFromRoute(
  c: any,
  routeError: WebRouteError,
  extras?: Record<string, unknown>
) {
  return webError(
    c,
    routeError.status,
    routeError.code,
    routeError.message,
    routeError.details,
    {
      ...(extras ?? {}),
      ...(routeError.normalized ? { normalized: routeError.normalized } : {}),
      // Forward the effective origin. Without this the promotion survives all
      // the way to the serializer and is then thrown away at the last step.
      ...(routeError.origin ? { effectiveOrigin: routeError.origin } : {}),
      ...(routeError.headers ? { responseHeaders: routeError.headers } : {}),
    }
  );
}

export function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Explicit connection-error patterns. The previous implementation matched the
// bare substring `"connect"`, which also catches the word `"Reconnect"` —
// causing actionable upstream errors like "Reconnect the missing server(s)"
// to surface as 502 SERVER_UNREACHABLE instead of being passed through as
// 500/4xx. Match Node's ECONN* errno family, the standard "connection X"
// phrases, and a few well-known fetch/socket failures.
// Each pattern starts with `\b` so the "econn" and "connect" substrings
// inside the word `Reconnect` don't slip through — that exact bug is what
// caused upstream attachment errors to surface as 502 SERVER_UNREACHABLE.
// The errno branch requires the full `econn` prefix (Node's ECONN* family)
// rather than `econ` so server/tool names like "Economics" don't slip
// through and re-introduce the same class of false positive.
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /\beconn[a-z]*/i,
  /\bconnection\s+(?:refused|reset|closed|timed?\s*out|aborted|error|failed)\b/i,
  /\b(?:failed|unable)\s+to\s+connect\b/i,
  /\bfetch\s+failed\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bgetaddrinfo\b/i,
];

/**
 * Preserve the original throw as a `cause` link on a mapper-constructed
 * `WebRouteError`.
 *
 * Load-bearing for capture dedupe, not just for debugging: when the input is
 * not already a `WebRouteError`, this mapper builds a brand-new error object,
 * and the capture stamp lives on the ORIGINAL. Without this link a later
 * `logger.error(originalError)` would see an unstamped object and re-capture a
 * failure the origin policy already declined. Non-enumerable, matching the
 * shape `new Error(msg, { cause })` produces, so it never leaks into a JSON
 * body.
 */
function attachCause<T extends Error>(target: T, cause: unknown): T {
  if (cause === undefined || cause === target) return target;
  if ((target as { cause?: unknown }).cause !== undefined) return target;
  try {
    Object.defineProperty(target, "cause", {
      value: cause,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen target; the dedupe degrades to a possible duplicate event.
  }
  return target;
}

export interface MapRuntimeErrorOptions {
  /**
   * Declare that the failing hop was MCPJam's own code or infrastructure.
   *
   * For a caller that owns EVERY throw reaching it — `v1.onError` fronts a
   * router where the handlers are ours and the only outbound hop is our own
   * Convex deployment — rather than a per-catch-site `reportRouteFailure`.
   * Threaded in here rather than applied by the caller afterwards because
   * `maybeCaptureOriginError` stamps an error the first time anyone asks about
   * it: a second, later call with a boundary reports `captured: false` and
   * promotes nothing, so the declaration has to travel WITH the mapping that
   * makes the decision.
   */
  boundary?: OriginCaptureBoundary;
}

/**
 * A declared boundary applies to the UNCLASSIFIED 5xx only.
 *
 * Gated on the CODE, not on the status. `mcpjam_internal` promotes `ambiguous`
 * to a page, and every other code `classifyRuntimeError` produces carries
 * positive evidence about an upstream hop — an auth refusal the MCP spec
 * defines, a pinned protocol version, a timeout, a connection error. The
 * boundary doc is explicit that a declaration must not overrule evidence, so
 * those keep their catalog origin even when the declaring caller owns the
 * router. `INTERNAL_ERROR` is the one code that asserts nothing about a hop:
 * it means we do not know what happened inside our own handler.
 *
 * The status test stays as a floor rather than an equality. Today the mapper
 * only ever pairs `INTERNAL_ERROR` with 500, so `>= 500` and `=== 500` select
 * the same set; the floor is what keeps that true if a hand-built
 * `WebRouteError(502, INTERNAL_ERROR)` ever appears, since v1 answers 500 for
 * it either way and it would otherwise go to Sentry through no path at all.
 *
 * It also keeps DELIBERATE client outcomes out. v1 handlers throw
 * `WebRouteError(404 | 403 | 400)` as their normal control flow, and those
 * reach `onError` exactly like a crash does; promoting on the declaration
 * alone would page the on-call for every not-found. A 4xx cannot pass the
 * floor, and no 4xx branch carries `INTERNAL_ERROR` anyway — two independent
 * reasons, which is the right number for a rule whose failure mode is paging
 * a human at 3am.
 */
function effectiveBoundary(
  routeError: WebRouteError,
  options: MapRuntimeErrorOptions | undefined
): OriginCaptureBoundary | undefined {
  if (options?.boundary !== "mcpjam_internal") return options?.boundary;
  return routeError.status >= 500 &&
    routeError.code === ErrorCode.INTERNAL_ERROR
    ? "mcpjam_internal"
    : undefined;
}

/**
 * DELIBERATELY no ownership inference here.
 *
 * There is a real gap: a `TypeError` thrown by a hosted web handler is
 * MCPJam's, but `describeError` resolves it to `internal/unknown` — i.e.
 * `ambiguous` — which the strict policy declines. `web.onError` converts the
 * throw into a response without rethrowing and this mapper stamps it as
 * decided, so such a bug currently reaches Sentry through no path at all.
 *
 * The tempting fix is to declare `mcpjam_internal` here for native
 * programmer-fault types. It was tried and reverted, because this mapper is a
 * SHARED envelope: it handles our own bugs and proxied user-server failures
 * with equal frequency, and it has no hop information to tell them apart. A
 * `TypeError` raised while reading a malformed tool result from somebody
 * else's MCP server satisfies exactly the same predicate, so the rule pages
 * the on-call for another person's server — the failure mode this whole change
 * exists to remove. Guessing in either direction is a guess; the policy says
 * guesses resolve toward not paging.
 *
 * The gap is closed by DECLARATION, not inference: a catch-site that knows the
 * hop was ours calls `reportRouteFailure(..., { hop: "mcpjam_internal" })`, or
 * — for a whole router whose every throw is ours — passes `options.boundary`
 * here. See {@link MapRuntimeErrorOptions}. Until a given web route does, its
 * unclassified failures are measured in Axiom (`http.request.failed` carries
 * `origin` and `slug`) rather than paged, so promoting the bucket later is a
 * data decision.
 */
export function mapRuntimeError(
  error: unknown,
  options?: MapRuntimeErrorOptions
): WebRouteError {
  if (error instanceof WebRouteError) {
    // Backfill normalized on existing WebRouteErrors so onError forwarding
    // always has a rich block, even when the throwing site predates the
    // describer wiring.
    if (!error.normalized) {
      error.normalized = describeError(error);
    }
    // Keep the EFFECTIVE origin the capture decision produced. Discarding it
    // here is what forced serialization to fall back to the declared catalog
    // value, so a promoted `mcpjam` failure logged as `ambiguous`.
    const decision = maybeCaptureOriginError(error, error.normalized, {
      source: "web.mapRuntimeError",
      boundary: effectiveBoundary(error, options),
      extra: { status: error.status, code: error.code },
    });
    // Never downgrade an origin that is already set. A boundary-less call can
    // only ever reproduce the DECLARED catalog value — remapping an error whose
    // origin was already promoted at an `mcpjam_internal` hop would otherwise
    // reset `mcpjam` back to `ambiguous`, undoing the promotion on the way to
    // the serializer.
    error.origin = error.origin ?? decision.origin;
    return error;
  }

  const routeError = classifyRuntimeError(error);
  attachCause(routeError, error);
  const decision = maybeCaptureOriginError(routeError, routeError.normalized, {
    source: "web.mapRuntimeError",
    boundary: effectiveBoundary(routeError, options),
    extra: { status: routeError.status, code: routeError.code },
  });
  routeError.origin = decision.origin;
  // Stamp the ORIGINAL as well. The cause link above makes the original
  // reachable from `routeError`, but the walk only goes that direction: a
  // handler that keeps its own reference and later calls `logger.error(error)`
  // — several do — would hand over an unstamped object and capture a second
  // time for the same failure. `attachCause` is also allowed to decline (a
  // pre-existing `cause`, a frozen target), so the link cannot be relied on
  // for dedupe on its own.
  markOriginCaptureHandled(error);
  return routeError;
}

/**
 * Did this failure come from an attempt to reach a NAMED MCP server?
 *
 * Every connect failure the SDK's `MCPClientManager` raises quotes the server
 * it was reaching — `Failed to connect to MCP server "<id>" …`,
 * `Authentication failed for MCP server "<id>" …`. Nothing else in a hosted
 * turn produces that phrase: a Convex `fetch` that dies at the socket surfaces
 * as undici's bare `TypeError("fetch failed")`, with no server in it.
 *
 * Matching MCPJam's OWN wording, not a server's. The text is authored in our
 * SDK, so a third party cannot make their error look like this one — which is
 * the property that makes a message check safe here, where the usual objection
 * (servers can say anything) would otherwise apply.
 *
 * Errs toward 502. A target-server failure raised somewhere that does not name
 * the server keeps the old status and pages us — a false page, which is the
 * direction to be wrong in: the alternative is silence during our own outage.
 */
function namesAnMcpServer(message: string): boolean {
  return /\bMCP server "/i.test(message);
}

/**
 * `mapRuntimeError` for a catch site whose failing outbound hop can only have
 * been the user's own MCP server.
 *
 * Connection-class failures leave the shared mapper as `502
 * SERVER_UNREACHABLE`, and on hosted that status is the only part of the
 * verdict that survives: Cloudflare replaces an origin 5xx with its own error
 * page, discarding the JSON envelope AND the `x-mcpjam-error-origin` header
 * `webError` attaches. The chat client is then left with a bare 5xx and falls
 * back to its documented rule — a 5xx from our own route is ours — so a user's
 * unreachable MCP server is reported as an MCPJam outage. It pages us, and it
 * tells the user MCPJam was down when their server was the thing that refused.
 *
 * `424 Failed Dependency` states what actually happened (the request was
 * well-formed; something it depends on failed) and, being a 4xx, reaches the
 * browser untouched. Any 4xx would clear the edge; 424 is the honest one.
 *
 * DECLARED, never inferred. This is deliberately a separate entry point rather
 * than a change to `mapRuntimeError`: that mapper is a shared envelope with no
 * hop information — the same connection-class branch also catches a failed
 * fetch to MCPJam's own Convex deployment (`/api/web/server-secrets` reaches
 * nothing else) and the router-wide `web.onError`, where the hop is unknown.
 * Downgrading those to a 4xx would stop paging us during our OWN outage, which
 * is a strictly worse failure than the one this fixes. So the status follows
 * the same rule the origin does: the catch site that knows the hop says so.
 *
 * The catch site declaring it is NOT sufficient on its own, though. A route's
 * outer catch spans more than its MCP work: the hosted chat turn also calls
 * `/stream/org/resolve`, which is MCPJam's own Convex deployment reached with
 * a bare `fetch` that throws a plain `TypeError("fetch failed")`. That is
 * indistinguishable, to the shared mapper, from the user's server refusing —
 * and mislabelling it would silence a page during a Convex outage AND tell the
 * user their MCP server was down. So the downgrade needs the hop to be
 * POSITIVELY identified as well as declared; see {@link namesAnMcpServer}.
 */
export function mapTargetServerError(error: unknown): WebRouteError {
  const routeError = mapRuntimeError(error);
  // Only a status this mapper CLASSIFIED. A `WebRouteError` that arrived
  // pre-built carries a status some other call site chose on purpose — and a
  // deliberate `502 SERVER_UNREACHABLE` is how a caller that knew its hop was
  // internal says so. Relabelling that as the user's dependency would undo the
  // one signal this function is trying to preserve.
  if (error instanceof WebRouteError) return routeError;
  // Mutated rather than rebuilt: `mapRuntimeError` has already stamped
  // `origin`, backfilled `normalized`, and attached the cause link the capture
  // dedupe walks. A fresh `WebRouteError` would drop all three.
  if (isTargetDependencyFailure(routeError)) {
    routeError.status = 424;
  }
  return routeError;
}

/**
 * The two classifications that mean "we could not get an answer out of the
 * user's MCP server", both of which the edge would otherwise eat.
 *
 * `504 TIMEOUT` is here for the same reason `502 SERVER_UNREACHABLE` is, and
 * leaving it out was an oversight rather than a decision: `classifyRuntimeError`
 * checks "timed out" BEFORE the connection patterns, so a target that accepts
 * the connection and then goes quiet — the commonest shape for an overloaded or
 * half-deployed server — exits as a 504 and never reaches the 502 branch.
 * Cloudflare replaces a 504 exactly as it replaces a 502, so those failures kept
 * arriving as MCPJam outages and kept paging us.
 *
 * A timeout IS weaker evidence than a refusal — silence can be our own container
 * starving or our network stalling, where `ECONNREFUSED` is the far side
 * actively saying no. `namesAnMcpServer` is what makes it safe anyway: only a
 * timeout raised while connecting to a named MCP server is downgraded, and a
 * timeout from our own hops (Convex, the backend) carries no such name, keeps
 * 504, and keeps paging. And a downgraded failure is not an invisible one — it
 * still emits `http.request.failed` with `origin` and `slug`, so if this class
 * ever turns out to be ours, that is a decision to make from the volume rather
 * than from the fear of missing it.
 */
function isTargetDependencyFailure(routeError: WebRouteError): boolean {
  if (!namesAnMcpServer(routeError.message)) return false;
  return (
    (routeError.status === 502 &&
      routeError.code === ErrorCode.SERVER_UNREACHABLE) ||
    (routeError.status === 504 && routeError.code === ErrorCode.TIMEOUT)
  );
}

/**
 * Status/code/message mapping only. Split out from `mapRuntimeError` so the
 * capture decision happens exactly once, on whichever `WebRouteError` the
 * branches below produce, instead of being duplicated down five return paths.
 */
function classifyRuntimeError(error: unknown): WebRouteError {
  const message = parseErrorMessage(error);
  const lower = message.toLowerCase();
  const normalized = describeError(error);

  // SEP-2350 runtime scope step-up. A live MCP request against the hosted
  // proxy can surface a 403 `insufficient_scope` as an upstream
  // `InsufficientScopeError` (the SDK builds the transport
  // `onInsufficientScope: "throw"`). Recognize it BEFORE the generic 500 and
  // return 403 FORBIDDEN carrying the `WWW-Authenticate` challenge in
  // `details.insufficientScope`, so `webError` forwards it and the client can
  // drive the union-scope re-authorization. This single branch covers the
  // hosted tools / resources / prompts twins, which all rethrow into `onError`.
  const insufficientScope = extractInsufficientScopeChallenge(error);
  if (insufficientScope) {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      message,
      { insufficientScope },
      normalized
    );
  }

  // A raw 401 from the target MCP server is an authorization failure, not an
  // internal error — return the honest status. No `oauthRequired` here: this
  // mapper has no per-server auth context (multi-server managers), so the
  // escalation tag is applied only where the effective auth method is known
  // (the tokenless-discover onUnauthorized handler in createAuthorizedManager
  // and the local connect executor).
  if (isUnauthorized401(error)) {
    return new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      message,
      undefined,
      normalized
    );
  }

  // Every OTHER upstream auth rejection. The branch above only recognizes a
  // clean numeric 401, but the MCP authorization spec's own error table — byte
  // identical in every version that defines authorization (2025-03-26,
  // 2025-06-18, 2025-11-25, 2026-07-28, draft) — lists 401 (authorization
  // required / token invalid), 403 (invalid scopes or insufficient
  // permissions) AND 400 (malformed authorization request). So a 403 or 400
  // rejection, or an `MCPAuthError` carrying no status at all, used to fall all
  // the way through to the 500 fallback and be reported as an MCPJam internal
  // error. Because every version's table agrees, one shared branch is correct
  // and no per-era gating applies. (2024-11-05 defines no authorization at all;
  // an auth failure there is not spec-governed, which is another reason this
  // keys off the ERROR rather than the negotiated protocol version.)
  //
  // Sits ahead of the timeout/connection branches on purpose: an `MCPAuthError`
  // raised after the Streamable HTTP + SSE fallback pair quotes BOTH transport
  // failures in one message, so a message-substring match on "fetch failed" or
  // "timed out" would otherwise outrank the auth classification the SDK already
  // made from the status codes.
  //
  // `isAuthError` rather than `instanceof MCPAuthError`: it matches by class
  // NAME (the SDK's own convention for this reason) and sees through the
  // era-negotiation wrapper, so recognition survives the server resolving
  // `@mcpjam/sdk` to `dist` while another copy resolves to `src`.
  if (isAuthError(error).isAuth) {
    return new WebRouteError(
      403,
      ErrorCode.UPSTREAM_AUTH_FAILED,
      message,
      // Established flag: "the UPSTREAM server demands auth; refreshing an
      // MCPJam session or guest token cannot change that." The local envelope
      // already turns it into `X-MCP-Auth-Required: oauth`, which is exactly
      // the retry suppression this classification wants.
      { upstreamAuthRequired: true },
      normalized
    );
  }

  // A pinned protocol version the server does not offer. Classified from the
  // SLUG, not from the wording — the describer already resolved it, and it is
  // the one signal here that cannot drift as the sentence is edited.
  //
  // 424, and ahead of every branch below, because this failure has no words
  // any of them look for: no errno, no "fetch failed", no "refused". Left to
  // fall through it lands on the 500 catch-all, and a 5xx is precisely what
  // Cloudflare replaces with its own error page — discarding the message that
  // names the version AND the `x-mcpjam-error-origin` header, so the browser
  // sees a bare 5xx and reports the user's own configuration as an MCPJam
  // outage. Writing a clearer message is what moved this class out of the
  // connection branch in the first place; the status has to follow it.
  //
  // `SERVER_UNREACHABLE` is the closest existing code — we could not use this
  // server — and the chat formatter recognizes the pinned-version case ahead
  // of the generic "may be offline" copy, so the specific message still wins.
  if (normalized.slug === PROTOCOL_VERSION_PIN_SLUG) {
    return new WebRouteError(
      424,
      ErrorCode.SERVER_UNREACHABLE,
      message,
      undefined,
      normalized
    );
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new WebRouteError(
      504,
      ErrorCode.TIMEOUT,
      message,
      undefined,
      normalized
    );
  }

  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      formatServerUnreachableMessage(message),
      undefined,
      normalized
    );
  }

  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    message.trim() || "An unexpected error occurred.",
    undefined,
    normalized
  );
}

/**
 * User-facing framing for connection-class 502s. The raw errno text
 * ("fetch failed", "ECONNRESET") reads like an MCPJam outage in the client
 * toast, when the failure is the TARGET server refusing/resetting the
 * connection — say so explicitly, and keep the raw error for debugging.
 */
export function formatServerUnreachableMessage(rawMessage: string): string {
  const raw = rawMessage.trim();
  return (
    "Couldn't reach the MCP server" +
    (raw ? ` (${raw})` : "") +
    ". The server appears to be down, restarting, or unreachable from MCPJam — this is a connection problem with the target server, not an MCPJam outage."
  );
}

export function assertBearerToken(c: any): string {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Missing or invalid bearer token"
    );
  }
  return authHeader.slice("Bearer ".length);
}

export async function readJsonBody<T>(c: any): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
}

export function parseWithSchema<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "";
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      issue
        ? path
          ? `${path}: ${issue.message}`
          : issue.message
        : "Request validation failed"
    );
  }
  return parsed.data;
}
