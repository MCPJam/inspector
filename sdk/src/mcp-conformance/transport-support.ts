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

/** Narrow an arbitrary MCPServerConfig to the HTTP variant. */
export function isHttpServerConfig(
  config: MCPServerConfig,
): config is HttpServerConfig {
  return "url" in config && typeof config.url !== "undefined" && !!config.url;
}

const HTTP_ONLY_REASON =
  "This conformance suite requires an HTTP transport. Stdio servers are not supported.";

/**
 * Centralises the "which conformance suite supports which transport" rules so
 * UI guards, server routes, and CLI commands can't drift. The check is pure —
 * it inspects config shape only, not network state.
 */
export function canRunConformance(
  suite: ConformanceSuiteId,
  config: MCPServerConfig,
): ConformanceSupport {
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
