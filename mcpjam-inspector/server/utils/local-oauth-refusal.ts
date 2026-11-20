import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { credentialOrigin } from "./credential-header-binding.js";
import { CREDENTIAL_EXPORT_SETTING_HINT } from "../../shared/credential-export-setting.js";

/** What `/web/authorize-batch-local` says about a token it withheld. */
export type AuthorizeOAuthOutcome = {
  oauthAccessToken?: string | null;
  oauthUnavailableReason?: string;
  oauthUnavailablePolicy?: string;
  /** With the `hostedOnlyAccount` policy: which part of the account's rule. */
  oauthUnavailableCause?: string;
  /** The backend's sentence for that refusal, shown as is. */
  oauthUnavailableMessage?: string;
};

/** The sentence for a hosted-only refusal when the backend sent none. */
export function hostedOnlyFallback(named: string, cause?: string): string {
  if (cause === "not_acknowledged")
    return `${named} uses the project's shared sign-in, and local runs are off for it. Ask a project admin to turn on Allow local runs on the server's Auth tab.`;
  if (cause === "client_upgrade_required")
    return `${named} signs in with a shared or uploaded account. Update MCPJam to use it locally.`;
  return `${named} signs in with a shared or uploaded account this app can't use. Run it from MCPJam instead.`;
}

/**
 * A refusal the authorize answer already carries, raised with the same
 * details a refused `/web/oauth/force-refresh` raises
 * (`forceRefreshHostedOAuthAccessToken`), so the client shows the same card.
 *
 * Raised before any refresh: a token the backend will not release to this
 * caller is refused again by a refresh, and the refresh spends the caller's
 * rate-limited budget to say so. `null` when there is nothing to refuse,
 * including when the token is merely missing or expired.
 */
export function oauthRefusalFromAuthorize(
  result: AuthorizeOAuthOutcome,
  server: { serverId: string; serverName: string; serverUrl?: string },
): WebRouteError | null {
  if (result.oauthAccessToken) return null;
  const named = `"${server.serverName}"`;
  if (result.oauthUnavailableReason === "credential_export_denied") {
    const hostedOnly = result.oauthUnavailablePolicy === "hostedOnlyAccount";
    const message = hostedOnly
      ? (result.oauthUnavailableMessage ??
        hostedOnlyFallback(named, result.oauthUnavailableCause))
      : `Your organization does not allow saved credentials for ${named} in local runs. ${CREDENTIAL_EXPORT_SETTING_HINT}`;
    return new WebRouteError(403, ErrorCode.FORBIDDEN, message, {
      exportDenied: true,
      policy: hostedOnly ? "hostedOnlyAccount" : "credentialExportPolicy",
      ...(hostedOnly && result.oauthUnavailableCause
        ? { cause: result.oauthUnavailableCause }
        : {}),
      credentialRefusal: "export_denied",
      serverId: server.serverId,
      serverName: server.serverName,
    });
  }
  if (result.oauthUnavailableReason === "credential_origin_mismatch") {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      `${named} now points at a different address than the one it was authorized for. Reconnect it to authorize the new address.`,
      {
        secretOriginMismatch: true,
        // The answer names no recorded origin, but the card can still say
        // where the server points now.
        boundOrigin: null,
        targetOrigin: credentialOrigin(server.serverUrl),
        credentialRefusal: "credential_origin_mismatch",
        serverId: server.serverId,
        serverName: server.serverName,
      },
    );
  }
  return null;
}
