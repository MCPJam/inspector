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

export function extractBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const [type, token] = header.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

export function buildWwwAuthenticate(origin: string, description: string): string {
  return [
    'Bearer error="unauthorized"',
    `error_description="${description}"`,
    `resource_metadata="${resourceMetadataUrl(origin)}"`,
  ].join(", ");
}

export async function verifyBearerToken(
  request: Request,
  issuer: string,
  origin: string,
): Promise<VerifyResult> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return {
      ok: false,
      response: unauthorized(origin, "Authorization needed"),
    };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), { issuer });
    return { ok: true, verified: { token, payload } };
  } catch {
    return {
      ok: false,
      response: unauthorized(origin, "Invalid bearer token"),
    };
  }
}

function unauthorized(origin: string, description: string): Response {
  return new Response(JSON.stringify({ error: description }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": buildWwwAuthenticate(origin, description),
    },
  });
}
