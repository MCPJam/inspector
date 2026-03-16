import { provisionGuestAuthConfigToConvex } from "./convex-guest-auth-sync.js";
import { logger } from "./logger.js";
import {
  GUEST_SESSION_SECRET_HEADER,
  getGuestSessionSharedSecret,
} from "./guest-session-secret.js";

const DEFAULT_REMOTE_GUEST_SESSION_URL =
  "https://app.mcpjam.com/api/web/guest-session";

export type RemoteGuestSession = {
  guestId?: string;
  token: string;
  expiresAt: number;
};

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for guest auth");
  }
  return convexHttpUrl;
}

function buildConvexGuestUrl(pathname: string): string {
  return new URL(pathname, getConvexHttpUrl()).toString();
}

function getConvexGuestSessionUrl(): string {
  return buildConvexGuestUrl("/guest/session");
}

export function getRemoteGuestSessionUrl(): string {
  return process.env.MCPJAM_GUEST_SESSION_URL || DEFAULT_REMOTE_GUEST_SESSION_URL;
}

export function getRemoteGuestJwksUrl(): string {
  return process.env.MCPJAM_GUEST_JWKS_URL || buildConvexGuestUrl("/guest/jwks");
}

export async function fetchRemoteGuestSession(): Promise<RemoteGuestSession | null> {
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
      guestId?: unknown;
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

    logger.info("[guest-auth] Fetched guest token from MCPJam guest session");
    return {
      guestId:
        typeof session.guestId === "string" ? session.guestId : undefined,
      token: session.token,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch MCPJam guest session: ${errMsg}`);
    return null;
  }
}

export async function fetchConvexGuestSession(): Promise<RemoteGuestSession | null> {
  try {
    await provisionGuestAuthConfigToConvex();

    const response = await fetch(getConvexGuestSessionUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [GUEST_SESSION_SECRET_HEADER]: getGuestSessionSharedSecret(),
      },
    });

    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch Convex guest session: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const session = (await response.json()) as {
      guestId?: unknown;
      token?: unknown;
      expiresAt?: unknown;
    };

    if (
      typeof session.token !== "string" ||
      typeof session.expiresAt !== "number"
    ) {
      logger.warn(
        "[guest-auth] Convex guest session response was missing token or expiresAt",
      );
      return null;
    }

    logger.info("[guest-auth] Fetched guest token from Convex guest session");
    return {
      guestId:
        typeof session.guestId === "string" ? session.guestId : undefined,
      token: session.token,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch Convex guest session: ${errMsg}`);
    return null;
  }
}

export async function fetchGuestSessionForServerSideAuth(): Promise<RemoteGuestSession | null> {
  if (process.env.MCPJAM_GUEST_SESSION_URL || process.env.NODE_ENV === "production") {
    return fetchRemoteGuestSession();
  }

  return fetchConvexGuestSession();
}

export async function fetchRemoteGuestJwks(): Promise<Response | null> {
  try {
    if (!process.env.MCPJAM_GUEST_JWKS_URL) {
      await provisionGuestAuthConfigToConvex();
    }

    return await fetch(getRemoteGuestJwksUrl(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch MCPJam guest JWKS: ${errMsg}`);
    return null;
  }
}
