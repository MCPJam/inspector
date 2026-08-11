import { z } from "zod";
import {
  describeError,
  isUnauthorized401,
  originOf,
  type NormalizedError,
} from "@mcpjam/sdk";
import { extractInsufficientScopeChallenge } from "../../utils/mcp-error-serialize.js";
import {
  markOriginCaptureHandled,
  maybeCaptureOriginError,
} from "../../utils/error-origin-capture.js";

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
  // A chatbox-scoped turn was refused by the backend when the route
  // re-resolved the authoritative runtime config (403). Deliberately
  // collapses "no such chatbox" and "no grant for this caller" into one
  // code — the anti-probing collapse the backend already performs — so the
  // browser learns "you cannot run this turn" without learning whether the
  // chatbox exists. Distinct from INTERNAL_ERROR so the client can attempt a
  // re-redeem instead of dead-ending on a generic failure banner.
  CHATBOX_ACCESS_DENIED: "CHATBOX_ACCESS_DENIED",
  // The caller's cached `accessVersion` is behind the chatbox's current one
  // (409): a rebind, mode change, or republish moved the authoritative
  // config out from under an open tab. Recoverable — re-redeem the share
  // token and replay the turn. Emitted once the backend enforces the
  // version it already advertises.
  CHATBOX_ACCESS_STALE: "CHATBOX_ACCESS_STALE",
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
  const { normalized, ...restExtras } = (extras ?? {}) as Record<
    string,
    unknown
  > & { normalized?: NormalizedError };
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
      ...(normalized
        ? { origin: originOf(normalized), slug: normalized.slug }
        : {}),
    });
  }
  return c.json(
    {
      ...restExtras,
      code,
      message,
      ...(details ? { details } : {}),
      ...(normalized ? { normalized, origin: originOf(normalized) } : {}),
    },
    status,
    // Also a HEADER, because the body does not always survive to the reader
    // that needs it. The chat client's reporter runs after the AI SDK has
    // consumed the Response into `new Error(await response.text())`, leaving
    // only the status — from which it would guess `mcpjam` for any 5xx and
    // page us for a user's own MCP server. `/api/web/chat-v2` is the primary
    // hosted chat path, so putting this on `webError` rather than on one
    // route covers every `/api/web/*` envelope at once.
    normalized ? { "x-mcpjam-error-origin": originOf(normalized) } : undefined
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
 * hop was ours calls `reportRouteFailure(..., { hop: "mcpjam_internal" })`.
 * Until a given web route does, its unclassified failures are measured in
 * Axiom (`http.request.failed` carries `origin` and `slug`) rather than paged,
 * so promoting the bucket later is a data decision.
 */
export function mapRuntimeError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) {
    // Backfill normalized on existing WebRouteErrors so onError forwarding
    // always has a rich block, even when the throwing site predates the
    // describer wiring.
    if (!error.normalized) {
      error.normalized = describeError(error);
    }
    maybeCaptureOriginError(error, error.normalized, {
      source: "web.mapRuntimeError",
      extra: { status: error.status, code: error.code },
    });
    return error;
  }

  const routeError = classifyRuntimeError(error);
  attachCause(routeError, error);
  maybeCaptureOriginError(routeError, routeError.normalized, {
    source: "web.mapRuntimeError",
    extra: { status: routeError.status, code: routeError.code },
  });
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

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new WebRouteError(504, ErrorCode.TIMEOUT, message, undefined, normalized);
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
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      issue?.message ?? "Request validation failed"
    );
  }
  return parsed.data;
}
