import type {
  RegistryServerListResponse,
  RegistryVersionListResponse,
  RegistryServerVersion,
  RegistryAuthRequiredResponse,
} from "@/shared/types";

const API_BASE = "/api/mcp/registry";

export interface RegistryRequestOptions {
  registryUrl?: string;
  accessToken?: string;
}

/**
 * List servers from the MCP registry
 */
export async function listRegistryServers(
  options?: RegistryRequestOptions & {
    limit?: number;
    cursor?: string;
  },
): Promise<RegistryServerListResponse | RegistryAuthRequiredResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.append("limit", options.limit.toString());
  if (options?.cursor) params.append("cursor", options.cursor);
  if (options?.registryUrl) params.append("registryUrl", options.registryUrl);

  const headers: HeadersInit = {};
  if (options?.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }

  const url = `${API_BASE}/servers${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, { headers });

  // Return auth required response for 401
  if (response.status === 401) {
    return response.json() as Promise<RegistryAuthRequiredResponse>;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch registry servers: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Check if a response indicates auth is required
 */
export function isAuthRequired(
  response: RegistryServerListResponse | RegistryAuthRequiredResponse,
): response is RegistryAuthRequiredResponse {
  return "requiresAuth" in response && response.requiresAuth === true;
}

/**
 * Get all versions for a specific server
 */
export async function listServerVersions(
  serverName: string,
  options?: RegistryRequestOptions,
): Promise<RegistryVersionListResponse | RegistryAuthRequiredResponse> {
  const encodedName = encodeURIComponent(serverName);
  const params = new URLSearchParams();
  if (options?.registryUrl) params.append("registryUrl", options.registryUrl);

  const headers: HeadersInit = {};
  if (options?.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }

  const url = `${API_BASE}/servers/${encodedName}/versions${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, { headers });

  if (response.status === 401) {
    return response.json() as Promise<RegistryAuthRequiredResponse>;
  }

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
  options?: RegistryRequestOptions,
): Promise<RegistryServerVersion | RegistryAuthRequiredResponse> {
  const encodedName = encodeURIComponent(serverName);
  const encodedVersion = encodeURIComponent(version);
  const params = new URLSearchParams();
  if (options?.registryUrl) params.append("registryUrl", options.registryUrl);

  const headers: HeadersInit = {};
  if (options?.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }

  const url = `${API_BASE}/servers/${encodedName}/versions/${encodedVersion}${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, { headers });

  if (response.status === 401) {
    return response.json() as Promise<RegistryAuthRequiredResponse>;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch server version: ${response.statusText}`);
  }

  return response.json();
}
