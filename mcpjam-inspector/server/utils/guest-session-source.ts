import { logger } from "./logger.js";

const DEFAULT_REMOTE_GUEST_SESSION_URL =
  "https://app.mcpjam.com/api/web/guest-session";

export type RemoteGuestSession = {
  guestId?: string;
  token: string;
  expiresAt: number;
};

export function shouldUseLocalGuestSigning(): boolean {
  if (process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING === "false") {
    return false;
  }

  return true;
}

export function getRemoteGuestSessionUrl(): string {
  return (
    process.env.MCPJAM_GUEST_SESSION_URL || DEFAULT_REMOTE_GUEST_SESSION_URL
  );
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
