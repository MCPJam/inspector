/**
 * Guest Token Service
 *
 * HMAC-signed stateless tokens for unauthenticated visitors.
 * Provides abuse prevention (rate limiting) for the open OAuth proxy
 * without requiring login.
 *
 * Token format: base64url(payload).base64url(signature)
 * Payload: { guestId, iat, exp }
 */

import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { randomUUID } from "crypto";

const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let secret: Buffer;

/**
 * Initialize the HMAC secret for guest tokens.
 * Reads from GUEST_TOKEN_SECRET env var or generates a random secret.
 * Must be called once at server startup.
 */
export function initGuestTokenSecret(): void {
  const envSecret = process.env.GUEST_TOKEN_SECRET;
  if (envSecret) {
    if (!/^[0-9a-fA-F]{64}$/.test(envSecret)) {
      console.warn(
        "GUEST_TOKEN_SECRET must be exactly 64 hex characters (32 bytes). " +
          "Falling back to a random secret.",
      );
      secret = randomBytes(32);
    } else {
      secret = Buffer.from(envSecret, "hex");
    }
  } else {
    secret = randomBytes(32);
  }
}

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Issue a new guest token with a unique guestId.
 * Returns the token string and metadata.
 */
export function issueGuestToken(): {
  guestId: string;
  token: string;
  expiresAt: number;
} {
  const guestId = randomUUID();
  const iat = Date.now();
  const exp = iat + GUEST_TOKEN_TTL_MS;

  const payload = JSON.stringify({ guestId, iat, exp });
  const encodedPayload = base64urlEncode(payload);
  const signature = sign(encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  return { guestId, token, expiresAt: exp };
}

/**
 * Validate a guest token. Verifies HMAC signature and expiry.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateGuestToken(token: string): {
  valid: boolean;
  guestId?: string;
} {
  if (!token || typeof token !== "string") {
    return { valid: false };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false };
  }

  const [encodedPayload, providedSignature] = parts;

  // Verify HMAC signature
  const expectedSignature = sign(encodedPayload);
  const providedBuf = Buffer.from(providedSignature, "base64url");
  const expectedBuf = Buffer.from(expectedSignature, "base64url");

  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false };
  }

  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false };
  }

  // Decode and check expiry
  try {
    const payload = JSON.parse(
      base64urlDecode(encodedPayload).toString("utf-8"),
    );

    if (!payload.guestId || !payload.exp) {
      return { valid: false };
    }

    if (Date.now() > payload.exp) {
      return { valid: false };
    }

    return { valid: true, guestId: payload.guestId };
  } catch {
    return { valid: false };
  }
}
