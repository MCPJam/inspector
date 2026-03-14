import {
  MCPClientManager,
  type StdioServerConfig,
  type HttpServerConfig,
} from "@mcpjam/sdk";

type ServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * Parse --server option into a server config
 * Supports:
 * - HTTP URLs: "http://localhost:3000/mcp" or "https://..."
 * - STDIO commands: "npx @modelcontextprotocol/server-filesystem /tmp"
 */
export function parseServerOption(server: string): ServerConfig {
  if (server.startsWith("http://") || server.startsWith("https://")) {
    return { url: server } satisfies HttpServerConfig;
  }

  // Otherwise it's a command like "npx @modelcontextprotocol/server-fs /tmp"
  const [command, ...args] = server.split(" ");
  return { command, args } satisfies StdioServerConfig;
}

/**
 * Run an operation with automatic connect/disconnect lifecycle
 */
export async function withServer<T>(
  serverOption: string,
  operation: (manager: MCPClientManager, serverId: string) => Promise<T>
): Promise<T> {
  const config = parseServerOption(serverOption);
  const manager = new MCPClientManager();
  const serverId = "cli-server";

  try {
    await manager.connectToServer(serverId, config);
    return await operation(manager, serverId);
  } finally {
    await manager.disconnectAllServers();
  }
}
