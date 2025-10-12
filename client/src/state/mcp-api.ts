import { MCPServerConfig } from "@/shared/mcp-client-manager";

export async function testConnection(
  serverConfig: MCPServerConfig,
  serverId: string,
) {
  const res = await fetch("/api/mcp/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverConfig, serverId }),
  });
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
