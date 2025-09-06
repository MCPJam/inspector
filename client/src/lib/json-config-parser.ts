import { ServerFormData } from "@/shared/types.js";

export interface JsonServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface JsonConfig {
  mcpServers: Record<string, JsonServerConfig>;
}

/**
 * Parses a JSON config file and converts it to ServerFormData array
 * @param jsonContent - The JSON string content
 * @returns Array of ServerFormData objects
 */
export function parseJsonConfig(jsonContent: string): ServerFormData[] {
  try {
    const config: JsonConfig = JSON.parse(jsonContent);
    
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new Error('Invalid JSON config: missing or invalid "mcpServers" property');
    }

    const servers: ServerFormData[] = [];

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (!serverConfig || typeof serverConfig !== 'object') {
        console.warn(`Skipping invalid server config for "${serverName}"`);
        continue;
      }

      // Only support STDIO servers (MCP default format)
      if (serverConfig.command) {
        servers.push({
          name: serverName,
          type: "stdio",
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {},
        });
      } else {
        console.warn(`Skipping server "${serverName}": missing required command`);
        continue;
      }
    }

    return servers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid JSON format: ' + error.message);
    }
    throw error;
  }
}

/**
 * Validates a JSON config file without parsing it
 * @param jsonContent - The JSON string content
 * @returns Validation result with success status and error message
 */
export function validateJsonConfig(jsonContent: string): { success: boolean; error?: string } {
  try {
    const config = JSON.parse(jsonContent);
    
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      return { success: false, error: 'Missing or invalid "mcpServers" property' };
    }

    const serverNames = Object.keys(config.mcpServers);
    if (serverNames.length === 0) {
      return { success: false, error: 'No servers found in "mcpServers" object' };
    }

    // Validate each server config
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (!serverConfig || typeof serverConfig !== 'object') {
        return { success: false, error: `Invalid server config for "${serverName}"` };
      }

      const configObj = serverConfig as JsonServerConfig;
      const hasCommand = configObj.command && typeof configObj.command === 'string';

      if (!hasCommand) {
        return { 
          success: false, 
          error: `Server "${serverName}" must have a "command" property` 
        };
      }
    }

    return { success: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: 'Invalid JSON format: ' + error.message };
    }
    return { success: false, error: 'Unknown error: ' + (error as Error).message };
  }
}

