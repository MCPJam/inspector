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
  createSign,
  createVerify,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "crypto";
import { logger } from "../utils/logger.js";

const GUEST_TOKEN_TTL_S = 24 * 60 * 60; // 24 hours in seconds
const GUEST_ISSUER = "https://api.mcpjam.com/guest";
const KID = "guest-1";

let privateKey: KeyObject;
let publicKey: KeyObject;
let jwks: { keys: JsonWebKey[] };

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

/**
 * Initialize the RS256 key pair for guest JWTs.
 * Reads PEM from GUEST_JWT_PRIVATE_KEY env var or generates an ephemeral pair.
 * Must be called once at server startup.
 */
export function initGuestTokenSecret(): void {
  const envPrivate = process.env.GUEST_JWT_PRIVATE_KEY;
  const envPublic = process.env.GUEST_JWT_PUBLIC_KEY;

  if (envPrivate && envPublic) {
    try {
      privateKey = createPrivateKey(envPrivate);
      publicKey = createPublicKey(envPublic);
      logger.info("Guest JWT: using keys from environment");
    } catch (e) {
      logger.warn(
        "Guest JWT: failed to parse env key pair, generating ephemeral keys",
      );
      generateEphemeralKeyPair();
    }
  } else {
    generateEphemeralKeyPair();
  }

  // Build JWKS from the public key
  const jwk = publicKey.export({ format: "jwk" });
  jwks = {
    keys: [
      {
        ...jwk,
        kid: KID,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

function generateEphemeralKeyPair(): void {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
}

/**
 * Returns the JWKS document for the guest issuer.
 * Serve this at /guest/jwks (or /.well-known/jwks.json).
 */
export function getGuestJwks(): { keys: JsonWebKey[] } {
  if (!jwks) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return jwks;
}

/** Returns the guest token issuer URL. */
export function getGuestIssuer(): string {
  return GUEST_ISSUER;
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
  if (!publicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }

  if (!token || typeof token !== "string") {
    return { valid: false };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  // Verify RS256 signature
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    if (!verifier.verify(publicKey, signature, "base64url")) {
      return { valid: false };
    }
  } catch {
    return { valid: false };
  }

  // Decode and validate claims
  try {
    const header = JSON.parse(base64urlDecode(encodedHeader).toString("utf-8"));
    if (header.alg !== "RS256") {
      return { valid: false };
    }

    const payload = JSON.parse(
      base64urlDecode(encodedPayload).toString("utf-8"),
    );

    if (payload.iss !== GUEST_ISSUER) {
      return { valid: false };
    }

    if (!payload.sub || !payload.exp) {
      return { valid: false };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > payload.exp) {
      return { valid: false };
    }

    return { valid: true, guestId: payload.sub };
  } catch {
    return { valid: false };
  }
}
