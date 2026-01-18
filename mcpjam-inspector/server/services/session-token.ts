/**
 * Session Token Service
 *
 * Provides secure session token generation and validation for API authentication.
 *
 * Security features:
 * - 256-bit cryptographically random token (2^256 brute force resistance)
 * - Timing-safe comparison to prevent timing attacks
 * - Token generated fresh on each server start
 */

import { randomBytes, timingSafeEqual } from "crypto";

let sessionToken: string | null = null;

/**
 * Generate a new 256-bit session token.
 * Called once at server startup.
 *
 * @returns The generated token (64 hex characters)
 */
export function generateSessionToken(): string {
  sessionToken = randomBytes(32).toString("hex");
  return sessionToken;
}

/**
 * Get the current session token.
 *
 * @returns The current token, or null if not yet generated
 */
export function getSessionToken(): string | null {
  return sessionToken;
}

/**
 * Validate a provided token using timing-safe comparison.
 * This prevents timing attacks that could leak information about the token.
 *
 * @param providedToken - The token to validate
 * @returns true if the token is valid, false otherwise
 */
export function validateToken(providedToken: string): boolean {
  if (!sessionToken || !providedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(sessionToken);

  // Length check first (prevents timing leak on length)
  if (provided.length !== expected.length) {
    return false;
  }

  // Timing-safe comparison
  return timingSafeEqual(provided, expected);
}
