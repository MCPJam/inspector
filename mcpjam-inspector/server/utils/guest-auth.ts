/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker).
 *
 * By default, local dev and shipped production runtimes fetch a guest session
 * from MCPJam so they follow the same hosted guest auth flow as app.mcpjam.com.
 * Local signing remains available as an opt-in for auth debugging.
 */

import { issueGuestToken } from "../services/guest-token.js";
import { logger } from "./logger.js";
import {
  fetchRemoteGuestSession,
  shouldUseLocalGuestSigning,
} from "./guest-session-source.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a Bearer authorization header for unauthenticated MCPJam model calls.
 *
 * By default, dev and production local runtimes fetch a hosted guest session
 * from MCPJam so they follow the same guest auth flow as app.mcpjam.com.
 * Local signing remains available as an opt-in for auth debugging.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return `Bearer ${cachedToken.token}`;
  }

  if (!shouldUseLocalGuestSigning()) {
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
