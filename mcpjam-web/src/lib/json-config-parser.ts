import type { ServerFormData } from "@/types/server-types";
import type { ServerWithName } from "@/types/server-types";

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

function isLocalAddress(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost") return true;
  if (lowered.endsWith(".localhost")) return true;
  if (lowered.endsWith(".local")) return true;
  if (lowered === "127.0.0.1" || lowered === "::1") return true;
  if (/^10\./.test(lowered)) return true;
  if (/^192\.168\./.test(lowered)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lowered)) return true;
  return false;
}

function validateHostedUrl(urlValue: string, serverName: string): string {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Server "${serverName}" has invalid URL format`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Server "${serverName}" must use HTTPS`);
  }

  if (isLocalAddress(url.hostname)) {
    throw new Error(
      `Server "${serverName}" cannot use localhost/private network URLs`,
    );
  }

  return url.toString();
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
    const config: JsonConfig = JSON.parse(jsonContent);

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      throw new Error(
        'Invalid JSON config: missing or invalid "mcpServers" property',
      );
    }

    const servers: ServerFormData[] = [];

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      if (!serverConfig || typeof serverConfig !== "object") {
        throw new Error(`Invalid server config for "${serverName}"`);
      }

      if (serverConfig.command) {
        throw new Error(
          `Server "${serverName}" is STDIO and unsupported in mcpjam-web`,
        );
      }

      if (!serverConfig.url || typeof serverConfig.url !== "string") {
        throw new Error(`Server "${serverName}" must include an HTTPS "url"`);
      }

      servers.push({
        name: serverName,
        type: "http",
        url: validateHostedUrl(serverConfig.url, serverName),
        headers: {},
        env: {},
        useOAuth: false,
      });
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
    const config = JSON.parse(jsonContent);

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      return {
        success: false,
        error: 'Missing or invalid "mcpServers" property',
      };
    }

    const serverNames = Object.keys(config.mcpServers);
    if (serverNames.length === 0) {
      return {
        success: false,
        error: 'No servers found in "mcpServers" object',
      };
    }

    // Validate each server config
    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      if (!serverConfig || typeof serverConfig !== "object") {
        return {
          success: false,
          error: `Invalid server config for "${serverName}"`,
        };
      }

      const configObj = serverConfig as JsonServerConfig;
      const hasUrl = configObj.url && typeof configObj.url === "string";
      if (configObj.command) {
        return {
          success: false,
          error: `Server "${serverName}" uses STDIO and is unsupported in mcpjam-web`,
        };
      }

      if (!hasUrl) {
        return {
          success: false,
          error: `Server "${serverName}" must include an HTTPS "url"`,
        };
      }

      try {
        validateHostedUrl(configObj.url!, serverName);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Invalid URL",
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
