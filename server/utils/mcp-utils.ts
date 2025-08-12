import { MCPClient } from "@mastra/mcp";
import type { MastraMCPServerDefinition } from "../../shared/types";

// Hono-compatible error response type
export interface HonoErrorResponse {
  message: string;
  status: number;
}

export interface ValidationResult {
  success: boolean;
  config?: MastraMCPServerDefinition;
  error?: HonoErrorResponse;
}

export interface MultipleValidationResult {
  success: boolean;
  validConfigs?: Record<string, MastraMCPServerDefinition>;
  errors?: Record<string, string>;
  error?: HonoErrorResponse;
}

export function validateServerConfig(serverConfig: any): ValidationResult {
  if (!serverConfig) {
    return {
      success: false,
      error: {
        message: "Server configuration is required",
        status: 400,
      },
    };
  }

  // Validate and prepare config
  const config = { ...serverConfig };

  // Validate and convert URL if provided
  if (config.url) {
    try {
      // Convert string URL to URL object if needed and strip query/hash
      if (typeof config.url === "string") {
        const parsed = new URL(config.url);
        parsed.search = "";
        parsed.hash = "";
        config.url = parsed;
      } else if (typeof config.url === "object" && !config.url.href) {
        return {
          success: false,
          error: {
            message: "Invalid URL configuration",
            status: 400,
          },
        };
      }

      // Handle OAuth authentication for HTTP servers
      if (config.oauth?.access_token) {
        const authHeaders = {
          Authorization: `Bearer ${config.oauth.access_token}`,
          ...(config.requestInit?.headers || {}),
        };

        config.requestInit = {
          ...config.requestInit,
          headers: authHeaders,
        };

        // For SSE connections, add eventSourceInit with OAuth headers
        config.eventSourceInit = {
          fetch(input: Request | URL | string, init?: RequestInit) {
            const headers = new Headers(init?.headers || {});

            // Add OAuth authorization header
            headers.set(
              "Authorization",
              `Bearer ${config.oauth!.access_token}`,
            );

            // Copy other headers from requestInit
            if (config.requestInit?.headers) {
              const requestHeaders = new Headers(config.requestInit.headers);
              requestHeaders.forEach((value, key) => {
                if (key.toLowerCase() !== "authorization") {
                  headers.set(key, value);
                }
              });
            }

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      } else if (config.requestInit?.headers) {
        // For SSE connections without OAuth, add eventSourceInit if requestInit has custom headers
        config.eventSourceInit = {
          fetch(input: Request | URL | string, init?: RequestInit) {
            const headers = new Headers(init?.headers || {});

            // Copy headers from requestInit
            const requestHeaders = new Headers(config.requestInit.headers);
            requestHeaders.forEach((value, key) => {
              headers.set(key, value);
            });

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          message: `Invalid URL format: ${error}`,
          status: 400,
        },
      };
    }
  }

  return {
    success: true,
    config,
  };
}

export function createMCPClient(
  config: MastraMCPServerDefinition,
  id: string,
): MCPClient {
  return new MCPClient({
    id,
    servers: {
      server: config,
    },
  });
}

export interface MultipleValidationResult {
  success: boolean;
  validConfigs?: Record<string, MastraMCPServerDefinition>;
  errors?: Record<string, string>;
  error?: HonoErrorResponse;
}

export const validateMultipleServerConfigs = (
  serverConfigs: Record<string, MastraMCPServerDefinition>,
): MultipleValidationResult => {
  if (!serverConfigs || Object.keys(serverConfigs).length === 0) {
    return {
      success: false,
      error: {
        message: "At least one server configuration is required",
        status: 400,
      },
    };
  }

  const validConfigs: Record<string, MastraMCPServerDefinition> = {};
  const errors: Record<string, string> = {};
  let hasErrors = false;

  // Validate each server configuration
  for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
    const validationResult = validateServerConfig(serverConfig);

    if (validationResult.success && validationResult.config) {
      validConfigs[serverName] = validationResult.config;
    } else {
      hasErrors = true;
      let errorMessage = "Configuration validation failed";
      if (validationResult.error) {
        errorMessage = validationResult.error.message;
      }
      errors[serverName] = errorMessage;
    }
  }

  // If all configs are valid, return success
  if (!hasErrors) {
    return {
      success: true,
      validConfigs,
    };
  }

  // If some configs are valid but others failed, return partial success
  if (Object.keys(validConfigs).length > 0) {
    return {
      success: false,
      validConfigs,
      errors,
    };
  }

  // If all configs failed, return error
  return {
    success: false,
    errors,
    error: {
      message: "All server configurations failed validation",
      status: 400,
    },
  };
};

export function createMCPClientWithMultipleConnections(
  serverConfigs: Record<string, MastraMCPServerDefinition>,
): MCPClient {
  // Normalize server config names
  const normalizedConfigs: Record<string, MastraMCPServerDefinition> = {};
  for (const [serverName, config] of Object.entries(serverConfigs)) {
    const normalizedName = normalizeServerConfigName(serverName);
    normalizedConfigs[normalizedName] = config;
  }

  return new MCPClient({
    id: `chat-${Date.now()}`,
    servers: normalizedConfigs,
  });
}

export function normalizeServerConfigName(serverName: string): string {
  // Convert to lowercase and replace spaces/hyphens with underscores
  return serverName
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function createErrorResponse(
  message: string,
  details?: string,
  status: number = 500,
): HonoErrorResponse {
  return {
    message: details ? `${message}: ${details}` : message,
    status,
  };
}
