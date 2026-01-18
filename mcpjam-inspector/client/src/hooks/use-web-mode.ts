import { useState, useEffect } from "react";
import { getSessionToken } from "@/lib/session-token";

/**
 * Web mode configuration from the server.
 * Determines what features are available based on deployment mode.
 */
export interface WebModeConfig {
  webMode: boolean;
  allowedTransports: string[];
  features: {
    stdio: boolean;
    http: boolean;
    https: boolean;
  };
}

const defaultConfig: WebModeConfig = {
  webMode: false,
  allowedTransports: ["stdio", "http", "https", "sse"],
  features: {
    stdio: true,
    http: true,
    https: true,
  },
};

let cachedConfig: WebModeConfig | null = null;

/**
 * Hook to get the web mode configuration from the server.
 * This determines what transport options are available in the UI.
 *
 * In web mode (public deployment):
 * - Only HTTPS connections are allowed
 * - stdio and HTTP are disabled for security
 *
 * In local mode:
 * - All transports are available
 */
export function useWebMode(): {
  config: WebModeConfig;
  isLoading: boolean;
  error: Error | null;
} {
  const [config, setConfig] = useState<WebModeConfig>(
    cachedConfig || defaultConfig,
  );
  const [isLoading, setIsLoading] = useState(!cachedConfig);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // If we already have a cached config, don't refetch
    if (cachedConfig) {
      return;
    }

    const fetchConfig = async () => {
      try {
        const token = getSessionToken();
        const headers: HeadersInit = {};
        if (token) {
          headers["X-MCP-Session-Auth"] = `Bearer ${token}`;
        }

        const response = await fetch("/api/mcp/config", { headers });

        if (!response.ok) {
          throw new Error(`Failed to fetch config: ${response.status}`);
        }

        const data = await response.json();
        cachedConfig = data;
        setConfig(data);
      } catch (err) {
        console.error("Failed to fetch web mode config:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
        // Use default config on error (allows all features)
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, []);

  return { config, isLoading, error };
}

/**
 * Check if a transport type is allowed in the current mode.
 */
export function isTransportAllowed(
  config: WebModeConfig,
  transport: "stdio" | "http" | "https",
): boolean {
  return config.features[transport];
}

/**
 * Get the default transport type based on available options.
 * Prefers stdio in local mode, https in web mode.
 */
export function getDefaultTransport(
  config: WebModeConfig,
): "stdio" | "http" | "https" {
  if (config.features.stdio) return "stdio";
  if (config.features.https) return "https";
  if (config.features.http) return "http";
  return "https"; // Fallback
}
