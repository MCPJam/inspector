import { MCPClient, MastraMCPServerDefinition } from "@mastra/mcp";

export interface MultipleValidationResult {
  success: boolean;
  validConfigs?: Record<string, MastraMCPServerDefinition>;
  serverNameMapping?: Record<string, string>;
  errors?: Record<string, string>;
  error?: { message: string; status: number };
}

export function normalizeServerConfigName(serverName: string): string {
  return serverName
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function validateServerConfig(serverConfig: any): { success: boolean; config?: MastraMCPServerDefinition; error?: { message: string; status: number } } {
  if (!serverConfig) {
    return { success: false, error: { message: "Server configuration is required", status: 400 } };
  }

  const config = { ...serverConfig } as any;

  if (config.url) {
    try {
      if (typeof config.url === "string") {
        const parsed = new URL(config.url);
        parsed.search = "";
        parsed.hash = "";
        config.url = parsed;
      }

      // Translate headers -> requestInit for HTTP client usage
      if (config.headers) {
        config.requestInit = { ...(config.requestInit || {}), headers: config.headers };
      }
    } catch (error) {
      return { success: false, error: { message: `Invalid URL format: ${error}`, status: 400 } };
    }
  }

  return { success: true, config };
}

export const validateMultipleServerConfigs = (
  serverConfigs: Record<string, MastraMCPServerDefinition>,
): MultipleValidationResult => {
  if (!serverConfigs || Object.keys(serverConfigs).length === 0) {
    return { success: false, error: { message: "At least one server configuration is required", status: 400 } };
  }

  const validConfigs: Record<string, MastraMCPServerDefinition> = {};
  const serverNameMapping: Record<string, string> = {};
  const errors: Record<string, string> = {};
  let hasErrors = false;

  for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
    const validationResult = validateServerConfig(serverConfig);
    if (validationResult.success && validationResult.config) {
      const serverID = `${normalizeServerConfigName(serverName)}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
      validConfigs[serverID] = validationResult.config as any;
      serverNameMapping[serverID] = serverName;
    } else {
      hasErrors = true;
      errors[serverName] = validationResult.error?.message || "Configuration validation failed";
    }
  }

  if (!hasErrors) return { success: true, validConfigs, serverNameMapping };
  if (Object.keys(validConfigs).length > 0) return { success: false, validConfigs, serverNameMapping, errors };
  return { success: false, errors, error: { message: "All server configurations failed validation", status: 400 } };
};

export function createMCPClientWithMultipleConnections(
  serverConfigs: Record<string, MastraMCPServerDefinition>,
): MCPClient {
  const originalMCPClient = new MCPClient({ id: `chat-${Date.now()}`, servers: serverConfigs });
  const originalGetTools = originalMCPClient.getTools.bind(originalMCPClient);
  originalMCPClient.getTools = async () => {
    const tools = await originalGetTools();
    const fixedTools: Record<string, any> = {};
    for (const [toolName, toolConfig] of Object.entries(tools)) {
      const parts = toolName.split("_");
      if (parts.length >= 3 && parts[0] === parts[1]) {
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

