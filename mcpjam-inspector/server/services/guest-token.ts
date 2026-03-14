/**
 * Guest Token Service
 *
 * RS256 JWT tokens for unauthenticated visitors.
 * Convex can natively verify these via the JWKS endpoint.
 *
 * Token format: standard JWT (header.payload.signature)
 * Payload: { iss, sub: guestId, iat, exp }
 */

import {
  generateKeyPairSync,
  createHash,
  createSign,
  createVerify,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { shouldUseLocalGuestSigning } from "../utils/guest-session-source.js";
import { logger } from "../utils/logger.js";

const GUEST_TOKEN_TTL_S = 24 * 60 * 60; // 24 hours in seconds
const GUEST_ISSUER = "https://api.mcpjam.com/guest";
const KID = "guest-2";
const LEGACY_KID = "guest-1";
const GUEST_JWT_KID_ROTATED_AT_ENV = "GUEST_JWT_KID_ROTATED_AT";
const DEFAULT_HOSTED_GUEST_JWKS_URL =
  "https://app.mcpjam.com/api/web/guest-jwks";
const HOSTED_GUEST_JWKS_CACHE_MS = 5 * 60 * 1000;

let privateKey: KeyObject;
let publicKey: KeyObject;
let hostedGuestPublicKeysCache:
  | {
      fetchedAt: number;
      keysByKid: Map<string, KeyObject>;
      fallbackKey: KeyObject | null;
    }
  | undefined;

function getLocalGuestKeyDir(): string {
  return process.env.GUEST_JWT_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getLocalGuestKeyPaths(): { privatePath: string; publicPath: string } {
  const dir = getLocalGuestKeyDir();
  return {
    privatePath: path.join(dir, "guest-jwt-private.pem"),
    publicPath: path.join(dir, "guest-jwt-public.pem"),
  };
}

function setKeyPair(nextPrivateKey: KeyObject, nextPublicKey: KeyObject): void {
  privateKey = nextPrivateKey;
  publicKey = nextPublicKey;
}

function createAndPersistLocalDevKeyPair(): void {
  const { privatePath, publicPath } = getLocalGuestKeyPaths();
  const dir = path.dirname(privatePath);
  mkdirSync(dir, { recursive: true });

  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });

  writeFileSync(privatePath, privatePem);
  writeFileSync(publicPath, publicPem);

  try {
    chmodSync(privatePath, 0o600);
    chmodSync(publicPath, 0o644);
  } catch {
    // Best effort. Some platforms/filesystems do not support chmod semantics.
  }

  setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
  logger.info(`Guest JWT: created local dev signing key pair at ${dir}`);
}

function loadPersistedLocalDevKeyPair(): boolean {
  const { privatePath, publicPath } = getLocalGuestKeyPaths();
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    return false;
  }

  try {
    const privatePem = readFileSync(privatePath, "utf-8");
    const publicPem = readFileSync(publicPath, "utf-8");
    setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
    logger.info(
      `Guest JWT: using local dev signing key pair from ${path.dirname(privatePath)}`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `Guest JWT: failed to load local dev key pair, regenerating (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

function warnAboutEphemeralKeys(reason: "missing" | "invalid"): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const baseMessage =
    "Guest JWT: using ephemeral signing keys in production. " +
    "Guest sessions will be invalid after restart unless " +
    "GUEST_JWT_PRIVATE_KEY and GUEST_JWT_PUBLIC_KEY are set.";

  if (reason === "invalid") {
    logger.warn(
      `${baseMessage} Falling back because the configured key pair could not be parsed.`,
    );
    return;
  }

  logger.warn(`${baseMessage} Falling back because the env vars are missing.`);
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function getHostedGuestJwksUrl(): string {
  return process.env.MCPJAM_GUEST_JWKS_URL || DEFAULT_HOSTED_GUEST_JWKS_URL;
}

function shouldPublishLegacyKid(now = Date.now()): boolean {
  if (process.env.NODE_ENV !== "production" || KID === LEGACY_KID) {
    return false;
  }

  const rotatedAt = process.env[GUEST_JWT_KID_ROTATED_AT_ENV];
  if (!rotatedAt) {
    return true;
  }

  const rotatedAtMs = Date.parse(rotatedAt);
  if (Number.isNaN(rotatedAtMs)) {
    logger.warn(
      `Guest JWT: invalid ${GUEST_JWT_KID_ROTATED_AT_ENV}; continuing to publish legacy kid ${LEGACY_KID} until it is fixed.`,
    );
    return true;
  }

  return now < rotatedAtMs + GUEST_TOKEN_TTL_S * 1000;
}

function buildGuestJwks(now = Date.now()): { keys: JsonWebKey[] } {
  const jwk = publicKey.export({ format: "jwk" });
  const keys: JsonWebKey[] = [
    {
      ...jwk,
      kid: KID,
      alg: "RS256",
      use: "sig",
    },
  ];

  if (shouldPublishLegacyKid(now)) {
    keys.push({
      ...jwk,
      kid: LEGACY_KID,
      alg: "RS256",
      use: "sig",
    });
  }

  return { keys };
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
  | {
      parsed: {
        header: Record<string, unknown>;
        payload: { iss: string; sub: string; exp: number };
        signingInput: string;
        signature: string;
      };
    }
  | {
      reason: string;
    } {
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

async function fetchAndCacheHostedGuestKeys(
  kid: string | undefined,
): Promise<KeyObject | null> {
  const now = Date.now();
  try {
    const response = await fetch(getHostedGuestJwksUrl(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch hosted guest JWKS: ${response.status} ${response.statusText}`,
      );
      // Keep serving stale cache on fetch failure
      return resolveKeyFromCache(kid);
    }

    const body = (await response.json()) as {
      keys?: Array<JsonWebKey & { kid?: string }>;
    };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const keysByKid = new Map<string, KeyObject>();
    let fallbackKey: KeyObject | null = null;

    for (const jwk of keys) {
      try {
        const nextKey = createPublicKey({
          key: jwk,
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
    // Keep serving stale cache on network failure
    return resolveKeyFromCache(kid);
  }
}

function resolveKeyFromCache(kid: string | undefined): KeyObject | null {
  if (!hostedGuestPublicKeysCache) return null;
  if (kid && hostedGuestPublicKeysCache.keysByKid.has(kid)) {
    return hostedGuestPublicKeysCache.keysByKid.get(kid) ?? null;
  }
  return hostedGuestPublicKeysCache.fallbackKey;
}

async function getHostedGuestVerificationKey(
  kid: string | undefined,
): Promise<KeyObject | null> {
  const now = Date.now();
  const cacheIsValid =
    hostedGuestPublicKeysCache &&
    now - hostedGuestPublicKeysCache.fetchedAt < HOSTED_GUEST_JWKS_CACHE_MS;

  if (cacheIsValid) {
    // Cache hit with matching kid — use it
    if (kid && hostedGuestPublicKeysCache!.keysByKid.has(kid)) {
      return hostedGuestPublicKeysCache!.keysByKid.get(kid) ?? null;
    }
    // Cache hit but kid not found — try a refresh (key rotation)
    if (kid) {
      return fetchAndCacheHostedGuestKeys(kid);
    }
    return hostedGuestPublicKeysCache!.fallbackKey;
  }

  // Cache expired or empty — fetch fresh keys
  return fetchAndCacheHostedGuestKeys(kid);
}

/**
 * Initialize the RS256 key pair for guest JWTs.
 * Reads PEM from GUEST_JWT_PRIVATE_KEY env var, or in local dev loads/generates
 * a stable key pair under ~/.mcpjam, or finally falls back to ephemeral keys.
 * Must be called once at server startup.
 */
export function initGuestTokenSecret(): void {
  const envPrivate = process.env.GUEST_JWT_PRIVATE_KEY;
  const envPublic = process.env.GUEST_JWT_PUBLIC_KEY;

  if (envPrivate && envPublic) {
    try {
      setKeyPair(createPrivateKey(envPrivate), createPublicKey(envPublic));
      logger.info("Guest JWT: using keys from environment");
    } catch (e) {
      logger.warn("Guest JWT: failed to parse env key pair");
      if (process.env.NODE_ENV !== "production") {
        if (!loadPersistedLocalDevKeyPair()) {
          createAndPersistLocalDevKeyPair();
        }
      } else {
        warnAboutEphemeralKeys("invalid");
        generateEphemeralKeyPair();
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    if (!loadPersistedLocalDevKeyPair()) {
      createAndPersistLocalDevKeyPair();
    }
  } else {
    warnAboutEphemeralKeys("missing");
    generateEphemeralKeyPair();
  }

}

function generateEphemeralKeyPair(): void {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  setKeyPair(pair.privateKey, pair.publicKey);
}

/**
 * Returns the JWKS document for the guest issuer.
 * Serve this at /api/web/guest-jwks.
 */
export function getGuestJwks(): { keys: JsonWebKey[] } {
  if (!publicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return buildGuestJwks();
}

/** Returns the guest token issuer URL. */
export function getGuestIssuer(): string {
  return GUEST_ISSUER;
}

/**
 * Returns the guest public key as a PEM string.
 * Used by the dev startup script to push the current key to Convex.
 */
export function getGuestPublicKeyPem(): string {
  if (!publicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}

/**
 * Returns a short, non-reversible fingerprint for log correlation.
 * Never log the raw guest token itself.
 */
export function getGuestTokenFingerprint(
  token: string | null | undefined,
): string {
  if (!token || typeof token !== "string") {
    return "none";
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Issue a new guest JWT with a unique guestId as `sub`.
 * Returns the signed JWT string and metadata.
 */
export function issueGuestToken(): {
  guestId: string;
  token: string;
  expiresAt: number;
} {
  if (!privateKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }

  const guestId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + GUEST_TOKEN_TTL_S;

  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = { iss: GUEST_ISSUER, sub: guestId, iat: now, exp };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKey, "base64url");

  const token = `${signingInput}.${signature}`;
  return { guestId, token, expiresAt: exp * 1000 };
}

/**
 * Validate a guest JWT. Verifies RS256 signature, issuer, and expiry.
 */
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
  if (!publicKey) {
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
    publicKey,
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
  if (!publicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }

  const parsed = parseGuestToken(token);
  if (!("parsed" in parsed)) {
    return { valid: false, reason: parsed.reason };
  }

  const localSignatureResult = verifyGuestTokenSignature(
    parsed.parsed.signingInput,
    parsed.parsed.signature,
    publicKey,
  );
  if (localSignatureResult.valid) {
    return { valid: true, guestId: parsed.parsed.payload.sub };
  }

  if (shouldUseLocalGuestSigning()) {
    return { valid: false, reason: localSignatureResult.reason };
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
