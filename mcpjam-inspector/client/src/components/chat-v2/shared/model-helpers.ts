import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  isMCPJamProvidedModel,
  Model,
} from "@/shared/types";
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
 * Local-only model discovery (for example a user's in-process Ollama daemon)
 * is intentionally appended by callers, because those models depend on the
 * machine running the inspector rather than organization config alone.
 *
 * Callers that append local-discovered Ollama models MUST dedupe by `id`:
 * org-configured `modelIds` may already include matching names, and the
 * returned list keys models on `id` alone (provider is fixed to "ollama"
 * for both sources). See `use-chat-session.ts` and
 * `use-available-eval-models.ts` for the canonical filter pattern.
 */
export function buildAvailableModelsFromOrgConfig(
  orgConfig: OrgVisibleConfig | undefined,
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

export const getDefaultModel = (
  availableModels: ModelDefinition[],
): ModelDefinition => {
  const modelIdsByPriority: Array<Model | string> = [
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5-mini",
    "meta-llama/llama-4-scout",
    Model.CLAUDE_SONNET_4_6, // anthropic (was 3.7-sonnet, retired 2026-02-19)
    Model.GPT_4_1, // openai
    Model.GEMINI_2_5_PRO, // google
    Model.DEEPSEEK_V4_FLASH, // deepseek (was deepseek-chat, deprecating)
    Model.MISTRAL_LARGE_3, // mistral (was mistral-large-latest)
  ];

  for (const id of modelIdsByPriority) {
    const found = availableModels.find((m) => m.id === id);
    if (found) return found;
  }
  return availableModels[0];
};
