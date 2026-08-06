import type { HostConfigConnectionDefaults } from "./client-config-v2";

/**
 * Resolve the effective connection settings for a single server within a host.
 *
 * Headers MERGE, lowest → highest priority:
 *   1. serverBase   — the server row's own headers
 *   2. hostDefaults — host-wide connectionDefaults
 *   3. override     — per-host-server override from hostConfigServerRefs
 *
 * A header overlay is a SET, so a host-wide entry legitimately applies on top
 * of every server ("send this header everywhere").
 *
 * The timeout is a SCALAR — exactly one value can win — so it resolves most-
 * specific-first instead, highest → lowest priority:
 *   1. override.requestTimeoutOverride — this server, in this host
 *   2. serverBase.timeout              — the server row's "Connection overrides"
 *   3. hostDefaults.requestTimeout     — the host-wide default
 *
 * `hostDefaults.requestTimeout` is a REQUIRED number, never nullish. Reading it
 * before `serverBase.timeout` therefore made the server's own timeout dead code:
 * a user could set it, see it echoed back in the form, and watch every connect
 * silently discard it (issue #3671). Keep the host default LAST.
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
      serverBase.timeout ??
      hostDefaults.requestTimeout,
  };
}
