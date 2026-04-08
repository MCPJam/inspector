import { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  isMCPJamProvidedModel,
  Model,
} from "@/shared/types";
import type { CustomProvider } from "@mcpjam/sdk/browser";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";

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

/**
 * OrgVisibleConfig shape as returned by the org model config query.
 */
export type OrgVisibleConfig = {
  providers: OrgModelProvider[];
};

/**
 * Check whether a given provider key is present and available in the org config.
 */
export function isOrgProviderAvailable(
  orgConfig: OrgVisibleConfig | undefined,
  providerKey: string,
): boolean {
  if (!orgConfig?.providers) return false;
  return orgConfig.providers.some((p) => {
    if (p.providerKey !== providerKey) return false;
    if (!p.enabled) return false;
    // Ollama only needs baseUrl, not a secret
    if (p.providerKey === "ollama") return Boolean(p.baseUrl);
    return p.hasSecret;
  });
}

/**
 * Build the list of available models from an organization's provider config.
 * Used in org-backed workspaces where the server resolves API keys.
 */
export function buildAvailableModelsFromOrgConfig(
  orgConfig: OrgVisibleConfig | undefined,
): ModelDefinition[] {
  if (!orgConfig?.providers) {
    // No org config loaded yet — return only MCPJam-provided models
    return SUPPORTED_MODELS.filter((m) => isMCPJamProvidedModel(String(m.id)));
  }

  // Determine which provider keys are available
  const availableProviderKeys = new Set<string>();
  for (const p of orgConfig.providers) {
    if (!p.enabled) continue;
    // Ollama only needs baseUrl; all others need hasSecret
    if (p.providerKey === "ollama") {
      if (p.baseUrl) availableProviderKeys.add(p.providerKey);
    } else {
      if (p.hasSecret) availableProviderKeys.add(p.providerKey);
    }
  }

  // Always include MCPJam-provided models
  const models: ModelDefinition[] = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(String(m.id))) return true;
    return availableProviderKeys.has(m.provider);
  });

  // OpenRouter: include selectedModels from org config
  const openRouterConfig = orgConfig.providers.find(
    (p) => p.providerKey === "openrouter" && p.enabled && p.hasSecret,
  );
  if (
    openRouterConfig?.selectedModels &&
    openRouterConfig.selectedModels.length > 0
  ) {
    const openRouterModels: ModelDefinition[] =
      openRouterConfig.selectedModels.map((id) => ({
        id,
        name: id,
        provider: "openrouter" as const,
      }));
    models.push(...openRouterModels);
  }

  // Custom providers (providerKey starts with "custom:")
  for (const p of orgConfig.providers) {
    if (!p.providerKey.startsWith("custom:")) continue;
    if (!p.enabled || !p.hasSecret) continue;
    const customName = p.displayName || p.providerKey.replace(/^custom:/, "");
    for (const modelId of p.modelIds ?? []) {
      models.push({
        id: `custom:${customName}:${modelId}`,
        name: modelId,
        provider: "custom" as const,
        customProviderName: customName,
      });
    }
  }

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
