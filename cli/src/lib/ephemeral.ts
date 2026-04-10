import {
  withEphemeralClient,
  type MCPServerConfig,
  type MCPClientManager,
} from "@mcpjam/sdk";

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  return withEphemeralClient(config, fn, {
    serverId: "__cli__",
    clientName: "mcpjam",
    timeout: options?.timeout ?? 30_000,
  });
}
