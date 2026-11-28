/**
 * A verify-only JWKS token verifier, parameterized by claim contract.
 *
 * Convex mints computer tokens; the inspector only ever verifies them, against
 * a backend-published JWKS. Every such surface needs the same machinery —
 * RS256-only, short cache, failure cooldown, concurrent-fetch collapsing, fail
 * closed when the key material is unavailable — and differs only in its issuer,
 * purpose claim and JWKS path.
 *
 * `terminal-token.ts` predates this factory and still carries its own copy. It
 * is live on the terminal WebSocket path, so it is deliberately NOT migrated
 * here in the same change that introduces the factory; the two are structurally
 * identical and either can adopt the other once this one has run in staging.
 *
 * Each call to `createComputerJwksVerifier` gets its own cache, so one
 * surface's broken JWKS can never serve another's tokens.
 */
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { logger } from "../logger.js";

const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** Matches the endpoints' own Cache-Control (max-age=300). */
const JWKS_CACHE_MS = 5 * 60_000;
/** A failed/empty fetch is remembered briefly so a burst of handshakes against
 *  a broken JWKS can't hammer Convex. */
const JWKS_FAILURE_COOLDOWN_MS = 30_000;

type KeySet = ReturnType<typeof createLocalJWKSet>;

/** The claims every computer token carries; the shape is shared across surfaces. */
export interface ComputerTokenClaims {
  userId: string;
  computerId?: string;
  sandboxRowId?: string;
  projectId: string;
  sessionId?: string;
}

export interface JwksVerifierSpec {
  /** The `iss` the token must carry, exactly. */
  issuer: string;
  /** The REQUIRED `purpose` claim — this is what stops one computer token
   *  population from being replayed against another surface. */
  purpose: string;
  /** Path of the backend JWKS endpoint, resolved against `CONVEX_HTTP_URL`. */
  jwksPath: string;
  /** Short name used in log lines only. */
  label: string;
}

export interface ComputerJwksVerifier {
  /** Verify a token; returns claims or `null`, never throws. */
  verify(token: string): Promise<ComputerTokenClaims | null>;
  /** Drop the cached keyset (tests only). */
  resetCacheForTests(): void;
}

/** The key-handling half, for a population with its own claim contract. */
export interface JwksPayloadVerifier {
  /**
   * The payload of an RS256 token signed by a key in the JWKS, issued by
   * `issuer`, with every claim in `requiredClaims` present. `null` for
   * anything else; never throws. A population whose tokens carry no `exp` on
   * purpose (harness session handles) passes no `exp` here.
   */
  verifyPayload(
    token: string,
    opts: { issuer: string; requiredClaims: string[] },
  ): Promise<Record<string, unknown> | null>;
  resetCacheForTests(): void;
}

export function createComputerJwksVerifier(
  spec: JwksVerifierSpec,
): ComputerJwksVerifier {
  const keys = createJwksPayloadVerifier(spec);
  /** Shape-checks the shared claim contract and narrows to the claims type. */
  function toClaims(
    payload: Record<string, unknown>,
  ): ComputerTokenClaims | null {
    if (payload.purpose !== spec.purpose) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0)
      return null;
    const hasComputer =
      typeof payload.computerId === "string" && payload.computerId.length > 0;
    const hasSandbox =
      typeof payload.sandboxRowId === "string" &&
      payload.sandboxRowId.length > 0;
    if (hasComputer === hasSandbox) return null;
    if (
      typeof payload.projectId !== "string" ||
      payload.projectId.length === 0
    ) {
      return null;
    }
    return {
      userId: payload.sub,
      ...(hasComputer ? { computerId: payload.computerId as string } : {}),
      ...(hasSandbox ? { sandboxRowId: payload.sandboxRowId as string } : {}),
      projectId: payload.projectId,
      ...(typeof payload.sessionId === "string" && payload.sessionId.length > 0
        ? { sessionId: payload.sessionId }
        : {}),
    };
  }
  return {
    async verify(token: string): Promise<ComputerTokenClaims | null> {
      // `exp` is required because jose rejects an EXPIRED exp but does not
      // require exp to be PRESENT — a token minted without one would
      // otherwise verify as never-expiring.
      const payload = await keys.verifyPayload(token, {
        issuer: spec.issuer,
        requiredClaims: ["exp"],
      });
      return payload ? toClaims(payload) : null;
    },
    resetCacheForTests: keys.resetCacheForTests,
  };
}

export function createJwksPayloadVerifier(
  spec: Pick<JwksVerifierSpec, "jwksPath" | "label">,
): JwksPayloadVerifier {
  let cached: {
    url: string;
    fetchedAt: number;
    /** Null records a failed/empty fetch (kept for the failure cooldown). */
    keyset: KeySet | null;
  } | null = null;

  /** A fetch in progress, shared by every concurrent caller for the same URL so
   *  a cold cache under a burst of handshakes triggers ONE network call. */
  let inFlight: { url: string; promise: Promise<KeySet | null> } | null = null;

  async function fetchJwks(url: string): Promise<KeySet | null> {
    let keyset: KeySet | null = null;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const doc = (await response.json()) as JSONWebKeySet;
        if (Array.isArray(doc?.keys) && doc.keys.length > 0) {
          keyset = createLocalJWKSet(doc);
        }
      } else {
        logger.warn(
          `[computers] ${spec.label} JWKS fetch failed (status ${response.status})`,
        );
      }
    } catch (error) {
      logger.warn(`[computers] ${spec.label} JWKS fetch error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    cached = { url, fetchedAt: Date.now(), keyset };
    return keyset;
  }

  /** The backend-published JWKS, cached per URL. Null (fail closed) when
   *  CONVEX_HTTP_URL is unset, the fetch fails, or the document has no keys
   *  (backend keypair not configured/validated yet). */
  async function getJwks(): Promise<KeySet | null> {
    const base = process.env.CONVEX_HTTP_URL?.trim();
    if (!base) return null;
    let url: string;
    try {
      url = new URL(spec.jwksPath, base).toString();
    } catch {
      return null;
    }
    if (cached && cached.url === url) {
      const age = Date.now() - cached.fetchedAt;
      const ttl = cached.keyset ? JWKS_CACHE_MS : JWKS_FAILURE_COOLDOWN_MS;
      if (age < ttl) return cached.keyset;
    }
    if (inFlight && inFlight.url === url) return inFlight.promise;
    const promise = fetchJwks(url);
    inFlight = { url, promise };
    try {
      return await promise;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  }

  return {
    async verifyPayload(token, opts) {
      // Reject a non-RS256 header before touching the network: `none` and
      // `HS256` must never reach a verifier that holds public key material.
      let alg: unknown;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        return null;
      }
      if (alg !== "RS256") return null;

      const jwks = await getJwks();
      if (!jwks) return null;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: opts.issuer,
          algorithms: ["RS256"],
          requiredClaims: opts.requiredClaims,
        });
        return payload as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    resetCacheForTests(): void {
      cached = null;
      inFlight = null;
    },
  };
}
