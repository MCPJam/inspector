import type { OAuthTokens } from "@modelcontextprotocol/client";
import {
  discoverAuthorizationServerMetadata,
  refreshAuthorization,
} from "@mcpjam/sdk/browser";
import { isPrivateNetworkUrl } from "@/shared/private-address";
import { HOSTED_MODE } from "../config.js";
import { isBlockedEgressHost } from "./hosted-egress-guard.js";
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
 * A private authorization server behind a proxy legitimately redirects — http→
 * https, or `/.well-known/oauth-authorization-server` →
 * `/.well-known/openid-configuration`. Bounded so a redirect loop cannot hang
 * the connect.
 */
const MAX_DISCOVERY_REDIRECTS = 3;

/**
 * May this refresh dial `url`?
 *
 * TWO classifications, and they are not the same question:
 *
 *  - `isPrivateNetworkUrl` is "the hosted backend cannot reach this", the
 *    predicate the backend itself used to decide it needed help. It is
 *    hand-mirrored in the backend repo, so it must keep saying yes to the same
 *    set — `.local`/`.internal` names included.
 *  - `isBlockedEgressHost(host, false)` is the never-legitimate tier the rest
 *    of this codebase refuses in EVERY mode: cloud-metadata addresses and
 *    their DNS aliases, IPv4/IPv6 link-local, and the unspecified address.
 *    `isPrivateNetworkUrl` says yes to several of those (169.254.0.0/16 is
 *    "private", and `metadata.google.internal` ends in `.internal`), which
 *    would let a malicious or simply wrong backend response steer a refresh
 *    token at an instance metadata endpoint.
 *
 * A target must be in the first set and out of the second.
 */
function assertPrivateRefreshTarget(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to refresh: ${what} is not a valid URL`);
  }
  if (!isPrivateNetworkUrl(url)) {
    throw new Error(
      `Refusing to refresh: ${what} is not on a private address (${parsed.origin})`
    );
  }
  if (isBlockedEgressHost(parsed.hostname, false)) {
    throw new Error(
      `Refusing to refresh: ${what} is an address this inspector never dials ` +
        `(${parsed.origin})`
    );
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return String(input instanceof Request ? input.url : input);
}

/**
 * The token grant. Refuses redirects outright: a private authorization server
 * that bounces its own token endpoint is indistinguishable from exfiltration,
 * and replaying a POST body carrying a refresh token to a new location is
 * exactly what must not happen silently.
 */
const dialTokenEndpoint: typeof fetch = (input, init) => {
  assertPrivateRefreshTarget(urlOf(input), "the token endpoint");
  return fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
};

/**
 * Metadata discovery. Follows redirects MANUALLY so every hop is re-checked
 * against the same guard.
 *
 * `redirect: "error"` here turned any 3xx into a TypeError, which the SDK's
 * discovery loop reads as "this well-known URL did not answer" — so a
 * redirecting-but-healthy authorization server yielded no metadata at all, the
 * grant went to a guessed origin-relative `/token`, and the user was told the
 * server could not be reached. Discovery is an idempotent GET, so following it
 * carries none of the risk the token POST does.
 */
const dialDiscovery: typeof fetch = async (input, init) => {
  let currentUrl = urlOf(input);
  const headers =
    input instanceof Request ? input.headers : init?.headers ?? undefined;

  for (let hop = 0; ; hop++) {
    assertPrivateRefreshTarget(currentUrl, "the authorization server");
    const response = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;
    if (!location) {
      return response;
    }
    if (hop >= MAX_DISCOVERY_REDIRECTS) {
      throw new Error(
        `Authorization server metadata redirected more than ` +
          `${MAX_DISCOVERY_REDIRECTS} times`
      );
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
};

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
 * stored credential, with a token that authorization server itself issued.
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
  //    compromised backend response and token exfiltration. Re-asserted per
  //    request below too: gate 2 covers the URL we START from, and the token
  //    endpoint comes out of a document that server returns.
  assertPrivateRefreshTarget(
    material.authorizationServerUrl,
    "the authorization server"
  );

  const metadata = await discoverAuthorizationServerMetadata(
    material.authorizationServerUrl,
    { fetchFn: dialDiscovery }
  );
  if (!metadata) {
    // Not fatal — `refreshAuthorization` falls back to an origin-relative
    // `/token`, which is still guarded — but it is the usual reason a grant
    // then 404s, so say so once here rather than leaving it unexplained.
    logger.debug(
      "[local oauth refresh] no authorization server metadata; using the default token endpoint",
      {
        authorizationServerOrigin: new URL(material.authorizationServerUrl)
          .origin,
      }
    );
  }

  // The SDK's own refresh_token grant — same client-authentication selection,
  // same resource-indicator handling, and it already spreads the response over
  // the refresh token it was given so an authorization server that omits one
  // (RFC 6749 §6, meaning "keep using the one you have") does not silently
  // erase it.
  const tokens = await refreshAuthorization(material.authorizationServerUrl, {
    metadata,
    clientInformation: {
      client_id: material.clientId,
      ...(material.clientSecret
        ? { client_secret: material.clientSecret }
        : {}),
    },
    refreshToken: material.refreshToken,
    resource: new URL(material.oauthResourceUrl ?? material.serverUrl),
    fetchFn: dialTokenEndpoint,
  });

  logger.debug("[local oauth refresh] refreshed against private auth server", {
    // Origin only, never the raw URL: logger.debug ships to Axiom, and an
    // imported authorization-server URL can carry basic-auth userinfo or an
    // `x-api-key`-style query parameter. `.origin` drops userinfo, path and
    // query, which is the whole credential surface. Same rule the backend
    // applies with sanitizeUrlForLog.
    authorizationServerOrigin: new URL(material.authorizationServerUrl).origin,
    rotatedRefreshToken: Boolean(tokens.refresh_token),
  });

  return tokens;
}
