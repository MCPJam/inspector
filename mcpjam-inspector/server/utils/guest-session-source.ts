import { logger } from "./logger.js";
import { HOSTED_MODE } from "../config.js";

const DEFAULT_REMOTE_GUEST_SESSION_URL =
  "https://app.mcpjam.com/api/web/guest-session";

export type RemoteGuestSession = {
  guestId?: string;
  token: string;
  expiresAt: number;
};

export function shouldUseHostedGuestSession(): boolean {
  if (process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING === "true") {
    return false;
  }

  if (process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING === "false") {
    return true;
  }

  // Hosted web signs guest tokens on the hosted inspector server.
  if (HOSTED_MODE) {
    return false;
  }

  // Production local runtimes (npx / packaged Electron / Docker) use the
  // hosted signer by default. Dev/test stay on local signing.
  return process.env.NODE_ENV === "production";
}

export function shouldUseLocalGuestSigning(): boolean {
  return !shouldUseHostedGuestSession();
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
