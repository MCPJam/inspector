/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker).
 *
 * Dev runtimes sign guest tokens locally so they keep working against their
 * own Convex sandbox setup. Production local runtimes fetch a guest session
 * from app.mcpjam.com so they use the hosted signer by default.
 */

import { issueGuestToken } from "../services/guest-token.js";
import { logger } from "./logger.js";
import {
  fetchRemoteGuestSession,
  shouldUseHostedGuestSession,
} from "./guest-session-source.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a Bearer authorization header for unauthenticated MCPJam model calls.
 *
 * Dev runtimes sign guest tokens locally so they keep working against their
 * own Convex sandbox setup. Production local runtimes fetch a guest session
 * from app.mcpjam.com so they use the hosted signer by default.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return `Bearer ${cachedToken.token}`;
  }

  if (shouldUseHostedGuestSession()) {
    const session = await fetchRemoteGuestSession();
    if (!session) {
      return null;
    }
    cachedToken = { token: session.token, expiresAt: session.expiresAt };
    return `Bearer ${session.token}`;
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
