import type { OAuthTokens } from "@modelcontextprotocol/client";
import {
  RefreshTokenOAuthProvider,
  discoverAuthorizationServerMetadata,
  fetchToken,
} from "@mcpjam/sdk/browser";
import { isPrivateNetworkUrl } from "@/shared/private-address";
import { HOSTED_MODE } from "../config.js";
import { logger } from "./logger.js";

/** Everything the backend hands back when it cannot refresh a credential itself. */
export type PrivateAuthorizationServerRefreshMaterial = {
  authorizationServerUrl: string;
  serverUrl: string;
  oauthResourceUrl: string | null;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
};

/** The authorization server is on the user's machine; it answers or it doesn't. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh an access token against an authorization server that only this
 * machine can reach.
 *
 * MCPJam Cloud stores these credentials but structurally cannot refresh them:
 * the authorization server is on localhost or a private range, so it answers
 * the user's own browser during the OAuth flow and nothing else afterwards.
 * The backend detects that and returns the material instead of a token; this
 * performs the `refresh_token` grant here, where the address resolves.
 *
 * Deliberately plain `fetch` rather than the SDK's OAuth proxy: that seam
 * exists to NARROW an SSRF guard, and this function's entire purpose is to
 * dial a private address — on the user's own machine, at a URL from their own
 * stored credential, with a token that authorization server itself issued. It
 * would also fight `discoverAuthorizationServerMetadata`'s well-known-URL
 * fallback loop, which reads a 4xx as "try the next URL".
 */
export async function refreshTokensAgainstPrivateAuthorizationServer(
  material: PrivateAuthorizationServerRefreshMaterial
): Promise<OAuthTokens> {
  // Two independent gates, both before anything is dialed.
  //
  // 1. Process-level. A deployed instance must never run this path, whatever a
  //    caller asks for — it has no business reaching a private address, and
  //    there is no user machine on the other end of it.
  if (HOSTED_MODE) {
    throw new Error(
      "Refusing to refresh against a private authorization server in hosted mode"
    );
  }
  // 2. The inverse of the check the backend already made. The URL arrives in a
  //    response body, so re-asserting it locally is what stops a malicious or
  //    simply wrong response from steering this at a public host WITH THE
  //    USER'S REFRESH TOKEN. Cheap, and the only thing standing between a
  //    compromised backend response and token exfiltration.
  if (!isPrivateNetworkUrl(material.authorizationServerUrl)) {
    throw new Error(
      "Refusing to refresh: authorization server is not on a private address"
    );
  }

  const provider = new RefreshTokenOAuthProvider(
    material.clientId,
    material.refreshToken,
    material.clientSecret
  );

  const fetchFn: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });

  const metadata = await discoverAuthorizationServerMetadata(
    material.authorizationServerUrl,
    { fetchFn }
  );

  const tokens = await fetchToken(provider, material.authorizationServerUrl, {
    metadata,
    resource: new URL(material.oauthResourceUrl ?? material.serverUrl),
    fetchFn,
  });

  logger.debug("[local oauth refresh] refreshed against private auth server", {
    authorizationServerUrl: material.authorizationServerUrl,
    rotatedRefreshToken: Boolean(tokens.refresh_token),
  });

  return tokens;
}
