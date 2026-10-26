/**
 * A server that refuses a run for want of credentials has said "who are you?",
 * not "I am broken".
 *
 * Answering an unauthenticated request with HTTP 401 is exactly what an
 * OAuth-protected MCP server is required to do. The suites used to grade that
 * answer as a violation: Linear, Notion, Stripe and GitHub all reported
 * `failed` at 5/100 against a run that simply carried no token, and the page
 * showed the raw 401 in a red box. What the run actually established is that
 * it never reached anything it could grade — `could-not-run`, so the verdict
 * is `incomplete` and the next step is to connect.
 *
 * Whether the server's challenge is itself well formed is the OAuth suite's
 * question, not these suites'; nothing here grades the 401.
 */

import { isMCPAuthError } from "./mcp-client-manager/errors.js";

export const AUTHORIZATION_REQUIRED_MESSAGE =
  "The server requires authorization (HTTP 401) and this run had no accepted credentials, so this check could not run. Connect the server with OAuth, or pass an access token, then run again.";

/**
 * Set to `true` in a check's `details` when an authorization refusal is why it
 * could not run — the marker a UI reads to offer the reconnect.
 */
export const AUTHORIZATION_REQUIRED_DETAIL = "authorizationRequired";

/** The connection itself was refused for credentials (401, expired or invalid token). */
export function isAuthorizationRefusal(error: unknown): boolean {
  return isMCPAuthError(error);
}

/** `details` carrying the authorization marker, plus the refusal's status when known. */
export function authorizationRequiredDetails(
  error?: unknown,
): Record<string, unknown> {
  const statusCode = isMCPAuthError(error) ? error.statusCode : undefined;
  return {
    [AUTHORIZATION_REQUIRED_DETAIL]: true,
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

/** A check result that could not run because the server wanted credentials. */
export function isAuthorizationRequiredCheck(check: {
  details?: unknown;
}): boolean {
  const details = check.details as Record<string, unknown> | undefined;
  return details?.[AUTHORIZATION_REQUIRED_DETAIL] === true;
}

/**
 * A raw probe's recorded HTTP status was 401: the answer came from the
 * authorization layer in front of the MCP endpoint, so it says nothing about
 * the behaviour the check grades. The protocol and transport probes record it
 * as `status`, the localhost Host/Origin probes as `statusCode` — a server
 * that authenticates before it validates Host never showed us its Host rule.
 */
export function isUnauthorizedProbe(
  details: Record<string, unknown> | undefined,
): boolean {
  return details?.status === 401 || details?.statusCode === 401;
}
