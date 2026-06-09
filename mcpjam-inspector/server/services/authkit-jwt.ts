import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";

/**
 * WorkOS AuthKit access-token verification for the `/api/web/api-keys`
 * management surface.
 *
 * Why this exists: those routes perform privileged side effects (mint / list /
 * revoke WorkOS API keys with the server-side admin `WORKOS_API_KEY`, and
 * create/remove Convex org bindings) scoped to the caller's `sub`. Every other
 * `/api/web/*` route forwards the bearer to Convex, which verifies the AuthKit
 * JWT signature — but these routes call WorkOS/Convex-bindings directly and so
 * MUST verify the token themselves before trusting any claim. Decoding the
 * payload without signature verification (the previous behaviour) let a forged
 * bearer drive key lifecycle operations against another user's `sub`.
 *
 * The issuer/JWKS/audience set is mirrored byte-for-byte from the backend's
 * `convex/auth.config.ts` so Inspector accepts exactly the tokens Convex
 * already accepts — verifying here never rejects a token Convex would honor.
 * Client ids are public identifiers, not secrets.
 */

// Mirrors mcpjam-backend/convex/lib/authkit.ts.
const PRODUCTION_WORKOS_CLIENT_ID = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
const STAGING_WORKOS_CLIENT_ID = "client_01K4C1TVA6CMQ3G32F1P301A9G";
const DEVELOPMENT_WORKOS_CLIENT_ID = "client_01KTN2EWHHJCKRB8RSR307X4SG";
const PRODUCTION_AUTHKIT_DOMAIN = "login.mcpjam.com";
const STAGING_AUTHKIT_DOMAIN = "dynamic-echo-14-staging.authkit.app";
const DEVELOPMENT_AUTHKIT_DOMAIN = "deep-vanilla-68-test.authkit.app";

/** Raised when the server is missing the config needed to verify (→ 500). */
export class AuthKitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthKitConfigError";
  }
}

/** Raised when a token fails verification (→ 401). Never leaks the token. */
export class AuthKitVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthKitVerificationError";
  }
}

function normalizeDomain(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function resolveWorkosClientId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // Inspector ships the client id to the browser as VITE_WORKOS_CLIENT_ID;
  // it's the same id AuthKit issues tokens for. WORKOS_CLIENT_ID overrides.
  return env.WORKOS_CLIENT_ID || env.VITE_WORKOS_CLIENT_ID || undefined;
}

function deriveAuthkitDomain(clientId: string): string | undefined {
  switch (clientId) {
    case PRODUCTION_WORKOS_CLIENT_ID:
      return PRODUCTION_AUTHKIT_DOMAIN;
    case STAGING_WORKOS_CLIENT_ID:
      return STAGING_AUTHKIT_DOMAIN;
    case DEVELOPMENT_WORKOS_CLIENT_ID:
      return DEVELOPMENT_AUTHKIT_DOMAIN;
    default:
      return undefined;
  }
}

function resolveAuthkitIssuer(
  clientId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const domain = normalizeDomain(
    env.AUTHKIT_DOMAIN || deriveAuthkitDomain(clientId),
  );
  return domain ? `https://${domain}` : undefined;
}

/**
 * Allowed issuer → JWKS URL, mirroring `convex/auth.config.ts`. The token's
 * `iss` selects the JWKS; an issuer absent from this map is rejected. The guest
 * issuer is intentionally excluded — API-key management is JWT-only and guests
 * cannot manage keys.
 */
export function authkitIssuerJwks(
  clientId: string,
  env: NodeJS.ProcessEnv = process.env,
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
  const authkitIssuer = resolveAuthkitIssuer(clientId, env);
  if (authkitIssuer) {
    map.set(authkitIssuer, `${authkitIssuer}/oauth2/jwks`);
  }
  return map;
}

// One remote JWKS per URL (jose caches the fetched keys internally per set).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function remoteJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

export interface VerifiedSession {
  /** WorkOS user id (the user's Convex `externalId`). */
  sub: string;
  /** Active WorkOS organization id, if present on the token. */
  orgId?: string;
}

type KeyResolver = ReturnType<typeof createRemoteJWKSet> | KeyLike;

export interface AuthKitVerifyDeps {
  /** Expected `aud` of the access token. */
  clientId: string;
  /** Key/JWKS for an allowed issuer, or `null` to reject the issuer. */
  resolveKey: (issuer: string) => KeyResolver | null;
}

function defaultDeps(): AuthKitVerifyDeps {
  const clientId = resolveWorkosClientId();
  if (!clientId) {
    throw new AuthKitConfigError(
      "WORKOS_CLIENT_ID (or VITE_WORKOS_CLIENT_ID) is not configured",
    );
  }
  const issuers = authkitIssuerJwks(clientId);
  return {
    clientId,
    resolveKey: (issuer) => {
      const jwksUrl = issuers.get(issuer);
      return jwksUrl ? remoteJwks(jwksUrl) : null;
    },
  };
}

/**
 * Verify a WorkOS AuthKit access token and return only the claims we trust
 * (`sub`, `org_id`). Throws `AuthKitVerificationError` on any failure
 * (malformed, untrusted issuer, bad signature, wrong audience, expired/nbf).
 *
 * `deps` is injectable for tests; production uses the env-derived issuer set.
 */
export async function verifyAuthKitToken(
  token: string,
  deps: AuthKitVerifyDeps = defaultDeps(),
): Promise<VerifiedSession> {
  // Read the (unverified) issuer ONLY to pick the matching JWKS. The actual
  // trust decision is `jwtVerify` below — signature + issuer pin + audience +
  // exp/nbf — so a spoofed `iss` cannot grant access (it must also be in the
  // allow-list AND be signed by that issuer's keys).
  let unverifiedIssuer: string | undefined;
  try {
    unverifiedIssuer = decodeJwt(token).iss;
  } catch {
    throw new AuthKitVerificationError("Malformed session token");
  }
  if (!unverifiedIssuer) {
    throw new AuthKitVerificationError("Session token missing issuer");
  }

  const key = deps.resolveKey(unverifiedIssuer);
  if (!key) {
    throw new AuthKitVerificationError("Untrusted session token issuer");
  }
  // Normalize to a key-getter so the overload is unambiguous: a remote JWKS is
  // already a function; a static key (tests / injected deps) is wrapped.
  const getKey: JWTVerifyGetKey =
    typeof key === "function" ? (key as JWTVerifyGetKey) : async () => key;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: unverifiedIssuer,
      audience: deps.clientId,
      algorithms: ["RS256"],
      clockTolerance: 5,
    }));
  } catch (error) {
    throw new AuthKitVerificationError(
      error instanceof Error ? error.message : "Token verification failed",
    );
  }

  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!sub) {
    throw new AuthKitVerificationError("Verified token is missing `sub`");
  }
  const orgIdClaim = (payload as { org_id?: unknown }).org_id;
  const orgId = typeof orgIdClaim === "string" ? orgIdClaim : undefined;
  return { sub, orgId };
}
