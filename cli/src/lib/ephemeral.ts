import {
  withEphemeralClient,
  type MCPServerConfig,
  type RetryPolicy,
  type RpcLogger,
} from "@mcpjam/sdk";
import type { HostConnectionProfile } from "@mcpjam/sdk/host-config/internal";
import { applyHostToConfig } from "./host-resolve.js";

export interface EphemeralManagerOptions {
  timeout?: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
  /**
   * Connect "as a host" — merge the host's `clientInfo`/`clientCapabilities`/
   * protocol pins onto the config so the `initialize` handshake advertises that
   * host's identity. Resolve via `resolveHostFromOptions` in `host-resolve`.
   */
  host?: HostConnectionProfile;
}

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (
    manager: import("@mcpjam/sdk").MCPClientManager,
    serverId: string,
  ) => Promise<T>,
  options?: EphemeralManagerOptions,
): Promise<T> {
  const resolvedConfig = options?.host
    ? applyHostToConfig(config, options.host)
    : config;
  return withEphemeralClient(resolvedConfig, fn, {
    serverId: "__cli__",
    clientName: "mcpjam",
    timeout: options?.timeout ?? 30_000,
    rpcLogger: options?.rpcLogger,
    retryPolicy: options?.retryPolicy,
  });
}
