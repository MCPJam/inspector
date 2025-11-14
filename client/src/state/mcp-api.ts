import { MCPServerConfig } from "@/sdk";

// Helper to add timeout to fetch requests
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 10000,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Connection attempt timed out after ${timeoutMs / 1000} seconds. The server may not exist or is not responding.`,
      );
    }
    throw error;
  }
}

export async function testConnection(
  serverConfig: MCPServerConfig,
  serverId: string,
) {
  const res = await fetchWithTimeout(
    "/api/mcp/connect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverConfig, serverId }),
    },
    20000, // 20 second timeout
  );
  return res.json();
}

export async function deleteServer(serverId: string) {
  const res = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
  return res.json();
}

export async function listServers() {
  const res = await fetch("/api/mcp/servers");
  return res.json();
}

export async function reconnectServer(
  serverId: string,
  serverConfig: MCPServerConfig,
) {
  const res = await fetchWithTimeout(
    "/api/mcp/servers/reconnect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, serverConfig }),
    },
    20000, // 20 second timeout
  );
  return res.json();
}

export async function getInitializationInfo(serverId: string) {
  const res = await fetch(
    `/api/mcp/servers/init-info/${encodeURIComponent(serverId)}`,
  );
  return res.json();
}
