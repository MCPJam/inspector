// Connect-context framing for Cross-App Access (XAA) mint failures.
//
// `mintXaaAccessToken` is shared with the XAA Debugger, so its errors are
// written for someone standing in that tool: "Set the issuer in Configure
// Server to Test", "XAA DCR is not available on this Inspector instance". A
// swarm launch or a playground connect has no such surface, and XAA is not
// something those flows opted into — it is selected per server at connect time
// (`resolveEffectiveAuthMethod`), so their user may not know the term at all.
// Unframed, those sentences arrive as a red wall naming a page nobody is on.
//
// Every non-debugger mint site funnels its failure through
// `toXaaConnectFailure`: name the server, say what failed in ONE sentence,
// offer the one action that fixes it. The classified `reason` rides in
// `details` so downstream surfaces can pick a TONE rather than painting every
// XAA failure red — a handshake that needs re-running is not a catastrophe,
// and `reason` is what the swarm attempt row carries to say so
// (`shared/swarm-attempt-error.ts`).
//
// The debugger keeps the original messages: it IS the surface they name.
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { XaaConnectFailureReason } from "../../shared/xaa-connect-failure.js";

/** Trailing punctuation off, so a stored sentence can be embedded in ours. */
function asClause(message: string): string {
  return message.trim().replace(/[.!?]+$/, "");
}

/**
 * The authorization server's own rejection, as the mint's 502 recorded it:
 * `… (HTTP 401) — invalid_client: unknown client`. Only the tail after the
 * em dash is the AS speaking; the rest names a token endpoint the user did not
 * type and cannot act on.
 */
function extractRejectionDetail(message: string): string | undefined {
  const status = /\(HTTP (\d{3})\)/.exec(message)?.[1];
  const detail = message.split(" — ")[1]?.trim();
  const parts = [
    status ? `HTTP ${status}` : undefined,
    detail ? asClause(detail) : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/**
 * Re-frame a mint failure for a connect surface (swarm, playground, evals).
 *
 * Always returns a WebRouteError carrying `details.reason` and the server
 * identity; the original error becomes `cause`, so Sentry and the Axiom row
 * keep every byte the debugger-framed message had. Call it AFTER the existing
 * `isXaaMintErrorReported` logging so a reported failure is not re-reported.
 */
export function toXaaConnectFailure(
  error: unknown,
  target: { serverId: string; serverName: string; serverUrl?: string }
): WebRouteError {
  const name = target.serverName;
  const routeError = error instanceof WebRouteError ? error : undefined;
  const raw = routeError?.message ?? "";

  let status = 500;
  let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
  let reason: XaaConnectFailureReason =
    XaaConnectFailureReason.HANDSHAKE_FAILED;
  let message =
    `Server "${name}" couldn't complete its enterprise authorization handshake` +
    ` — try again, and check the server's auth settings if it keeps failing.`;

  if (routeError?.status === 401 || routeError?.status === 403) {
    // The identity legs of the mint (the secret reveal and the scoped-issuer
    // gate) both authenticate with the CALLER's bearer, so a session that has
    // gone stale fails here — with the backend's own "Missing or invalid
    // bearer token", which reads as a server fault. Nothing is stored, so
    // signing in again genuinely clears it; say exactly that.
    status = 401;
    code = ErrorCode.UNAUTHORIZED;
    reason = XaaConnectFailureReason.REAUTH_REQUIRED;
    message =
      `Your sign-in no longer proves your identity to "${name}", so its` +
      ` enterprise access token couldn't be issued — sign in again, then re-run.`;
  } else if (routeError?.code === ErrorCode.NOT_FOUND) {
    status = 404;
    code = ErrorCode.NOT_FOUND;
    reason = XaaConnectFailureReason.AUTHORIZATION_SERVER_UNKNOWN;
    message =
      `MCPJam couldn't find the authorization server that protects "${name}"` +
      ` — set its issuer in the server's auth settings.`;
  } else if (routeError?.code === ErrorCode.FEATURE_NOT_SUPPORTED) {
    status = 409;
    code = ErrorCode.FEATURE_NOT_SUPPORTED;
    reason = XaaConnectFailureReason.NOT_SUPPORTED_HERE;
    message = `Server "${name}" can't use its configured enterprise authorization mode here: ${asClause(
      raw
    )}.`;
  } else if (
    routeError?.code === ErrorCode.SERVER_UNREACHABLE ||
    routeError?.code === ErrorCode.TIMEOUT
  ) {
    status = routeError.status;
    code = routeError.code;
    reason = XaaConnectFailureReason.AUTHORIZATION_REJECTED;
    const detail = extractRejectionDetail(raw);
    message =
      `The authorization server for "${name}" rejected MCPJam's access request` +
      `${detail ? ` (${detail})` : ""} — check the server's XAA client` +
      ` credentials and issuer in its auth settings.`;
  } else if (routeError?.code === ErrorCode.VALIDATION_ERROR) {
    status = 400;
    code = ErrorCode.VALIDATION_ERROR;
    reason = XaaConnectFailureReason.CONFIGURATION_INVALID;
    message = `Server "${name}" isn't fully configured for enterprise-managed authorization: ${asClause(
      raw
    )}.`;
  }

  const framed = new WebRouteError(status, code, message, {
    reason,
    serverId: target.serverId,
    serverName: target.serverName,
    ...(target.serverUrl ? { serverUrl: target.serverUrl } : {}),
    // Interactive clients already escalate on this flag for OAuth; an XAA
    // re-auth is the same ask ("prove who you are again"), and every consumer
    // treats it as "show the sign-in affordance", never as "start DCR".
    ...(reason === XaaConnectFailureReason.REAUTH_REQUIRED
      ? { xaaReauthRequired: true }
      : {}),
  });
  framed.cause = error;
  return framed;
}
