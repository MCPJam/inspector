/**
 * Session Token Service
 *
 * Provides secure session token generation and validation for API authentication.
 *
 * Security features:
 * - 192-bit cryptographically random token (2^192 brute force resistance)
 * - Timing-safe comparison to prevent timing attacks
 * - Token generated fresh on each server start
 */

import { randomBytes, timingSafeEqual } from "crypto";

let sessionToken: string | null = null;

/**
 * Generate a new 192-bit session token.
 * Called once at server startup.
 *
 * @returns The generated token (32 URL-safe characters)
 */
export function generateSessionToken(): string {
  const configured = process.env.MCPJAM_SESSION_TOKEN;
  delete process.env.MCPJAM_SESSION_TOKEN;
  if (configured !== undefined && !/^[A-Za-z0-9_-]{24,}$/.test(configured)) {
    throw new Error(
      "MCPJAM_SESSION_TOKEN must contain at least 24 URL-safe letters, digits, underscores or hyphens",
    );
  }
  sessionToken = configured ?? randomBytes(24).toString("base64url");
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
