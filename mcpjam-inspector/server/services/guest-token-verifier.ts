import {
  createHash,
  createPublicKey,
  createVerify,
  type KeyObject,
} from "crypto";
import { fetchRemoteGuestJwks } from "../utils/guest-session-source.js";
import { logger } from "../utils/logger.js";
import {
  GUEST_ISSUER,
  type GuestJwk,
  getGuestPublicKeyObject,
} from "./guest-token-keypair.js";

const HOSTED_GUEST_JWKS_CACHE_MS = 5 * 60 * 1000;

type ParsedGuestToken = {
  header: Record<string, unknown>;
  payload: { iss: string; sub: string; exp: number };
  signingInput: string;
  signature: string;
};

let hostedGuestPublicKeysCache:
  | {
      fetchedAt: number;
      keysByKid: Map<string, KeyObject>;
      fallbackKey: KeyObject | null;
    }
  | undefined;

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

function parseGuestToken(token: string):
  | { parsed: ParsedGuestToken }
  | { reason: string } {
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
    ) as Partial<{ iss: string; sub: string; exp: number }> | undefined;

    if (!payload || payload.iss !== GUEST_ISSUER) {
      return { reason: "issuer_mismatch" };
    }

    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return { reason: "missing_claims" };
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

function resolveKeyFromCache(kid: string | undefined): KeyObject | null {
  if (!hostedGuestPublicKeysCache) return null;
  if (kid && hostedGuestPublicKeysCache.keysByKid.has(kid)) {
    return hostedGuestPublicKeysCache.keysByKid.get(kid) ?? null;
  }
  return hostedGuestPublicKeysCache.fallbackKey;
}

async function fetchAndCacheHostedGuestKeys(
  kid: string | undefined,
): Promise<KeyObject | null> {
  const now = Date.now();
  try {
    const response = await fetchRemoteGuestJwks();

    if (!response) {
      logger.warn("[guest-auth] Failed to fetch hosted guest JWKS: unavailable");
      return resolveKeyFromCache(kid);
    }

    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch hosted guest JWKS: ${response.status} ${response.statusText}`,
      );
      return resolveKeyFromCache(kid);
    }

    const body = (await response.json()) as {
      keys?: GuestJwk[];
    };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const keysByKid = new Map<string, KeyObject>();
    let fallbackKey: KeyObject | null = null;

    for (const jwk of keys) {
      try {
        const nextKey = createPublicKey({
          key: jwk as JsonWebKey,
          format: "jwk",
        });
        if (!fallbackKey) {
          fallbackKey = nextKey;
        }
        if (typeof jwk.kid === "string") {
          keysByKid.set(jwk.kid, nextKey);
        }
      } catch {
        // Skip malformed keys.
      }
    }

    hostedGuestPublicKeysCache = {
      fetchedAt: now,
      keysByKid,
      fallbackKey,
    };

    if (kid && keysByKid.has(kid)) {
      return keysByKid.get(kid) ?? null;
    }
    return fallbackKey;
  } catch (error) {
    logger.warn(
      `[guest-auth] Failed to fetch hosted guest JWKS: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return resolveKeyFromCache(kid);
  }
}

async function getHostedGuestVerificationKey(
  kid: string | undefined,
): Promise<KeyObject | null> {
  const now = Date.now();
  const cacheIsValid =
    hostedGuestPublicKeysCache &&
    now - hostedGuestPublicKeysCache.fetchedAt < HOSTED_GUEST_JWKS_CACHE_MS;

  if (cacheIsValid) {
    if (kid && hostedGuestPublicKeysCache.keysByKid.has(kid)) {
      return hostedGuestPublicKeysCache.keysByKid.get(kid) ?? null;
    }
    if (kid) {
      return fetchAndCacheHostedGuestKeys(kid);
    }
    return hostedGuestPublicKeysCache.fallbackKey;
  }

  return fetchAndCacheHostedGuestKeys(kid);
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

  const hostedKey = await getHostedGuestVerificationKey(
    typeof parsed.parsed.header.kid === "string"
      ? parsed.parsed.header.kid
      : undefined,
  );
  if (!hostedKey) {
    return { valid: false, reason: "hosted_key_unavailable" };
  }

  const hostedSignatureResult = verifyGuestTokenSignature(
    parsed.parsed.signingInput,
    parsed.parsed.signature,
    hostedKey,
  );
  if (!hostedSignatureResult.valid) {
    return { valid: false, reason: hostedSignatureResult.reason };
  }

  return { valid: true, guestId: parsed.parsed.payload.sub };
}
