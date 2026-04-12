import {
  withEphemeralClient,
  type MCPServerConfig,
  type RpcLogger,
} from "@mcpjam/sdk";

export interface EphemeralManagerOptions {
  timeout?: number;
  rpcLogger?: RpcLogger;
}

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (manager: import("@mcpjam/sdk").MCPClientManager, serverId: string) => Promise<T>,
  options?: EphemeralManagerOptions,
): Promise<T> {
  return withEphemeralClient(config, fn, {
    serverId: "__cli__",
    clientName: "mcpjam",
    timeout: options?.timeout ?? 30_000,
    rpcLogger: options?.rpcLogger,
  });
}
