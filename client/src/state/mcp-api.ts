import { MCPServerConfig } from "@/sdk";
import { withProxyAuth } from "@/lib/proxy-auth";

export async function testConnection(
  serverConfig: MCPServerConfig,
  serverId: string,
) {
  const res = await fetch(
    "/api/mcp/connect",
    withProxyAuth({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverConfig, serverId }),
    }),
  );
  return res.json();
}

export async function deleteServer(serverId: string) {
  const res = await fetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}`,
    withProxyAuth({
      method: "DELETE",
    }),
  );
  return res.json();
}

export async function listServers() {
  const res = await fetch("/api/mcp/servers", withProxyAuth());
  return res.json();
}

export async function reconnectServer(
  serverId: string,
  serverConfig: MCPServerConfig,
) {
  const res = await fetch(
    "/api/mcp/servers/reconnect",
    withProxyAuth({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, serverConfig }),
    }),
  );
  return res.json();
}
