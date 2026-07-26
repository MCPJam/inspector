import { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  SUPPORTED_MODELS,
  type ModelDefinition,
  type ModelProvider,
  hostedModelDefinitionsFromSnapshot,
  isMCPJamProvidedModel,
  Model,
} from "@/shared/types";
import type { CustomProvider } from "@mcpjam/sdk/browser";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
// Provider display name + title-casing live in the centralized provider
// registry; imported for local use and re-exported so existing importers work.
import {
  getProviderDisplayName,
  titleCaseProviderKey,
} from "@/lib/provider-registry";

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
  /**
   * The hosted ("free") model source. When provided (the backend catalog),
   * it replaces the static `SUPPORTED_MODELS.filter(isMCPJamProvidedModel)`
   * subset; BYOK-key-derived models still come from `SUPPORTED_MODELS`. Absent
   * → the pre-catalog static behavior (keeps un-wired callers + tests working).
   */
  hostedCatalog?: ModelDefinition[];
}): ModelDefinition[] {
  const {
    hasToken,
    getAzureBaseUrl,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    customProviders,
    hostedCatalog,
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

  const hosted = hostedCatalog ?? hostedModelDefinitionsFromSnapshot();
  // BYOK models the user has a key for — hosted ids handled by `hosted` above,
  // so exclude them here to avoid duplicates when a static model is both.
  const byok = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(String(m.id))) return false;
    return providerHasKey[m.provider];
  });
  const cloud = [...hosted, ...byok];

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
  orgConfig: OrgVisibleConfig | undefined,
  /** Hosted ("free") source; see `buildAvailableModels`. */
  hostedCatalog?: ModelDefinition[]
): ModelDefinition[] {
  const hosted = hostedCatalog ?? hostedModelDefinitionsFromSnapshot();

  if (!orgConfig?.providers) {
    // No org config loaded yet — return only MCPJam-provided (hosted) models
    return hosted;
  }

  // Determine which provider keys are available. Ollama is skipped — it never
  // belongs in the hosted model list.
  const availableProviderKeys = new Set<string>();
  for (const p of orgConfig.providers) {
    if (!p.enabled) continue;
    if (p.providerKey === "ollama") continue;
    if (p.hasSecret) availableProviderKeys.add(p.providerKey);
  }

  // Hosted models plus the org-key-derived provider models (hosted ids excluded
  // from the latter so a static model that is both isn't duplicated).
  const orgKeyModels = SUPPORTED_MODELS.filter((m) => {
    if (isMCPJamProvidedModel(String(m.id))) return false;
    return availableProviderKeys.has(m.provider);
  });
  const models: ModelDefinition[] = [...hosted, ...orgKeyModels];

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

// Re-exported from the centralized provider registry (imported at top) so
// existing importers of these names keep working.
export { getProviderDisplayName, titleCaseProviderKey };

/** Logo lookup name — collapses `custom:<slug>` to `custom`. */
export function getLogoProvider(groupKey: string): string {
  return groupKey.startsWith("custom:") ? "custom" : groupKey;
}

export interface ModelMenuItem {
  id: string;
  name: string;
  provider: string;
  customProviderName?: string;
  /** Set by the backend catalog source; see `ModelDefinition.hosted`. */
  hosted?: boolean;
}

const OWN_PROVIDER_SOURCES = new Set([
  "azure",
  "bedrock",
  "custom",
  "ollama",
  "openrouter",
]);

export function isMCPJamProvidedModelMenuItem(model: ModelMenuItem): boolean {
  // The catalog-sourced `hosted` flag is authoritative — a catalog-only model
  // (not in the static list) still classifies as MCPJam-provided.
  if (model.hosted === true) {
    return true;
  }
  if (OWN_PROVIDER_SOURCES.has(model.provider)) {
    return false;
  }
  // Back-compat for static-derived items that carry no `hosted` flag.
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
    // BYOK counterparts of the hosted picks above. A "Your providers"-only
    // list matched none of the hosted ids and fell through to Sonnet 3.7 —
    // or, with no anthropic key, all the way to `availableModels[0]`, which
    // is whatever sorts first in SUPPORTED_MODELS (Claude Fable 5). A BYOK
    // key that has no access to that model then fails on the first tool
    // call. See BACK2-628.
    Model.CLAUDE_HAIKU_4_5, // anthropic
    Model.GPT_5_MINI, // openai
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

/**
 * Pick which "Your providers" model to land on when the out-of-credits
 * hand-off switches the user off the free tier.
 *
 * Order:
 *   1. the own-provider model they last chose, when it is still available
 *      (the user's own answer beats any heuristic);
 *   2. `getDefaultModel`'s priority list, restricted to own-provider rows;
 *   3. the first selectable row.
 *
 * Step 3 used to be the only step. Own-provider models are never marked
 * `disabled` — availability is inferred from "the user has a key for this
 * provider at all", not from what that key can actually reach — so the
 * previous `.find(m => !m.disabled)` could not screen out a model the key
 * has no access to, and alphabetical provider order plus SUPPORTED_MODELS
 * order made that Claude Fable 5 every time. See BACK2-628.
 */
export function pickOwnProviderModel(
  configuredModels: ModelDefinition[],
  lastUsedModelId?: string | null
): ModelDefinition | undefined {
  const selectable = configuredModels.filter((model) => !model.disabled);
  if (selectable.length === 0) return undefined;

  const lastUsed = lastUsedModelId?.trim();
  if (lastUsed) {
    const match = selectable.find((model) => String(model.id) === lastUsed);
    if (match) return match;
  }

  return getDefaultModel(selectable);
}
