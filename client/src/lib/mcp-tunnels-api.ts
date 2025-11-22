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
 */
export async function createTunnel(serverId: string): Promise<TunnelResponse> {
  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}/create`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
 */
export async function getTunnel(serverId: string): Promise<TunnelResponse | null> {
  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}`,
    {
      method: 'GET',
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
 */
export async function closeTunnel(serverId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/api/mcp/tunnels/${encodeURIComponent(serverId)}`,
    {
      method: 'DELETE',
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to close tunnel');
  }
}

/**
 * List all active tunnels
 */
export async function listTunnels(): Promise<{ tunnels: Array<{ serverId: string; url: string }> }> {
  const response = await fetch(`${API_BASE}/api/mcp/tunnels`, {
    method: 'GET',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list tunnels');
  }

  return response.json();
}
