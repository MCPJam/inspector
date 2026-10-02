import {
  createHash,
  createPublicKey,
  createVerify,
  type KeyObject,
} from "crypto";
import { fetchGuestJwks } from "../utils/guest-session-source.js";
import { getGuestAuthority } from "../utils/guest-authority.js";
import { logger } from "../utils/logger.js";
import {
  GUEST_ISSUER,
  type GuestJwk,
  getGuestPublicKeyObject,
} from "./guest-token-keypair.js";

/** How long a fetched authority key set is trusted before a routine refresh. */
const AUTHORITY_JWKS_CACHE_MS = 5 * 60 * 1000;
/**
 * Minimum gap between refreshes forced by an unknown `kid`. A rotation is
 * picked up on the first token that names the new key, without letting a
 * stream of garbage `kid`s turn every request into a JWKS fetch.
 */
const UNKNOWN_KID_REFRESH_INTERVAL_MS = 30 * 1000;
/** After a failed refresh, wait this long before trying again. */
const FAILED_REFRESH_BACKOFF_MS = 30 * 1000;
/**
 * The longest a key set is trusted while its authority's JWKS cannot be
 * fetched. Bounded so a key retired by a rotation does not stay trusted for as
 * long as the outage lasts.
 */
const AUTHORITY_JWKS_MAX_STALE_MS = 60 * 60 * 1000;

type ParsedGuestToken = {
  header: Record<string, unknown>;
  payload: { iss: string; sub: string; exp: number };
  signingInput: string;
  signature: string;
};

type AuthorityKeySet = {
  /** The JWKS URL these keys came from; a different authority never reuses them. */
  jwksUrl: string;
  fetchedAt: number;
  keysByKid: Map<string, KeyObject>;
};

let authorityKeysCache: AuthorityKeySet | undefined;
let lastUnknownKidRefreshAt = 0;
let lastFailedRefreshAt = 0;

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function verifyGuestTokenSignature(
  signingInput: string,
  signature: string,
  verificationKey: KeyObject,
): { valid: boolean; reason?: string } {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    if (!verifier.verify(verificationKey, signature, "base64url")) {
      return { valid: false, reason: "signature_invalid" };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "signature_error" };
  }
}

function parseGuestToken(
  token: string,
): { parsed: ParsedGuestToken } | { reason: string } {
  if (!token || typeof token !== "string") {
    return { reason: "missing_token" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { reason: "malformed_token" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  try {
    const header = JSON.parse(
      base64urlDecode(encodedHeader).toString("utf-8"),
    ) as Record<string, unknown> | undefined;
    if (!header || header.alg !== "RS256") {
      return { reason: "invalid_alg" };
    }

    const payload = JSON.parse(
      base64urlDecode(encodedPayload).toString("utf-8"),
    ) as
      | Partial<{ iss: string; sub: string; exp: number; purpose: unknown }>
      | undefined;

    if (!payload || payload.iss !== GUEST_ISSUER) {
      return { reason: "issuer_mismatch" };
    }

    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return { reason: "missing_claims" };
    }

    // A promotion proof carries `purpose`; it is not a session bearer and must
    // never be accepted as one (the backend refuses it the same way).
    if (payload.purpose !== undefined) {
      return { reason: "not_a_session_bearer" };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= payload.exp) {
      return { reason: "expired" };
    }

    return {
      parsed: {
        header,
        payload: {
          iss: payload.iss,
          sub: payload.sub,
          exp: payload.exp,
        },
        signingInput: `${encodedHeader}.${encodedPayload}`,
        signature,
      },
    };
  } catch {
    return { reason: "invalid_payload" };
  }
}

async function refreshAuthorityKeys(
  jwksUrl: string,
): Promise<AuthorityKeySet | undefined> {
  try {
    const response = await fetchGuestJwks();
    if (!response) {
      logger.warn("[guest-auth] Failed to fetch guest JWKS: unavailable");
      return undefined;
    }
    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch guest JWKS: ${response.status} ${response.statusText}`,
      );
      return undefined;
    }

    const body = (await response.json()) as { keys?: GuestJwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const keysByKid = new Map<string, KeyObject>();
    for (const jwk of keys) {
      // A key without a `kid` cannot be selected unambiguously, so it is never
      // used: falling back to "whichever key came first" is how a token signed
      // by a retired key would end up checked against the wrong one.
      if (typeof jwk.kid !== "string" || !jwk.kid) continue;
      try {
        keysByKid.set(
          jwk.kid,
          createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
        );
      } catch {
        // Skip malformed keys.
      }
    }

    authorityKeysCache = { jwksUrl, fetchedAt: Date.now(), keysByKid };
    return authorityKeysCache;
  } catch (error) {
    logger.warn(
      `[guest-auth] Failed to fetch guest JWKS: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * The selected authority's key for `kid`, or null.
 *
 * Strict by design: a token must name a `kid` the authority currently
 * publishes. An unknown `kid` forces one bounded refresh — that is the
 * verification-cache refresh a key rotation relies on — and if the refreshed
 * set still lacks it, the token is refused. There is no "fallback key".
 */
async function getAuthorityVerificationKey(
  kid: string | undefined,
): Promise<KeyObject | null> {
  if (!kid) return null;
  let jwksUrl: string;
  try {
    jwksUrl = getGuestAuthority().jwksUrl;
  } catch {
    return null;
  }

  const now = Date.now();
  let keySet =
    authorityKeysCache?.jwksUrl === jwksUrl ? authorityKeysCache : undefined;
  const refresh = async () => {
    if (now - lastFailedRefreshAt < FAILED_REFRESH_BACKOFF_MS) return keySet;
    const fresh = await refreshAuthorityKeys(jwksUrl);
    if (!fresh) lastFailedRefreshAt = now;
    return fresh ?? keySet;
  };
  if (!keySet || now - keySet.fetchedAt >= AUTHORITY_JWKS_CACHE_MS) {
    keySet = await refresh();
  } else if (
    !keySet.keysByKid.has(kid) &&
    now - lastUnknownKidRefreshAt >= UNKNOWN_KID_REFRESH_INTERVAL_MS
  ) {
    lastUnknownKidRefreshAt = now;
    keySet = await refresh();
  }
  if (keySet && Date.now() - keySet.fetchedAt >= AUTHORITY_JWKS_MAX_STALE_MS) {
    return null;
  }
  return keySet?.keysByKid.get(kid) ?? null;
}

/** Test seam: drop cached authority keys and the unknown-kid throttle. */
export function resetGuestJwksCacheForTests(): void {
  authorityKeysCache = undefined;
  lastUnknownKidRefreshAt = 0;
  lastFailedRefreshAt = 0;
}

export function getGuestTokenFingerprint(
  token: string | null | undefined,
): string {
  if (!token || typeof token !== "string") {
    return "none";
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function validateGuestToken(token: string): {
  valid: boolean;
  guestId?: string;
} {
  const result = validateGuestTokenDetailed(token);
  return result.valid
    ? { valid: true, guestId: result.guestId }
    : { valid: false };
}

export function validateGuestTokenDetailed(token: string): {
  valid: boolean;
  guestId?: string;
  reason?: string;
} {
  const localPublicKey = getGuestPublicKeyObject();
  if (!localPublicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }

  const parsed = parseGuestToken(token);
  if (!("parsed" in parsed)) {
    return { valid: false, reason: parsed.reason };
  }

  const signatureResult = verifyGuestTokenSignature(
    parsed.parsed.signingInput,
    parsed.parsed.signature,
    localPublicKey,
  );
  if (!signatureResult.valid) {
    return { valid: false, reason: signatureResult.reason };
  }

  return { valid: true, guestId: parsed.parsed.payload.sub };
}

/**
 * Is `token` a guest bearer issued by the SELECTED guest authority?
 *
 * Verified against the authority's published keys (`getGuestAuthority()`),
 * matched by `kid`. The in-process key pair is consulted only when something
 * explicitly initialized it (`initGuestTokenSecret()`, tests and the legacy
 * signer); the running server never does, because the local key is not an
 * authority any backend trusts.
 *
 * `valid: false` means "not a guest of this authority" — NOT "a member". A
 * caller deciding membership must verify that separately and positively.
 */
export async function validateGuestTokenDetailedAsync(token: string): Promise<{
  valid: boolean;
  guestId?: string;
  reason?: string;
}> {
  const parsed = parseGuestToken(token);
  if (!("parsed" in parsed)) {
    return { valid: false, reason: parsed.reason };
  }

  const localPublicKey = getGuestPublicKeyObject();
  if (localPublicKey) {
    const localSignatureResult = verifyGuestTokenSignature(
      parsed.parsed.signingInput,
      parsed.parsed.signature,
      localPublicKey,
    );
    if (localSignatureResult.valid) {
      return { valid: true, guestId: parsed.parsed.payload.sub };
    }
  }

  const authorityKey = await getAuthorityVerificationKey(
    typeof parsed.parsed.header.kid === "string"
      ? parsed.parsed.header.kid
      : undefined,
  );
  if (!authorityKey) {
    return { valid: false, reason: "authority_key_unavailable" };
  }

  const signatureResult = verifyGuestTokenSignature(
    parsed.parsed.signingInput,
    parsed.parsed.signature,
    authorityKey,
  );
  if (!signatureResult.valid) {
    return { valid: false, reason: signatureResult.reason };
  }

  return { valid: true, guestId: parsed.parsed.payload.sub };
}
