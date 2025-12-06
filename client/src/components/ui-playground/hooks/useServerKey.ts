/**
 * useServerKey Hook
 *
 * Computes a stable server key from MCPServerConfig for use in
 * localStorage-based saved requests storage.
 */

import { useMemo } from "react";
import type { MCPServerConfig } from "@/sdk";

// Type guards for discriminated union
interface StdioConfig {
  command: string;
  args?: string[];
}

interface HttpConfig {
  url: URL | string;
}

function isStdioConfig(
  config: MCPServerConfig,
): config is MCPServerConfig & StdioConfig {
  return (
    "command" in config && typeof (config as StdioConfig).command === "string"
  );
}

function isHttpConfig(
  config: MCPServerConfig,
): config is MCPServerConfig & HttpConfig {
  return "url" in config && (config as HttpConfig).url != null;
}

function getUrlString(url: URL | string): string {
  if (typeof url === "string") return url;
  return url.toString();
}

/**
 * Generates a stable key from server config for storage purposes.
 */
export function computeServerKey(config: MCPServerConfig | undefined): string {
  if (!config) return "none";

  try {
    if (isHttpConfig(config)) {
      return `http:${getUrlString(config.url)}`;
    }

    if (isStdioConfig(config)) {
      const args = (config.args || []).join(" ");
      return `stdio:${config.command} ${args}`.trim();
    }

    // Fallback for unknown config shapes
    return JSON.stringify(config);
  } catch {
    return "unknown";
  }
}

/**
 * Hook that memoizes server key computation.
 */
export function useServerKey(
  serverConfig: MCPServerConfig | undefined,
): string {
  return useMemo(() => computeServerKey(serverConfig), [serverConfig]);
}
