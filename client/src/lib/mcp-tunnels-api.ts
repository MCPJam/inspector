/**
 * API client for MCP server tunnel management
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:6274';

export interface TunnelResponse {
  url: string;
  serverId: string;
  existed?: boolean;
}

export interface TunnelError {
  error: string;
  serverId: string;
}

/**
 * Create a tunnel for an MCP server
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function createTunnel(serverId: string, accessToken?: string): Promise<TunnelResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}/create`,
    {
      method: 'POST',
      headers,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create tunnel');
  }

  return response.json();
}

/**
 * Get existing tunnel URL for a server
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function getTunnel(serverId: string, accessToken?: string): Promise<TunnelResponse | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}`,
    {
      method: 'GET',
      headers,
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get tunnel');
  }

  return response.json();
}

/**
 * Close a tunnel for a server
 * @param serverId - The MCP server ID
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function closeTunnel(serverId: string, accessToken?: string): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}`,
    {
      method: 'DELETE',
      headers,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to close tunnel');
  }
}

/**
 * List all active tunnels
 * @param accessToken - Optional WorkOS access token for authenticated requests
 */
export async function listTunnels(accessToken?: string): Promise<{ tunnels: Array<{ serverId: string; url: string }> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}/api/mcp/tunnels`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list tunnels');
  }

  return response.json();
}
