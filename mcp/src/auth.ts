import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface VerifiedToken {
  token: string;
  payload: JWTPayload;
}

export type VerifyResult =
  | { ok: true; verified: VerifiedToken }
  | { ok: false; response: Response };

export function normalizeIssuer(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const withScheme =
    domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * Allowed issuer → JWKS URL map. Mirrors the inspector's
 * `server/services/authkit-jwt.ts` (`authkitIssuerJwks`) and the backend's
 * `convex/auth.config.ts`, so the worker accepts exactly the tokens the rest
 * of the platform already honors.
 *
 * Why a map and not a single issuer: the browser AuthKit SDK talks to the
 * default WorkOS API host, so the access tokens it mints carry
 * `iss = https://api.workos.com/user_management/<clientId>` — NOT the custom
 * AuthKit domain (`login.mcpjam.com`). Pinning verification to the single
 * `AUTHKIT_DOMAIN` issuer therefore rejected every real production token,
 * which is exactly why the MCPJam agent's platform tools silently vanished in
 * prod (worker 401 → preflight drops the server). A token's `iss` selects the
 * JWKS; an issuer absent from this map is rejected.
 *
 * Note the JWKS path differs by issuer: WorkOS-hosted issuers publish at
 * `/sso/jwks/<clientId>`, the custom AuthKit domain at `/oauth2/jwks`.
 */
export function authkitIssuerJwks(
  clientId: string,
  authkitDomain: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const workosJwks = `https://api.workos.com/sso/jwks/${clientId}`;
  const mcpjamJwks = `https://api.mcpjam.com/sso/jwks/${clientId}`;
  const authJwks = `https://auth.mcpjam.com/sso/jwks/${clientId}`;
  map.set("https://api.workos.com/", workosJwks);
  map.set(`https://api.workos.com/user_management/${clientId}`, workosJwks);
  map.set("https://api.mcpjam.com/", mcpjamJwks);
  map.set(`https://api.mcpjam.com/user_management/${clientId}`, mcpjamJwks);
  map.set("https://auth.mcpjam.com/", authJwks);
  map.set(`https://auth.mcpjam.com/user_management/${clientId}`, authJwks);
  const authkitIssuer = normalizeIssuer(authkitDomain);
  if (authkitIssuer) {
    map.set(authkitIssuer, `${authkitIssuer}/oauth2/jwks`);
  }
  return map;
}

// One remote JWKS per URL (jose caches fetched keys internally per set).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function remoteJwks(jwksUrl: string) {
  let set = jwksCache.get(jwksUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, set);
  }
  return set;
}

// A remote JWKS getter, or a static key (jose 6 dropped the `KeyLike` alias;
// static keys are `CryptoKey | Uint8Array`). The static branch is used by
// tests / injected deps; production always resolves to a remote JWKS.
type KeyResolver =
  | ReturnType<typeof createRemoteJWKSet>
  | CryptoKey
  | Uint8Array;

export interface VerifyConfig {
  /** WorkOS client id; also the expected token `aud`. */
  clientId: string;
  /** Custom AuthKit domain (`env.AUTHKIT_DOMAIN`), added to the issuer set. */
  authkitDomain: string | undefined;
  /**
   * Issuer → key/JWKS resolver. `null` rejects the issuer. Injectable for
   * tests; production derives it from the allow-list above (remote JWKS).
   */
  resolveKey?: (issuer: string) => KeyResolver | null;
}

function defaultResolveKey(
  clientId: string,
  authkitDomain: string | undefined,
): (issuer: string) => KeyResolver | null {
  const issuers = authkitIssuerJwks(clientId, authkitDomain);
  return (issuer) => {
    const jwksUrl = issuers.get(issuer);
    return jwksUrl ? remoteJwks(jwksUrl) : null;
  };
}

function extractBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function buildWwwAuthenticate(
  origin: string,
  error?: { code: string; description: string },
): string {
  const parts = ["Bearer"];
  if (error) {
    parts.push(`error="${error.code}"`);
    parts.push(`error_description="${error.description}"`);
  }
  parts.push(`resource_metadata="${resourceMetadataUrl(origin)}"`);
  return parts[0] + " " + parts.slice(1).join(", ");
}

export async function verifyBearerToken(
  request: Request,
  config: VerifyConfig,
  origin: string,
): Promise<VerifyResult> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return { ok: false, response: missingTokenResponse(origin) };
  }

  // Read the (unverified) issuer ONLY to select the matching JWKS. The trust
  // decision is `jwtVerify` below — signature + issuer pin + audience +
  // exp/nbf — so a spoofed `iss` cannot grant access: it must be in the
  // allow-list AND be signed by that issuer's published keys.
  let issuer: string | undefined;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    return { ok: false, response: invalidTokenResponse(origin) };
  }
  if (!issuer) {
    return { ok: false, response: invalidTokenResponse(origin) };
  }

  const resolveKey =
    config.resolveKey ?? defaultResolveKey(config.clientId, config.authkitDomain);
  const key = resolveKey(issuer);
  if (!key) {
    return { ok: false, response: invalidTokenResponse(origin) };
  }
  // Normalize to a key-getter so the overload is unambiguous: a remote JWKS is
  // already a function; a static key (tests / injected deps) is wrapped.
  const getKey: JWTVerifyGetKey =
    typeof key === "function" ? (key as JWTVerifyGetKey) : async () => key;

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer,
      audience: config.clientId,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    return { ok: true, verified: { token, payload } };
  } catch {
    return { ok: false, response: invalidTokenResponse(origin) };
  }
}

export const OAUTH_DISCOVERY_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "WWW-Authenticate",
} as const;

function missingTokenResponse(origin: string): Response {
  // RFC 6750 §3.1: no error code when credentials are absent.
  return new Response(JSON.stringify({ error: "Authorization needed" }), {
    status: 401,
    headers: {
      ...OAUTH_DISCOVERY_HEADERS,
      "content-type": "application/json",
      "www-authenticate": buildWwwAuthenticate(origin),
    },
  });
}

function invalidTokenResponse(origin: string): Response {
  return new Response(JSON.stringify({ error: "Invalid bearer token" }), {
    status: 401,
    headers: {
      ...OAUTH_DISCOVERY_HEADERS,
      "content-type": "application/json",
      "www-authenticate": buildWwwAuthenticate(origin, {
        code: "invalid_token",
        description: "The bearer token is invalid or expired",
      }),
    },
  });
}
