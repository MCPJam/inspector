/**
 * Refusals for a revoked AuthKit session, in each route family's envelope
 * (MJ-011). The decision itself is `checkSessionRevocation` in
 * `services/revoked-session-cache.ts`; this module only turns a refusal into
 * a response, or into a `WebRouteError` for handlers that answer through
 * `handleRoute`.
 *
 * - Revoked → 401. `/api/web` (and everything else outside `/api/v1`) answers
 *   `{ code: "SESSION_REVOKED" }`. `/api/v1` stays inside its public error-code
 *   union: `{ code: "UNAUTHORIZED", details: { reason: "SESSION_REVOKED" } }`,
 *   the same shape as its other specific 401s.
 * - Unavailable → 503 `SERVER_UNREACHABLE` with `Retry-After`: the revoked-
 *   session list is not current, and the route cannot serve a session it has
 *   not been able to check. Retrying shortly is the remedy, not signing in.
 */
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import {
  checkSessionRevocation,
  type SessionRevocationCheck,
} from "../services/revoked-session-cache.js";
import { logger } from "../utils/logger.js";

export const SESSION_REVOKED_MESSAGE =
  "This session has been signed out. Sign in again to continue.";

export const SESSION_CHECK_UNAVAILABLE_MESSAGE =
  "Your session can't be confirmed right now. Try again in a moment.";

/** Detail reason carried by the 503 below. */
export const SESSION_CHECK_UNAVAILABLE_REASON = "SESSION_CHECK_UNAVAILABLE";

/** Seconds; the list is retried within seconds of the feed recovering. */
export const SESSION_CHECK_RETRY_AFTER_SECONDS = 5;

function isV1Request(c: Context): boolean {
  const path = c.req.path;
  return path === "/api/v1" || path.startsWith("/api/v1/");
}

export function sessionRevokedResponse(c: Context): Response {
  if (isV1Request(c)) {
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: SESSION_REVOKED_MESSAGE,
        details: { reason: ErrorCode.SESSION_REVOKED },
      },
      401,
    );
  }
  return c.json(
    { code: ErrorCode.SESSION_REVOKED, message: SESSION_REVOKED_MESSAGE },
    401,
  );
}

export function sessionCheckUnavailableResponse(c: Context): Response {
  return c.json(
    {
      code: ErrorCode.SERVER_UNREACHABLE,
      message: SESSION_CHECK_UNAVAILABLE_MESSAGE,
      details: { reason: SESSION_CHECK_UNAVAILABLE_REASON },
    },
    503,
    { "Retry-After": String(SESSION_CHECK_RETRY_AFTER_SECONDS) },
  );
}

function logRefusal(
  path: string,
  verdict: Exclude<SessionRevocationCheck, { ok: true }>,
): void {
  // `info`, like the gateway's other credential refusals: the volume is the
  // caller's to choose, and Axiom is where a spike is queried. The list going
  // stale is reported once, by the cache itself.
  logger.info("Refused a request whose session could not be served", {
    event: "auth.session_refused",
    reason: verdict.reason,
    path,
  });
}

/**
 * For middleware: the refusal to return for this session, or null to
 * continue. `sid` must come from a VERIFIED token.
 */
export function refuseUnservableSession(
  c: Context,
  sid: string | undefined | null,
  options: { requireFresh: boolean },
): Response | null {
  const verdict = checkSessionRevocation(sid, options);
  if (verdict.ok) return null;
  logRefusal(c.req.path, verdict);
  return verdict.reason === "revoked"
    ? sessionRevokedResponse(c)
    : sessionCheckUnavailableResponse(c);
}

/**
 * For handlers that answer through `handleRoute`/`WebRouteError`: throws the
 * refusal for this session. `sid` must come from a VERIFIED token.
 */
export function assertSessionServable(
  sid: string | undefined | null,
  options: { requireFresh: boolean; path?: string },
): void {
  const verdict = checkSessionRevocation(sid, options);
  if (verdict.ok) return;
  logRefusal(options.path ?? "", verdict);
  if (verdict.reason === "revoked") {
    throw new WebRouteError(
      401,
      ErrorCode.SESSION_REVOKED,
      SESSION_REVOKED_MESSAGE,
    );
  }
  throw new WebRouteError(
    503,
    ErrorCode.SERVER_UNREACHABLE,
    SESSION_CHECK_UNAVAILABLE_MESSAGE,
    { reason: SESSION_CHECK_UNAVAILABLE_REASON },
  ).withHeaders({
    "Retry-After": String(SESSION_CHECK_RETRY_AFTER_SECONDS),
  });
}
