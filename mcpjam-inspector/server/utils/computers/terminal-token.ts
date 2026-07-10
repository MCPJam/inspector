/**
 * Computer terminal token verification (data-plane side).
 *
 * Convex mints these (mcpjam-backend `projectComputers.mintTerminalToken`,
 * lib `computerTerminalToken.ts`) and the browser presents one when opening
 * the terminal WebSocket. The claim contract is owned by the backend lib;
 * this file is its verify-only mirror and must stay in lockstep:
 *   iss      'https://api.mcpjam.com/computer-terminal'
 *   purpose  'computer-terminal'  (REQUIRED — rejects every other JWT population)
 *   sub      Convex users id (owner)   computerId / projectId   exp ~60s
 *
 * Verification dispatches on the token's own `alg` header, and the key
 * material is selected BY algorithm — which forecloses alg-confusion (an
 * HS256 token HMAC'd with the public-key bytes finds only the shared secret
 * on the HS256 path, never the public key):
 *
 *   RS256 — verified against the backend-published JWKS
 *     (`GET {CONVEX_HTTP_URL}/computers/terminal-jwks`, kid
 *     `computer-terminal-1`), fetched with a short cache. This is the
 *     endgame: the inspector holds verify-only material and can never mint.
 *   HS256 — the shared `COMPUTERS_TERMINAL_TOKEN_SECRET`, kept as the
 *     migration fallback until the backend key flip.
 *   anything else (including `none`) — rejected.
 *
 * Fails closed (`null`) whenever the matching key material is unavailable —
 * secret unconfigured, `CONVEX_HTTP_URL` unset, or JWKS unreachable.
 *
 * The token deliberately carries only MCPJam row ids. The vendor sandbox id
 * is resolved server-side via the secret-gated `/computers/sandbox-info`
 * Convex route, so a browser holding this token learns nothing vendor-side.
 */
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { logger } from "../logger.js";

const ISSUER = "https://api.mcpjam.com/computer-terminal";
const PURPOSE = "computer-terminal";
const MIN_SECRET_LENGTH = 16;

const JWKS_PATH = "/computers/terminal-jwks";
const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** Matches the endpoint's own Cache-Control (max-age=300). */
const JWKS_CACHE_MS = 5 * 60_000;
/** A failed/empty fetch is remembered briefly so a burst of RS256 handshakes
 *  against a broken JWKS can't hammer Convex. */
const JWKS_FAILURE_COOLDOWN_MS = 30_000;

export interface ComputerTerminalClaims {
  userId: string;
  computerId: string;
  projectId: string;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const base64 =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let cachedJwks: {
  url: string;
  fetchedAt: number;
  /** Null records a failed/empty fetch (kept for the failure cooldown). */
  keyset: ReturnType<typeof createLocalJWKSet> | null;
} | null = null;

type TerminalKeySet = ReturnType<typeof createLocalJWKSet>;

/** A fetch in progress, shared by every concurrent caller for the same URL so
 *  a cold cache under a burst of handshakes triggers ONE network call, not
 *  one per handshake (and a broken endpoint one per cooldown window, not one
 *  per handshake). Reset to null once it settles into `cachedJwks`. */
let inFlightJwks: { url: string; promise: Promise<TerminalKeySet | null> } | null =
  null;

export function resetComputerTerminalJwksCacheForTests(): void {
  cachedJwks = null;
  inFlightJwks = null;
}

async function fetchTerminalJwks(url: string): Promise<TerminalKeySet | null> {
  let keyset: TerminalKeySet | null = null;
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
        `[computers] terminal JWKS fetch failed (status ${response.status})`
      );
    }
  } catch (error) {
    logger.warn("[computers] terminal JWKS fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  cachedJwks = { url, fetchedAt: Date.now(), keyset };
  return keyset;
}

/** The backend-published terminal JWKS, cached per URL. Returns null (fail
 *  closed) when CONVEX_HTTP_URL is unset, the fetch fails, or the document
 *  has no keys (backend keypair not configured/validated yet). */
async function getTerminalJwks(): Promise<TerminalKeySet | null> {
  const base = process.env.CONVEX_HTTP_URL?.trim();
  if (!base) return null;
  let url: string;
  try {
    url = new URL(JWKS_PATH, base).toString();
  } catch {
    return null;
  }
  if (cachedJwks && cachedJwks.url === url) {
    const age = Date.now() - cachedJwks.fetchedAt;
    const ttl = cachedJwks.keyset ? JWKS_CACHE_MS : JWKS_FAILURE_COOLDOWN_MS;
    if (age < ttl) return cachedJwks.keyset;
  }
  // Collapse concurrent cold fetches onto one in-flight request.
  if (inFlightJwks && inFlightJwks.url === url) return inFlightJwks.promise;
  const promise = fetchTerminalJwks(url);
  inFlightJwks = { url, promise };
  try {
    return await promise;
  } finally {
    if (inFlightJwks?.promise === promise) inFlightJwks = null;
  }
}

/** Shape-checks the shared claim contract and narrows to our claims type. */
function toTerminalClaims(
  payload: Record<string, unknown>
): ComputerTerminalClaims | null {
  if (payload.purpose !== PURPOSE) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (
    typeof payload.computerId !== "string" ||
    payload.computerId.length === 0
  ) {
    return null;
  }
  if (typeof payload.projectId !== "string" || payload.projectId.length === 0) {
    return null;
  }
  return {
    userId: payload.sub,
    computerId: payload.computerId,
    projectId: payload.projectId,
  };
}

async function verifyRs256TerminalToken(
  token: string
): Promise<ComputerTerminalClaims | null> {
  const jwks = await getTerminalJwks();
  if (!jwks) return null;
  try {
    // `requiredClaims: ["exp"]` keeps the RS256 path as strict about token
    // lifetime as the HS256 path below: jose rejects an EXPIRED exp but does
    // not, on its own, require exp to be PRESENT — a token minted without one
    // would otherwise verify as never-expiring.
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    return toTerminalClaims(payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Verify a terminal token per the header-alg dispatch documented above.
 * Returns the claims or `null`; never throws on malformed input.
 */
export async function verifyComputerTerminalToken(
  token: string
): Promise<ComputerTerminalClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;

  let alg: unknown;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return null;
  }
  if (alg === "RS256") {
    return verifyRs256TerminalToken(token);
  }
  if (alg !== "HS256") {
    return null;
  }

  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = base64UrlToBytes(s);
    // Copy into a standalone ArrayBuffer — the server tsconfig has no DOM
    // lib, so subtle.verify's BufferSource parameter needs an exact match.
    const signature = sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength
    ) as ArrayBuffer;
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${h}.${p}`)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
  } catch {
    return null;
  }
  if (payload.iss !== ISSUER) return null;
  if (typeof payload.exp !== "number") return null;
  // JWT NumericDate semantics: the token is expired AT `exp`, not after it.
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  return toTerminalClaims(payload);
}
