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
  provider: ModelProvider
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
      hasToken("openrouter") && getOpenRouterSelectedModels().length > 0
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
    }))
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
  providerKey: string
): boolean {
  if (!orgConfig?.providers) return false;
  return orgConfig.providers.some((p) => {
    if (p.providerKey !== providerKey) return false;
    if (!p.enabled) return false;
    // Ollama only needs baseUrl, not a secret
    if (p.providerKey === "ollama") return Boolean(p.baseUrl);
    if (p.providerKey.startsWith("custom:")) {
      return Boolean(p.baseUrl && p.modelIds && p.modelIds.length > 0);
    }
    return p.hasSecret;
  });
}

/**
 * Build the list of available models from an organization's provider config.
 * Used in org-backed projects where the server resolves API keys.
 *
 * For Ollama, static SUPPORTED_MODELS entries are absent (models are
 * org/user-specific), but org-configured modelIds are added directly below
 * so hosted local-runtime Ollama providers appear in the model picker.
 */
export function buildAvailableModelsFromOrgConfig(
  orgConfig: OrgVisibleConfig | undefined
): ModelDefinition[] {
  if (!orgConfig?.providers) {
    // No org config loaded yet — return only MCPJam-provided models
    return SUPPORTED_MODELS.filter((m) => isMCPJamProvidedModel(String(m.id)));
  }

  // Determine which provider keys are available. Ollama is skipped — it never
  // belongs in the hosted model list.
  const availableProviderKeys = new Set<string>();
  for (const p of orgConfig.providers) {
    if (!p.enabled) continue;
    if (p.providerKey === "ollama") continue;
    if (p.hasSecret) availableProviderKeys.add(p.providerKey);
  }

  // Always include MCPJam-provided models
  const models: ModelDefinition[] = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(String(m.id))) return true;
    return availableProviderKeys.has(m.provider);
  });

  // OpenRouter: include selectedModels from org config
  const openRouterConfig = orgConfig.providers.find(
    (p) => p.providerKey === "openrouter" && p.enabled && p.hasSecret
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

  // Amazon Bedrock: include selectedModels from org config. Like OpenRouter,
  // the usable model set is org-specific (Bedrock model access is granted per
  // AWS account), so SUPPORTED_MODELS has no static bedrock entries.
  const bedrockConfig = orgConfig.providers.find(
    (p) => p.providerKey === "bedrock" && p.enabled && p.hasSecret
  );
  if (
    bedrockConfig?.selectedModels &&
    bedrockConfig.selectedModels.length > 0
  ) {
    const bedrockModels: ModelDefinition[] = bedrockConfig.selectedModels.map(
      (id) => ({
        id,
        name: id,
        provider: "bedrock" as const,
      })
    );
    models.push(...bedrockModels);
  }

  // Ollama: include configured modelIds so org-managed Ollama providers appear
  // in the model picker (SUPPORTED_MODELS has no static ollama entries since
  // models are dynamic and org-specific).
  for (const p of orgConfig.providers) {
    if (p.providerKey !== "ollama") continue;
    if (!p.enabled || !p.baseUrl || !p.modelIds || p.modelIds.length === 0)
      continue;
    for (const modelId of p.modelIds) {
      models.push({
        id: modelId,
        name: modelId,
        provider: "ollama" as const,
      });
    }
  }

  // Custom providers (providerKey starts with "custom:")
  for (const p of orgConfig.providers) {
    if (!p.providerKey.startsWith("custom:")) continue;
    if (!p.enabled || !p.baseUrl || !p.modelIds || p.modelIds.length === 0)
      continue;
    // customProviderName must be the slug from the providerKey so that the
    // server's deriveOrgProviderKey can rebuild "custom:<slug>" and look it
    // up against the persisted org config. The human-readable displayName
    // is only used for the model's UI label.
    const customSlug = p.providerKey.replace(/^custom:/, "");
    const displayLabel = p.displayName || customSlug;
    for (const modelId of p.modelIds ?? []) {
      models.push({
        id: `custom:${customSlug}:${modelId}`,
        name: `${displayLabel} / ${modelId}`,
        provider: "custom" as const,
        customProviderName: customSlug,
      });
    }
  }

  return models;
}

/** Strip the redundant "(Free)" tier suffix for denser labels. */
export function compactModelLabel(name: string | undefined | null): string {
  if (!name) return "";
  return name.replace(/\s*\(Free\)\s*$/i, "").trim() || name;
}

/** Display name for a provider group key (handles `custom:<slug>`). */
export function getProviderDisplayName(groupKey: string): string {
  if (groupKey.startsWith("custom:")) {
    return groupKey.slice("custom:".length);
  }

  switch (groupKey) {
    case "azure":
      return "Azure OpenAI";
    case "bedrock":
      return "Amazon Bedrock";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "deepseek":
      return "DeepSeek";
    case "google":
      return "Google AI";
    case "mistral":
      return "Mistral AI";
    case "ollama":
      return "Ollama";
    case "meta":
      return "Meta";
    case "xai":
      return "xAI";
    case "openrouter":
      return "OpenRouter";
    case "moonshotai":
      return "Moonshot AI";
    case "z-ai":
      return "Zhipu AI";
    case "minimax":
      return "MiniMax";
    case "qwen":
      return "Qwen";
    default:
      return groupKey;
  }
}

/** Logo lookup name — collapses `custom:<slug>` to `custom`. */
export function getLogoProvider(groupKey: string): string {
  return groupKey.startsWith("custom:") ? "custom" : groupKey;
}

export interface ModelMenuItem {
  id: string;
  name: string;
  provider: string;
  customProviderName?: string;
}

const OWN_PROVIDER_SOURCES = new Set([
  "azure",
  "bedrock",
  "custom",
  "ollama",
  "openrouter",
]);

export function isMCPJamProvidedModelMenuItem(model: ModelMenuItem): boolean {
  if (OWN_PROVIDER_SOURCES.has(model.provider)) {
    return false;
  }
  return isMCPJamProvidedModel(String(model.id));
}

export interface ModelMenuGroup<T extends ModelMenuItem> {
  /** Group key — provider name, or `custom:<slug>` for custom providers. */
  provider: string;
  title: string;
  /** "provided" = MCPJam-hosted free models; "configured" = user/org BYOK models. */
  providerType: "provided" | "configured";
  models: T[];
}

/**
 * Group models by their provider key, splitting MCPJam-provided "free" tier
 * out from user/org-configured models so the menu can label each section
 * clearly. Custom providers are keyed as `custom:<slug>`.
 */
export function buildModelMenuGroups<T extends ModelMenuItem>(
  models: T[],
  options: { hideProvidedModels?: boolean } = {}
): ModelMenuGroup<T>[] {
  const { hideProvidedModels = false } = options;

  const byProvider = new Map<string, T[]>();
  for (const model of models) {
    const key =
      model.provider === "custom" && model.customProviderName
        ? `custom:${model.customProviderName}`
        : model.provider;
    const existing = byProvider.get(key);
    if (existing) {
      existing.push(model);
    } else {
      byProvider.set(key, [model]);
    }
  }

  const sortedKeys = Array.from(byProvider.keys()).sort();
  const groups: ModelMenuGroup<T>[] = [];

  for (const provider of sortedKeys) {
    const list = byProvider.get(provider) ?? [];
    const filtered = hideProvidedModels
      ? list.filter((m) => !isMCPJamProvidedModelMenuItem(m))
      : list;
    if (filtered.length === 0) continue;

    const provided = filtered.filter((m) => isMCPJamProvidedModelMenuItem(m));
    const configured = filtered.filter(
      (m) => !isMCPJamProvidedModelMenuItem(m)
    );
    const title = getProviderDisplayName(provider);

    if (provided.length > 0) {
      groups.push({
        provider,
        title,
        providerType: "provided",
        models: provided,
      });
    }
    if (configured.length > 0) {
      groups.push({
        provider,
        title,
        providerType: "configured",
        models: configured,
      });
    }
  }

  return groups;
}

export const getDefaultModel = (
  availableModels: ModelDefinition[]
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
