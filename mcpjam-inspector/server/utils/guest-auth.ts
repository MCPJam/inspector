/**
 * Guest Auth Header Provider
 *
 * Provides a valid guest JWT for MCPJam model requests from unauthenticated
 * users in non-hosted mode (npx/electron/docker).
 *
 * In local dev we sign tokens locally so they match the dev Convex sandbox.
 * In shipped production runtimes we fetch a guest session from MCPJam so the
 * token is signed by the production guest issuer that Convex already trusts.
 */

import { issueGuestToken } from "../services/guest-token.js";
import { logger } from "./logger.js";

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_REMOTE_GUEST_SESSION_URL =
  "https://app.mcpjam.com/api/web/guest-session";

let cachedToken: { token: string; expiresAt: number } | null = null;

function shouldUseLocalGuestSigning(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    (!!process.env.GUEST_JWT_PRIVATE_KEY && !!process.env.GUEST_JWT_PUBLIC_KEY)
  );
}

function getRemoteGuestSessionUrl(): string {
  return process.env.MCPJAM_GUEST_SESSION_URL || DEFAULT_REMOTE_GUEST_SESSION_URL;
}

async function fetchRemoteGuestSessionToken(): Promise<string | null> {
  try {
    const response = await fetch(getRemoteGuestSessionUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch MCPJam guest session: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const session = (await response.json()) as {
      token?: unknown;
      expiresAt?: unknown;
    };

    if (
      typeof session.token !== "string" ||
      typeof session.expiresAt !== "number"
    ) {
      logger.warn(
        "[guest-auth] MCPJam guest session response was missing token or expiresAt",
      );
      return null;
    }

    cachedToken = { token: session.token, expiresAt: session.expiresAt };
    logger.info("[guest-auth] Fetched guest token from MCPJam guest session");
    return `Bearer ${session.token}`;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch MCPJam guest session: ${errMsg}`);
    return null;
  }
}

/**
 * Returns a Bearer authorization header for unauthenticated MCPJam model calls.
 *
 * Dev runtimes sign locally so the dev sandbox can trust the token.
 * Production local runtimes fetch a hosted guest session so the token matches
 * the production Convex guest issuer configuration.
 */
export async function getProductionGuestAuthHeader(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return `Bearer ${cachedToken.token}`;
  }

  if (!shouldUseLocalGuestSigning()) {
    return fetchRemoteGuestSessionToken();
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
