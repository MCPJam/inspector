/**
 * API client for MCP server tunnel management
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:6274";

export interface TunnelResponse {
  url: string;
  existed?: boolean;
}

export interface ServerTunnelResponse {
  url: string;
  serverId: string;
}

export interface TunnelError {
  error: string;
}

/**
 * Create a shared tunnel for all MCP servers
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function createTunnel(
  accessToken?: string,
): Promise<TunnelResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}/api/mcp/tunnels/create`, {
    method: "POST",
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create tunnel");
  }

  return response.json();
}

/**
 * Get existing shared tunnel URL
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function getTunnel(
  accessToken?: string,
): Promise<TunnelResponse | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}/api/mcp/tunnels`, {
    method: "GET",
    headers,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get tunnel");
  }

  return response.json();
}

/**
 * Get server-specific tunnel URL
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function getServerTunnel(
  serverId: string,
  accessToken?: string,
): Promise<ServerTunnelResponse | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/server/${encodeURIComponent(serverId)}`,
    {
      method: "GET",
      headers,
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get server tunnel");
  }

  return response.json();
}

/**
 * Close the shared tunnel
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function closeTunnel(accessToken?: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}/api/mcp/tunnels`, {
    method: "DELETE",
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to close tunnel");
  }
}

/**
 * Cleanup all orphaned tunnels for the current user
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function cleanupOrphanedTunnels(
  accessToken?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  try {
    const response = await fetch(
      `${API_BASE}/api/mcp/tunnels/cleanup-orphaned`,
      {
        method: "POST",
        headers,
      },
    );

    if (response.ok) {
      console.log("[tunnels] Orphaned tunnels cleanup completed");
    } else {
      console.warn("[tunnels] Failed to cleanup orphaned tunnels");
    }
  } catch (error) {
    console.error("[tunnels] Error during tunnel cleanup:", error);
    // Don't throw - cleanup is best-effort
  }
}
