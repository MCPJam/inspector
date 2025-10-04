import { MastraMCPServerDefinition, MCPClientOptions } from "@mastra/mcp";
import { MCPJamClientManager } from "../services/mcpjam-client-manager";
import {
  LlmsConfig,
  LlmsConfigSchema,
} from "../../evals-cli/src/utils/validators";
import { isMCPJamProvidedModel } from "../../shared/types";

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

export function transformLLMConfigToLlmsConfig(
  llmConfig: {
    provider: string;
    apiKey: string;
  },
  modelId?: string,
): LlmsConfig {
  const llms: Record<string, string> = {};
  const isMCPJamModel = modelId && isMCPJamProvidedModel(modelId);
  
  if (isMCPJamModel) {
    llms.openrouter = "BACKEND_EXECUTION";
  } else {
    const providerKey = llmConfig.provider.toLowerCase();
    llms[providerKey] = llmConfig.apiKey;
  }

  const validated = LlmsConfigSchema.safeParse(llms);
  if (!validated.success) {
    throw new Error(`Invalid LLM configuration: ${validated.error.message}`);
  }

  return validated.data;
}
