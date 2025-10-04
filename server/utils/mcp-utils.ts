import { MastraMCPServerDefinition, MCPClient } from "@mastra/mcp";

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
        config.url = new URL(config.url);
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
        // Capture the access token before deleting the oauth field
        const accessToken = config.oauth.access_token;

        const authHeaders = {
          Authorization: `Bearer ${accessToken}`,
          ...(config.requestInit?.headers || {}),
        };

        config.requestInit = {
          ...config.requestInit,
          headers: authHeaders,
        };

        // For SSE connections, add eventSourceInit with OAuth headers
        // Capture requestInit headers reference before deleting oauth
        const requestInitHeaders = config.requestInit?.headers;
        config.eventSourceInit = {
          fetch(input: Request | URL | string, init?: RequestInit) {
            const headers = new Headers(init?.headers || {});

            // Add OAuth authorization header using captured token
            headers.set("Authorization", `Bearer ${accessToken}`);

            // Copy other headers from requestInit
            if (requestInitHeaders) {
              const requestHeaders = new Headers(requestInitHeaders);
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

        // Remove oauth field from config after processing - it's not part of the MCP server definition schema
        delete config.oauth;
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
  serverNameMapping?: Record<string, string>; // serverID -> originalName
  errors?: Record<string, string>;
  error?: HonoErrorResponse;
}

// Generate unique server ID that avoids collisions
function generateUniqueServerID(serverName: string): string {
  // Use normalized name as base + timestamp + random suffix to ensure uniqueness
  const normalizedBase = normalizeServerConfigName(serverName);
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${normalizedBase}_${timestamp}_${random}`;
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
  const serverNameMapping: Record<string, string> = {};
  const errors: Record<string, string> = {};
  let hasErrors = false;

  // Validate each server configuration
  for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
    const validationResult = validateServerConfig(serverConfig);

    if (validationResult.success && validationResult.config) {
      // Generate unique server ID to avoid collisions from normalized names
      const serverID = generateUniqueServerID(serverName);
      validConfigs[serverID] = validationResult.config;
      serverNameMapping[serverID] = serverName; // Map serverID back to original name
    } else {
      hasErrors = true;
      let errorMessage = "Configuration validation failed";
      if (validationResult.error) {
        errorMessage = validationResult.error.message;
      }
      // Use original server name for error keys since this is for user display
      errors[serverName] = errorMessage;
    }
  }

  // If all configs are valid, return success
  if (!hasErrors) {
    return {
      success: true,
      validConfigs,
      serverNameMapping,
    };
  }

  // If some configs are valid but others failed, return partial success
  if (Object.keys(validConfigs).length > 0) {
    return {
      success: false,
      validConfigs,
      serverNameMapping,
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
  // Custom MCPClient wrapper to fix double prefixing issue
  const originalMCPClient = new MCPClient({
    id: `chat-${Date.now()}`,
    servers: serverConfigs,
  });

  // Override getTools method to fix double prefixing
  const originalGetTools = originalMCPClient.getTools.bind(originalMCPClient);
  originalMCPClient.getTools = async () => {
    const tools = await originalGetTools();
    const fixedTools: Record<string, any> = {};

    for (const [toolName, toolConfig] of Object.entries(tools)) {
      // Check if tool name has double prefix pattern (serverName_serverName_actualTool)
      const parts = toolName.split("_");
      if (parts.length >= 3 && parts[0] === parts[1]) {
        // Remove the duplicate prefix: "asana_asana_list_workspaces" -> "asana_list_workspaces"
        const fixedName = parts.slice(1).join("_");
        fixedTools[fixedName] = toolConfig;
      } else {
        fixedTools[toolName] = toolConfig;
      }
    }

    return fixedTools;
  };

  return originalMCPClient;
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
