import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  isMCPJamProvidedModel,
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
  hasToken: (provider: any) => boolean;
  getLiteLLMBaseUrl: () => string;
  getLiteLLMModelAlias: () => string;
  getOpenRouterSelectedModels: () => string[];
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
}): ModelDefinition[] {
  const {
    hasToken,
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
    ollama: isOllamaRunning,
    litellm: Boolean(getLiteLLMBaseUrl() && getLiteLLMModelAlias()),
    openrouter: Boolean(
      hasToken("openrouter") && getOpenRouterSelectedModels().length > 0,
    ),
    meta: false,
    "x-ai": false,
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
