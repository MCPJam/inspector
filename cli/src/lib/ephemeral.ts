import { MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  const serverId = "__cli__";
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: "mcpjam",
      lazyConnect: true,
    },
  );

  try {
    await manager.connectToServer(serverId, config);
    return await fn(manager, serverId);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the ephemeral connection lifecycle.
    }
  }
}
