import { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  isMCPJamProvidedModel,
  Model,
} from "@/shared/types";

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
  getLiteLLMBaseUrl: () => string;
  getLiteLLMModelAlias: () => string;
  getOpenRouterSelectedModels: () => string[];
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
  getAzureBaseUrl: () => string;
}): ModelDefinition[] {
  const {
    hasToken,
    getAzureBaseUrl,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
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
    litellm: Boolean(getLiteLLMBaseUrl() && getLiteLLMModelAlias()),
    openrouter: Boolean(
      hasToken("openrouter") && getOpenRouterSelectedModels().length > 0,
    ),
    meta: false,
  } as const;

  const cloud = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(m.id)) return true;
    return providerHasKey[m.provider];
  });

  const litellmModels: ModelDefinition[] = providerHasKey.litellm
    ? parseModelAliases(getLiteLLMModelAlias(), "litellm")
    : [];

  const openRouterModels: ModelDefinition[] = providerHasKey.openrouter
    ? getOpenRouterSelectedModels().map((id) => ({
        id,
        name: id,
        provider: "openrouter" as const,
      }))
    : [];

  let models: ModelDefinition[] = cloud;
  if (isOllamaRunning && ollamaModels.length > 0)
    models = models.concat(ollamaModels);
  if (litellmModels.length > 0) models = models.concat(litellmModels);
  if (openRouterModels.length > 0) models = models.concat(openRouterModels);
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
