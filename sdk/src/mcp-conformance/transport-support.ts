import type {
  HttpServerConfig,
  MCPServerConfig,
} from "../mcp-client-manager/index.js";

export type ConformanceSuiteId = "protocol" | "apps" | "oauth";

export interface ConformanceSupport {
  /** Whether the suite can run against the given server config. */
  supported: boolean;
  /** Human-readable reason surfaced when `supported` is false. */
  reason?: string;
}

/**
 * Narrow an arbitrary MCPServerConfig (or absent config) to the HTTP variant.
 * Accepts `null`/`undefined` so callers can feed values from loading states
 * without pre-checking — those just return `false`.
 */
export function isHttpServerConfig(
  config: MCPServerConfig | null | undefined,
): config is HttpServerConfig {
  return (
    !!config &&
    typeof config === "object" &&
    "url" in config &&
    typeof (config as { url?: unknown }).url !== "undefined" &&
    !!(config as { url?: unknown }).url
  );
}

const HTTP_ONLY_REASON =
  "This conformance suite requires an HTTP transport. Stdio servers are not supported.";

const NO_CONFIG_REASON =
  "No server configuration is available yet. Select a connected server.";

/**
 * Centralises the "which conformance suite supports which transport" rules so
 * UI guards, server routes, and CLI commands can't drift. The check is pure —
 * it inspects config shape only, not network state. `null`/`undefined` configs
 * are treated as unsupported with a friendly reason instead of throwing.
 */
export function canRunConformance(
  suite: ConformanceSuiteId,
  config: MCPServerConfig | null | undefined,
): ConformanceSupport {
  if (!config) {
    return { supported: false, reason: NO_CONFIG_REASON };
  }
  switch (suite) {
    case "protocol":
    case "oauth":
      return isHttpServerConfig(config)
        ? { supported: true }
        : { supported: false, reason: HTTP_ONLY_REASON };
    case "apps":
      return { supported: true };
    default: {
      const exhaustive: never = suite;
      return {
        supported: false,
        reason: `Unknown conformance suite: ${String(exhaustive)}`,
      };
    }
  }
}
