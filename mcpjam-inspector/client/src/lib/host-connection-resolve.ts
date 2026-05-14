import type { HostConfigConnectionDefaults } from "./host-config-v2";

/**
 * Resolve the effective connection settings for a single server within a host.
 *
 * Merge order (lowest → highest priority):
 *   1. serverBase   — the server row's own headers/timeout
 *   2. hostDefaults — host-wide connectionDefaults
 *   3. override     — per-host-server override from hostConfigServerRefs
 *
 * The `requestTimeoutOverride` wire name maps to the `timeout` field used by
 * MCPServerConfig.
 */
export function resolveServerConnectionSettings(
  serverBase: { headers?: Record<string, string>; timeout?: number },
  hostDefaults: HostConfigConnectionDefaults,
  override?: {
    headersOverride?: Record<string, string>;
    requestTimeoutOverride?: number;
  },
): { headers: Record<string, string>; timeout: number } {
  return {
    headers: {
      ...serverBase.headers,
      ...hostDefaults.headers,
      ...override?.headersOverride,
    },
    timeout:
      override?.requestTimeoutOverride ??
      hostDefaults.requestTimeout ??
      serverBase.timeout,
  };
}
