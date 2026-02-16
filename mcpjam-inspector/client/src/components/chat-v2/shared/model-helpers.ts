import { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  isMCPJamProvidedModel,
  Model,
} from "@/shared/types";
import type { CustomProvider } from "@mcpjam/sdk";

export function parseModelAliases(
  aliasString: string,
  provider: ModelProvider,
): ModelDefinition[] {
  return aliasString
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0)
    .map((alias) => ({ id: alias, name: alias, provider }));
}

export function buildAvailableModels(params: {
  hasToken: (provider: keyof ProviderTokens) => boolean;
  getOpenRouterSelectedModels: () => string[];
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
  getAzureBaseUrl: () => string;
  customProviders: CustomProvider[];
}): ModelDefinition[] {
  const {
    hasToken,
    getAzureBaseUrl,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    customProviders,
  } = params;

  const providerHasKey: Record<string, boolean> = {
    anthropic: hasToken("anthropic"),
    openai: hasToken("openai"),
    deepseek: hasToken("deepseek"),
    google: hasToken("google"),
    mistral: hasToken("mistral"),
    xai: hasToken("xai"),
    azure: Boolean(getAzureBaseUrl()),
    ollama: isOllamaRunning,
    openrouter: Boolean(
      hasToken("openrouter") && getOpenRouterSelectedModels().length > 0,
    ),
    meta: false,
  } as const;

  const cloud = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(m.id)) return true;
    return providerHasKey[m.provider];
  });

  const openRouterModels: ModelDefinition[] = providerHasKey.openrouter
    ? getOpenRouterSelectedModels().map((id) => ({
        id,
        name: id,
        provider: "openrouter" as const,
      }))
    : [];

  const customModels: ModelDefinition[] = customProviders.flatMap((cp) =>
    cp.modelIds.map((modelId) => ({
      id: `custom:${cp.name}:${modelId}`,
      name: modelId,
      provider: "custom" as const,
      customProviderName: cp.name,
    })),
  );

  let models: ModelDefinition[] = cloud;
  if (isOllamaRunning && ollamaModels.length > 0)
    models = models.concat(ollamaModels);
  if (openRouterModels.length > 0) models = models.concat(openRouterModels);
  if (customModels.length > 0) models = models.concat(customModels);
  return models;
}

export const getDefaultModel = (
  availableModels: ModelDefinition[],
): ModelDefinition => {
  const modelIdsByPriority: Array<Model | string> = [
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5-mini",
    "meta-llama/llama-4-scout",
    Model.CLAUDE_3_7_SONNET_LATEST, // anthropic
    Model.GPT_4_1, // openai
    Model.GEMINI_2_5_PRO, // google
    Model.DEEPSEEK_CHAT, // deepseek
    Model.MISTRAL_LARGE_LATEST, // mistral
  ];

  for (const id of modelIdsByPriority) {
    const found = availableModels.find((m) => m.id === id);
    if (found) return found;
  }
  return availableModels[0];
};
