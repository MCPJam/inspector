import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/state/app-types";
import {
  unwrapMcpServerMap,
  type UnwrapFailureReason,
} from "@/lib/plugins/mcp-config-shape";

export interface JsonServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "sse";
  url?: string;
}

export interface JsonConfig {
  mcpServers: Record<string, JsonServerConfig>;
}

/**
 * Map an unwrap failure to the legacy user-facing message. The wording is kept
 * byte-identical to the pre-refactor parser so existing callers/tests and the
 * import modal copy are unchanged; only the set of ACCEPTED shapes widened (a
 * bare `mcp_servers` wrapper and a direct server map now parse identically to
 * `mcpServers`).
 */
function unwrapErrorMessage(reason: UnwrapFailureReason): string {
  if (reason === "both-wrappers") {
    return 'Invalid JSON config: cannot declare both "mcp_servers" and "mcpServers"';
  }
  return 'Invalid JSON config: missing or invalid "mcpServers" property';
}

function validateErrorMessage(reason: UnwrapFailureReason): string {
  if (reason === "both-wrappers") {
    return 'Cannot declare both "mcp_servers" and "mcpServers"';
  }
  return 'Missing or invalid "mcpServers" property';
}

/**
 * Formats ServerWithName objects to JSON config format
 * @param serversObj - Record of server names to ServerWithName objects
 * @returns JsonConfig object ready for export
 */
export function formatJsonConfig(
  serversObj: Record<string, ServerWithName>,
): JsonConfig {
  const mcpServers: Record<string, JsonServerConfig> = {};

  for (const [key, server] of Object.entries(serversObj)) {
    const { config } = server;

    // Check if it's an SSE type (has URL) or stdio type (has command)
    if ("url" in config && config.url) {
      mcpServers[key] = {
        type: "sse",
        url: config.url.toString(),
      };
    } else if ("command" in config && config.command) {
      const serverConfig: JsonServerConfig = {
        command: config.command,
        args: config.args || [],
      };

      // Only add env if it exists and has properties
      if (config.env && Object.keys(config.env).length > 0) {
        serverConfig.env = config.env;
      }

      mcpServers[key] = serverConfig;
    } else {
      console.warn(`Skipping server "${key}": missing required url or command`);
    }
  }

  return { mcpServers };
}

/**
 * Parses a JSON config file and converts it to ServerFormData array
 * @param jsonContent - The JSON string content
 * @returns Array of ServerFormData objects
 */
export function parseJsonConfig(jsonContent: string): ServerFormData[] {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const unwrapped = unwrapMcpServerMap(config);
    if (!unwrapped.ok) {
      throw new Error(unwrapErrorMessage(unwrapped.reason));
    }

    const servers: ServerFormData[] = [];

    for (const [serverName, serverConfig] of Object.entries(
      unwrapped.servers,
    ) as Array<[string, JsonServerConfig]>) {
      if (!serverConfig || typeof serverConfig !== "object") {
        console.warn(`Skipping invalid server config for "${serverName}"`);
        continue;
      }

      // Determine server type based on config
      if (serverConfig.type === "sse" || serverConfig.url) {
        // HTTP/SSE server
        servers.push({
          name: serverName,
          type: "http",
          url: serverConfig.url || "",
          headers: {},
          env: {},
          useOAuth: false,
        });
      } else if (serverConfig.command) {
        // STDIO server (MCP default format)
        servers.push({
          name: serverName,
          type: "stdio",
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {},
        });
      } else {
        console.warn(
          `Skipping server "${serverName}": missing required command`,
        );
        continue;
      }
    }

    return servers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid JSON format: " + error.message);
    }
    throw error;
  }
}

/**
 * Validates a JSON config file without parsing it
 * @param jsonContent - The JSON string content
 * @returns Validation result with success status and error message
 */
export function validateJsonConfig(jsonContent: string): {
  success: boolean;
  error?: string;
} {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const unwrapped = unwrapMcpServerMap(config);
    if (!unwrapped.ok) {
      return {
        success: false,
        error: validateErrorMessage(unwrapped.reason),
      };
    }

    const serverNames = Object.keys(unwrapped.servers);
    if (serverNames.length === 0) {
      return {
        success: false,
        error: 'No servers found in "mcpServers" object',
      };
    }

    // Validate each server config
    for (const [serverName, serverConfig] of Object.entries(
      unwrapped.servers,
    ) as Array<[string, JsonServerConfig]>) {
      if (!serverConfig || typeof serverConfig !== "object") {
        return {
          success: false,
          error: `Invalid server config for "${serverName}"`,
        };
      }

      const configObj = serverConfig as JsonServerConfig;
      const hasCommand =
        configObj.command && typeof configObj.command === "string";
      const hasUrl = configObj.url && typeof configObj.url === "string";
      const isSse = configObj.type === "sse";

      if (!hasCommand && !hasUrl && !isSse) {
        return {
          success: false,
          error: `Server "${serverName}" must have either "command" or "url" property`,
        };
      }

      if (hasCommand && hasUrl) {
        return {
          success: false,
          error: `Server "${serverName}" cannot have both "command" and "url" properties`,
        };
      }
    }

    return { success: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: "Invalid JSON format: " + error.message };
    }
    return {
      success: false,
      error: "Unknown error: " + (error as Error).message,
    };
  }
}

/**
 * Downloads an object as a formatted JSON file.
 * @param filename - Output filename
 * @param data - Serializable JSON data
 */
export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
