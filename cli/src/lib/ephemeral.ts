import {
  MCPClientManager,
  type MCPServerConfig,
  type RpcLogger,
} from "@mcpjam/sdk";

export interface EphemeralManagerOptions {
  timeout?: number;
  rpcLogger?: RpcLogger;
}

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: EphemeralManagerOptions,
): Promise<T> {
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...(options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}),
    },
  );
  const serverId = "__cli__";

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

export async function withEphemeralManagers<T>(
  servers: Record<string, MCPServerConfig>,
  fn: (
    manager: MCPClientManager,
    connectionErrors: Record<string, string>,
  ) => Promise<T>,
  options?: EphemeralManagerOptions & { continueOnConnectError?: boolean },
): Promise<T> {
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...(options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}),
    },
  );

  const connectionErrors: Record<string, string> = {};

  try {
    await Promise.all(
      Object.entries(servers).map(async ([serverId, config]) => {
        try {
          await manager.connectToServer(serverId, config);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          connectionErrors[serverId] = message;
          if (!options?.continueOnConnectError) {
            throw error;
          }
        }
      }),
    );

    return await fn(manager, connectionErrors);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the ephemeral connection lifecycle.
    }
  }
}
