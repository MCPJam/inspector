/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker) by fetching a guest session
 * from dev Convex in local development and from hosted Inspector in local
 * production runtimes.
 */

import { logger } from "./logger.js";
import { fetchGuestSessionForServerSideAuth } from "./guest-session-source.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

type GuestAuthSession = {
  authHeader: string;
  guestId?: string;
};

let cachedToken: { token: string; expiresAt: number; guestId?: string } | null =
  null;

/**
 * Returns a Bearer authorization session for unauthenticated MCPJam model calls.
 */
export async function getProductionGuestAuthSession(): Promise<
  GuestAuthSession | null
> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return {
      authHeader: `Bearer ${cachedToken.token}`,
      ...(cachedToken.guestId ? { guestId: cachedToken.guestId } : {}),
    };
  }

  const session = await fetchGuestSessionForServerSideAuth();
  if (!session) {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      logger.warn(
        "[guest-auth] Failed to refresh guest token; reusing cached token until expiry",
      );
      return {
        authHeader: `Bearer ${cachedToken.token}`,
        ...(cachedToken.guestId ? { guestId: cachedToken.guestId } : {}),
      };
    }
    return null;
  }

  cachedToken = {
    token: session.token,
    expiresAt: session.expiresAt,
    ...(session.guestId ? { guestId: session.guestId } : {}),
  };
  logger.info("[guest-auth] Fetched guest token for MCPJam model request");
  return {
    authHeader: `Bearer ${session.token}`,
    ...(session.guestId ? { guestId: session.guestId } : {}),
  };
}

/**
 * Returns a Bearer authorization header for unauthenticated MCPJam model calls.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  return (await getProductionGuestAuthSession())?.authHeader ?? null;
}
