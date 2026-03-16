/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker) by fetching a guest session
 * from Convex.
 */

import { logger } from "./logger.js";
import { fetchRemoteGuestSession } from "./guest-session-source.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a Bearer authorization header for unauthenticated MCPJam model calls.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return `Bearer ${cachedToken.token}`;
  }

  const session = await fetchRemoteGuestSession();
  if (!session) {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      logger.warn(
        "[guest-auth] Failed to refresh guest token; reusing cached token until expiry",
      );
      return `Bearer ${cachedToken.token}`;
    }
    return null;
  }

  cachedToken = { token: session.token, expiresAt: session.expiresAt };
  logger.info("[guest-auth] Fetched guest token for MCPJam model request");
  return `Bearer ${session.token}`;
}
