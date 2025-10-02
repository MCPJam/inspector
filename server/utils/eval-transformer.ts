import { MastraMCPServerDefinition, MCPClientOptions } from "@mastra/mcp";
import { MCPJamClientManager } from "../services/mcpjam-client-manager";
import {
  LlmsConfig,
  LlmsConfigSchema,
} from "../../evals-cli/src/utils/validators";

/**
 * Transforms server IDs from MCPJamClientManager to MCPClientOptions format
 * required by runEvals
 */
export function transformServerConfigsToEnvironment(
  serverIds: string[],
  clientManager: MCPJamClientManager,
): MCPClientOptions {
  const connectedServers = clientManager.getConnectedServers();
  const servers: Record<string, MastraMCPServerDefinition> = {};

  for (const serverId of serverIds) {
    const serverData = connectedServers[serverId];

    if (!serverData) {
      throw new Error(`Server '${serverId}' not found`);
    }

    if (serverData.status !== "connected") {
      throw new Error(
        `Server '${serverId}' is not connected (status: ${serverData.status})`,
      );
    }

    if (!serverData.config) {
      throw new Error(`Server '${serverId}' has no configuration`);
    }

    servers[serverId] = serverData.config;
  }

  if (Object.keys(servers).length === 0) {
    throw new Error("No valid servers provided");
  }

  return {
    servers,
  };
}

/**
 * Transforms LLM configuration from UI format to LlmsConfig format
 */
export function transformLLMConfigToLlmsConfig(llmConfig: {
  provider: string;
  apiKey: string;
}): LlmsConfig {
  const llms: Record<string, string> = {};

  // Map provider names to expected format
  const providerKey = llmConfig.provider.toLowerCase();
  llms[providerKey] = llmConfig.apiKey;

  // Validate the result
  const validated = LlmsConfigSchema.safeParse(llms);
  if (!validated.success) {
    throw new Error(`Invalid LLM configuration: ${validated.error.message}`);
  }

  return validated.data;
}
