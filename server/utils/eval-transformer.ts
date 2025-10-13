import { MCPClientOptions } from "@mastra/mcp";
import { MCPClientManager, MCPServerConfig } from "@/sdk";
import {
  LlmsConfig,
  LlmsConfigSchema,
} from "../../evals-cli/src/utils/validators";
import { isMCPJamProvidedModel } from "../../shared/types";

/**
 * Transforms server IDs from MCPClientManager to MCPClientOptions format
 * required by runEvals
 */
export function transformServerConfigsToEnvironment(
  serverIds: string[],
  clientManager: MCPClientManager,
): MCPClientOptions {
  const servers: Record<string, MCPServerConfig> = {};

  for (const serverId of serverIds) {
    const config = clientManager.getServerConfig(serverId);
    if (!config) {
      throw new Error(`Server '${serverId}' not found`);
    }

    const status = clientManager.getConnectionStatus(serverId);
    if (status !== "connected") {
      throw new Error(
        `Server '${serverId}' is not connected (status: ${status})`,
      );
    }

    servers[serverId] = config;
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
