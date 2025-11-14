import type {
  RegistryServerListResponse,
  RegistryVersionListResponse,
  RegistryServerVersion,
} from "@/shared/types";

const API_BASE = "/api/mcp/registry";

/**
 * List servers from the MCP registry
 */
export async function listRegistryServers(options?: {
  limit?: number;
  cursor?: string;
}): Promise<RegistryServerListResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.append("limit", options.limit.toString());
  if (options?.cursor) params.append("cursor", options.cursor);

  const url = `${API_BASE}/servers${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch registry servers: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get all versions for a specific server
 */
export async function listServerVersions(
  serverName: string,
): Promise<RegistryVersionListResponse> {
  const encodedName = encodeURIComponent(serverName);
  const url = `${API_BASE}/servers/${encodedName}/versions`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch server versions: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get a specific version of a server
 */
export async function getServerVersion(
  serverName: string,
  version: string = "latest",
): Promise<RegistryServerVersion> {
  const encodedName = encodeURIComponent(serverName);
  const encodedVersion = encodeURIComponent(version);
  const url = `${API_BASE}/servers/${encodedName}/versions/${encodedVersion}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch server version: ${response.statusText}`);
  }

  return response.json();
}
