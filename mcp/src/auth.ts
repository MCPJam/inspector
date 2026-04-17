import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface VerifiedToken {
  token: string;
  payload: JWTPayload;
}

export type VerifyResult =
  | { ok: true; verified: VerifiedToken }
  | { ok: false; response: Response };

const jwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function getJwks(issuer: string) {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/oauth2/jwks", issuer));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

export function normalizeIssuer(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const withScheme =
    domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`;
  return withScheme.replace(/\/+$/, "");
}

function extractBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const [type, token] = header.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
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
  issuer: string,
  origin: string,
): Promise<VerifyResult> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return { ok: false, response: missingTokenResponse(origin) };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), { issuer });
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
