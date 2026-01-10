import log from "electron-log";

/**
 * Cleanup all orphaned tunnels for the current user
 * This should be called on app startup to ensure clean state
 */
export async function cleanupOrphanedTunnels(
  authHeader?: string,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    log.warn("CONVEX_HTTP_URL not configured, skipping tunnel cleanup");
    return;
  }

  // If no auth header, skip cleanup (user not logged in yet)
  if (!authHeader) {
    log.info("No auth token available, skipping orphaned tunnel cleanup");
    return;
  }

  try {
    log.info("Cleaning up orphaned tunnels...");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: authHeader,
    };

    // Call the cleanup endpoint
    const response = await fetch(`${convexUrl}/tunnels/cleanup-orphaned`, {
      method: "POST",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      log.error("Failed to cleanup orphaned tunnels:", error.error);
      return;
    }

    const data = (await response.json()) as {
      ok?: boolean;
      total?: number;
      successful?: number;
      failed?: number;
    };

    if (data.ok && data.total !== undefined) {
      if (data.total === 0) {
        log.info("No orphaned tunnels found");
      } else {
        log.info(
          `Cleaned up ${data.successful}/${data.total} orphaned tunnels` +
            (data.failed ? ` (${data.failed} failed)` : ""),
        );
      }
    }
  } catch (error: any) {
    log.error("Error cleaning up orphaned tunnels:", error.message);
    // Don't throw - this is a best-effort cleanup
  }
}

/**
 * Get the auth header from the request context
 * This is a helper to extract the auth token for cleanup
 */
export function getAuthHeaderFromStorage(): string | undefined {
  // This will be implemented based on how you store auth tokens
  // For now, return undefined - the cleanup will be called after login
  return undefined;
}
