import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/state/app-types";

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
 * The wrapper shape a pasted/uploaded config used. Mirrors the MCP config
 * normalization in `@mcpjam/sdk`'s plugin-bundle parser
 * (sdk/src/plugin-bundle/mcp-config.ts, `normalizePluginMcpConfig`): a direct
 * server map, an `mcp_servers` wrapper (OpenAI plugin docs), or an
 * `mcpServers` wrapper (MCPJam/Claude style) all resolve to the same
 * `Record<serverName, config>` through this one code path.
 */
export type JsonConfigShape = "direct" | "mcp_servers" | "mcpServers";

export type ResolvedJsonServerMap =
  | { ok: true; shape: JsonConfigShape; servers: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Resolve a parsed JSON document to its server map. Single source of truth for
 * the three compatible source shapes — `parseJsonConfig` and
 * `validateJsonConfig` both go through here, so they can never disagree about
 * which shapes are accepted.
 *
 * Shape-detection semantics intentionally mirror the SDK plugin-bundle parser
 * (which the backend runs on imported plugin bundles):
 * - declaring BOTH `mcp_servers` and `mcpServers` is an error;
 * - a bare single server object (top-level string `command`/`url`) is
 *   rejected — only string values indicate that shape, since a direct map may
 *   legitimately contain a server NAMED "url" or "command" (object value);
 * - anything else that is a plain object is treated as a direct server map.
 */
export function resolveJsonServerMap(config: unknown): ResolvedJsonServerMap {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "Configuration must be a JSON object" };
  }
  const record = config as Record<string, unknown>;

  const hasSnake = record.mcp_servers !== undefined;
  const hasCamel = record.mcpServers !== undefined;
  if (hasSnake && hasCamel) {
    return {
      ok: false,
      error:
        'Configuration declares both "mcp_servers" and "mcpServers"; use only one',
    };
  }

  let shape: JsonConfigShape = "direct";
  let serverMap: unknown = record;
  if (hasSnake) {
    shape = "mcp_servers";
    serverMap = record.mcp_servers;
  } else if (hasCamel) {
    shape = "mcpServers";
    serverMap = record.mcpServers;
  } else if (
    typeof record.command === "string" ||
    typeof record.url === "string"
  ) {
    return {
      ok: false,
      error:
        'Configuration looks like a single server config; wrap it in "mcpServers": { "server-name": { ... } }',
    };
  }

  if (
    serverMap === null ||
    typeof serverMap !== "object" ||
    Array.isArray(serverMap)
  ) {
    // Preserves the long-standing message for a malformed `mcpServers` value.
    return {
      ok: false,
      error: `missing or invalid "${shape}" property`,
    };
  }

  return { ok: true, shape, servers: serverMap as Record<string, unknown> };
}

/**
 * Shared per-entry guard: a server config must be a plain object (not null,
 * not an array). Used by both `parseJsonConfig` and `validateJsonConfig` so
 * the two paths cannot silently diverge.
 */
function isServerConfigRecord(value: unknown): value is JsonServerConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
 * Parses a JSON config file and converts it to ServerFormData array.
 * Accepts a direct server map, an `mcp_servers` wrapper, or an `mcpServers`
 * wrapper — all three resolve through `resolveJsonServerMap` and then share
 * the same per-server mapping, so identical server configs import identically
 * regardless of wrapper shape.
 * @param jsonContent - The JSON string content
 * @returns Array of ServerFormData objects
 */
export function parseJsonConfig(jsonContent: string): ServerFormData[] {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const resolved = resolveJsonServerMap(config);
    if (!resolved.ok) {
      throw new Error(`Invalid JSON config: ${resolved.error}`);
    }

    const servers: ServerFormData[] = [];

    for (const [serverName, rawServerConfig] of Object.entries(
      resolved.servers,
    )) {
      if (!isServerConfigRecord(rawServerConfig)) {
        console.warn(`Skipping invalid server config for "${serverName}"`);
        continue;
      }
      const serverConfig = rawServerConfig;

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
 * Validates a JSON config file without parsing it. Accepts the same three
 * shapes as `parseJsonConfig` (shared `resolveJsonServerMap` code path).
 * @param jsonContent - The JSON string content
 * @returns Validation result with success status and error message
 */
export function validateJsonConfig(jsonContent: string): {
  success: boolean;
  error?: string;
} {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const resolved = resolveJsonServerMap(config);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    const serverNames = Object.keys(resolved.servers);
    if (serverNames.length === 0) {
      return {
        success: false,
        error: "No servers found in the configuration",
      };
    }

    // Validate each server config
    for (const [serverName, serverConfig] of Object.entries(resolved.servers)) {
      if (!isServerConfigRecord(serverConfig)) {
        return {
          success: false,
          error: `Invalid server config for "${serverName}"`,
        };
      }

      const configObj = serverConfig;
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
