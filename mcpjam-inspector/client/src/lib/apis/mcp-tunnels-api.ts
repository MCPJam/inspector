/**
 * API client for MCP server tunnel management
 */

import { authFetch } from "@/lib/session-token";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:6274";

export interface ServerTunnelResponse {
  // Full bearer URL (contains the ?k= secret enforced at the relay edge).
  // Only ever returned from the local inspector server's in-memory state
  // or a create/rotate response — never from persisted backend records.
  url: string;
  serverId: string;
  existed?: boolean;
  slug?: string;
  secretVersion?: number;
}

export interface TunnelRequestLogEntry {
  ts: number;
  method: string;
  path: string;
}

export interface TunnelError {
  error: string;
}

/**
 * Create a tunnel scoped to an individual MCP server
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function createServerTunnel(
  serverId: string,
  accessToken?: string
): Promise<ServerTunnelResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await authFetch(
    `${API_BASE}/api/mcp/tunnels/create/${encodeURIComponent(serverId)}`,
    {
      method: "POST",
      headers,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create server tunnel");
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
  accessToken?: string
): Promise<ServerTunnelResponse | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await authFetch(
    `${API_BASE}/api/mcp/tunnels/server/${encodeURIComponent(serverId)}`,
    {
      method: "GET",
      headers,
    }
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
 * Close a tunnel for an individual MCP server
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function closeServerTunnel(
  serverId: string,
  accessToken?: string
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await authFetch(
    `${API_BASE}/api/mcp/tunnels/server/${encodeURIComponent(serverId)}`,
    {
      method: "DELETE",
      headers,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to close server tunnel");
  }
}

/**
 * Rotate a server tunnel's bearer secret. The base domain stays the same;
 * the returned URL carries the new secret and the old URL stops working.
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 * @param full - Also rotate the tunnel slug (new base URL). Rare.
 */
export async function rotateServerTunnel(
  serverId: string,
  accessToken?: string,
  full = false
): Promise<ServerTunnelResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await authFetch(
    `${API_BASE}/api/mcp/tunnels/rotate/${encodeURIComponent(serverId)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ full }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to rotate server tunnel");
  }

  return response.json();
}

/**
 * Recent requests that arrived through this server's tunnel (newest first).
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function getTunnelRequests(
  serverId: string,
  accessToken?: string
): Promise<TunnelRequestLogEntry[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await authFetch(
    `${API_BASE}/api/mcp/tunnels/requests/${encodeURIComponent(serverId)}`,
    {
      method: "GET",
      headers,
    }
  );

  if (!response.ok) {
    // Throw rather than return [] so the polling caller can keep its last
    // good snapshot instead of flashing an empty list on a transient error.
    let message = "Failed to fetch tunnel requests";
    try {
      const error = (await response.json()) as { error?: string };
      if (typeof error?.error === "string") {
        message = error.error;
      }
    } catch {
      // keep default message
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    requests?: TunnelRequestLogEntry[];
  };
  return data.requests ?? [];
}
