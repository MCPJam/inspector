/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker).
 *
 * The token is issued locally using the same key pair configured via
 * GUEST_JWT_PRIVATE_KEY / GUEST_JWT_PUBLIC_KEY env vars (or ephemeral keys).
 * Convex validates these tokens against a JWKS endpoint — either the
 * inspector's /api/web/guest-jwks or the Convex HTTP /guest/jwks fallback.
 */

import { issueGuestToken } from "../services/guest-token.js";
import { logger } from "./logger.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a Bearer authorization header value using a locally-signed guest
 * JWT, or `null` if token issuance fails.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return `Bearer ${cachedToken.token}`;
  }

  try {
    const { token, expiresAt } = issueGuestToken();
    cachedToken = { token, expiresAt };
    logger.info("[guest-auth] Issued guest token for MCPJam model request");
    return `Bearer ${token}`;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to issue guest token: ${errMsg}`);
    return null;
  }
}
