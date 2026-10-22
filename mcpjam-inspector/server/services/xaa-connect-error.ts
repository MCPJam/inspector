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
import type { CapturePolicy } from "../utils/error-origin-capture.js";
import { reportRouteFailure } from "../utils/route-error-report.js";
import { isXaaMintErrorReported } from "./xaa-mint.js";

/**
 * What the mint ran into on the customer's side, when that is what failed:
 * their authorization server answered the jwt-bearer grant with a refusal,
 * or no authorization server could be discovered for the issuer they set.
 */
type XaaMintRefusal =
  | { kind: "authorization_rejected"; status: number; oauthError?: string }
  | { kind: "authorization_server_unknown" };

// Keyed on the marker the mint sets, never on code or status alone: the
// secret-reveal leg maps any backend 404/502 onto the same NOT_FOUND and
// SERVER_UNREACHABLE codes, and those are MCPJam's own failures.
function xaaMintRefusal(error: unknown): XaaMintRefusal | null {
  if (!(error instanceof WebRouteError)) return null;
  const verdict = error.details?.authorizationServer;
  if (verdict === "undiscovered") {
    return { kind: "authorization_server_unknown" };
  }
  if (verdict !== "rejected") return null;
  const status = error.details?.status;
  if (typeof status !== "number") return null;
  const oauthError = error.details?.oauthError;
  return {
    kind: "authorization_rejected",
    status,
    ...(typeof oauthError === "string" && oauthError ? { oauthError } : {}),
  };
}

/**
 * Sentry policy for a mint failure the customer's authorization server (or
 * their issuer setting) caused: still captured, so the issue exists and can be
 * searched, but as a `routine` warning the generic new-issue paging rule
 * skips, with the AS status and RFC 6749 error code as tags because Sentry
 * scrubs the message they used to live in.
 *
 * Every other mint failure returns `undefined`: the remaining legs (secret
 * reveal, ID-JAG signing, CIMD) are MCPJam's own, and keep the default policy.
 */
export function xaaMintCapturePolicy(
  error: unknown
): CapturePolicy | undefined {
  const refusal = xaaMintRefusal(error);
  if (!refusal) return undefined;
  const tags: Record<string, string> = {
    page_class: "routine",
    xaa_failure: refusal.kind,
  };
  if (refusal.kind === "authorization_rejected") {
    tags.xaa_as_status = String(refusal.status);
    if (refusal.oauthError) tags.xaa_as_error = refusal.oauthError;
  }
  return { always: true, level: "warning", tags };
}

/**
 * Report a mint failure from a connect surface, once. Shared by the hosted
 * and the local connect paths so both classify the same way. Call it BEFORE
 * `toXaaConnectFailure`, so the debugger-worded original is what reaches
 * Sentry and the Axiom row.
 */
export function reportXaaMintFailure(
  error: unknown,
  context: {
    serverId: string;
    serverName: string;
    resource?: string;
    connectionId?: string;
  }
): void {
  if (isXaaMintErrorReported(error)) return;
  const refusal = xaaMintCapturePolicy(error);
  reportRouteFailure("[XAA connect] mint failed", error, {
    source: "xaa.connect.mint",
    // A refusal crossed into the customer's authorization server. Anything
    // else failed inside MCPJam's own mint legs, so an unclassified error
    // there is ours by default, and it is captured whatever the catalog says
    // about it: the bare `logger.error` this replaces captured every mint
    // failure, and nothing but the refusals is meant to page less.
    hop: refusal ? "user_server_hop" : "mcpjam_internal",
    context,
    capture: refusal ?? { always: true },
  });
}

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
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const CREDENTIAL_REFUSAL_KEYS = [
  "secretOriginMismatch",
  "boundOrigin",
  "targetOrigin",
  "exportDenied",
  "policy",
  "credentialRefusal",
] as const;

/** The backend's credential-refusal details, when this failure is one. */
function credentialRefusalDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (
    !details ||
    (details.secretOriginMismatch !== true && details.exportDenied !== true)
  ) {
    return null;
  }
  const kept: Record<string, unknown> = {};
  for (const key of CREDENTIAL_REFUSAL_KEYS) {
    if (details[key] !== undefined) kept[key] = details[key];
  }
  return kept;
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
  // The authorization server's own HTTP status, when it answered at all.
  let authorizationServerStatus: number | undefined;
  let message =
    `Server "${name}" couldn't complete its enterprise authorization handshake` +
    ` — try again, and check the server's auth settings if it keeps failing.`;

  // A saved client secret the backend refused to release: the server moved to
  // an origin it was not entered for, or the organization's export policy
  // keeps it inside hosted connections. Signing in again changes neither, so
  // it must not read as a re-auth; the backend's sentence already says what
  // to do, and its details let the client open the right form.
  const refusal = credentialRefusalDetails(routeError?.details);
  if (refusal) {
    status = 403;
    code = ErrorCode.FORBIDDEN;
    reason = XaaConnectFailureReason.CONFIGURATION_INVALID;
    message = raw
      ? `Server "${name}" couldn't use its saved client secret: ${asClause(raw)}.`
      : `Server "${name}" couldn't use its saved client secret.`;
  } else if (routeError?.status === 401 || routeError?.status === 403) {
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
    const answered = routeError.details?.status;
    if (
      typeof answered === "number" &&
      Number.isInteger(answered) &&
      answered >= 100 &&
      answered <= 599
    ) {
      authorizationServerStatus = answered;
    }
    const detail = extractRejectionDetail(raw);
    message =
      `The authorization server for "${name}" rejected MCPJam's access request` +
      `${detail ? ` (${detail})` : ""}. Check the server's auth settings.`;
  } else if (routeError?.code === ErrorCode.VALIDATION_ERROR) {
    status = 400;
    code = ErrorCode.VALIDATION_ERROR;
    reason = XaaConnectFailureReason.CONFIGURATION_INVALID;
    message = `Server "${name}" isn't fully configured for enterprise-managed authorization: ${asClause(
      raw
    )}.`;
  }

  const framed = new WebRouteError(status, code, message, {
    ...(refusal ?? {}),
    reason,
    // Structured, so a caller deciding "will this fail again?" never has to
    // read the status back out of the sentence (which carries the server's
    // name, and is capped when stored).
    ...(authorizationServerStatus !== undefined
      ? { authorizationServerStatus }
      : {}),
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
  framed.withSetupFailureSource("xaa_mint");
  framed.cause = error;
  return framed;
}
