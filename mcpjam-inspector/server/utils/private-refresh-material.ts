/**
 * The parts of the private-authorization-server refresh that need no network:
 * turning a local refresh failure into the error the backend would have sent
 * for the same failure.
 */
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import type { PrivateAuthorizationServerRefreshMaterial } from "./local-oauth-refresh.js";

/** Did the authorization server itself reject the grant? */
export function isRejectedGrant(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /^(invalid_grant|invalid_client)$/i.test(code);
}

/**
 * Map a local-refresh failure onto the shapes the surrounding code already
 * knows, so the UX matches a backend refresh failing the same way.
 */
export function translateLocalRefreshFailure(
  error: unknown,
  material: PrivateAuthorizationServerRefreshMaterial,
  serverId: string,
  serverName: string | null,
): WebRouteError {
  const message = parseErrorMessage(error);

  // Two carriers for one OAuth code, both required. A conforming RFC 6749 §5.2
  // decline arrives as the SDK's OAuthResponseError with the code on `.code`
  // and the error_description in `message` — so matching the message alone
  // misses the COMMON case. Non-conforming servers only put it in the text.
  const oauthCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";

  // The authorization server rejected the grant. Same shape the backend sends
  // for refresh_token_invalid, so the existing reconnect prompt just works.
  //
  // The message arm covers a server that puts the code only in its
  // error_description, but it must never read text the SERVER did not author
  // as OAuth. When the response was not JSON at all, the SDK embeds the raw
  // body verbatim (`Invalid OAuth error response: ${body}`) — so a dev proxy's
  // HTML error page that merely mentions `invalid_grant` turned a transport
  // problem into "your refresh token was rejected, please reconnect", on a
  // credential that was fine. Cut the message at that marker before matching.
  //
  // Word-bounded for a second false positive: `invalid_client` is a substring
  // of the unrelated `invalid_client_metadata`.
  const authoredMessage = message.split("Invalid OAuth error response:")[0];
  if (
    /^(invalid_grant|invalid_client)$/i.test(oauthCode) ||
    /\b(invalid_grant|invalid_client)\b/i.test(authoredMessage)
  ) {
    return new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "The stored refresh token was rejected. Please reconnect.",
      { oauthRequired: true, refreshTokenInvalid: true, serverId, serverName },
    );
  }

  // Their own server isn't running. The connect was going to fail regardless;
  // say why rather than reporting a generic refresh error.
  //
  // Origin only, never the raw URL — the same rule
  // `refreshTokensAgainstPrivateAuthorizationServer` applies to its debug log,
  // and it binds harder here: this message is the HTTP response body and it
  // reaches Sentry. An imported authorization-server URL can carry basic-auth
  // userinfo or an `x-api-key`-style query parameter, and `.origin` drops
  // userinfo, path and query while keeping the host the user needs to see.
  let authorizationServerOrigin: string;
  try {
    authorizationServerOrigin = new URL(material.authorizationServerUrl).origin;
  } catch {
    authorizationServerOrigin = "the authorization server";
  }
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    `Could not reach the authorization server at ${authorizationServerOrigin}: ${message}`,
    { serverId, serverName, authorizationServerUnreachable: true },
  );
}
