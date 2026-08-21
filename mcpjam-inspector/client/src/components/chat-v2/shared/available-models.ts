import type { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  hostedModelDefinitionsFromSnapshot,
  isMCPJamGuestAllowedModel,
  type ModelDefinition,
} from "@/shared/types";
import type { CustomProvider } from "@mcpjam/sdk/browser";
import { HOSTED_MODE } from "@/lib/config";
import {
  buildAvailableModels,
  buildAvailableModelsFromOrgConfig,
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "./model-helpers";

// Kept separate from model-helpers so tests can mock the per-source
// builders (buildAvailableModels / buildAvailableModelsFromOrgConfig)
// while this composition stays real.

export const GUEST_LOCKED_MODEL_REASON =
  "Sign in to use MCPJam provided models";

/**
 * Unauthenticated users keep BYOK/custom models but premium MCPJam-provided
 * models are shown locked rather than hidden.
 */
export function applyGuestModelLocks(
  models: ModelDefinition[],
  isAuthenticated: boolean
): ModelDefinition[] {
  if (isAuthenticated) return models;

  return models.map((model) => {
    const modelId = String(model.id);
    // Prefer the catalog-sourced `guestAllowed` flag; fall back to the static
    // guest allow-list for models without it. Unknown → guest-gated (locked).
    const guestAllowed = model.guestAllowed ?? isMCPJamGuestAllowedModel(modelId);
    if (!isMCPJamProvidedModelMenuItem(model) || guestAllowed) {
      return model;
    }

    return {
      ...model,
      disabled: true,
      disabledReason: GUEST_LOCKED_MODEL_REASON,
    };
  });
}

export const OUT_OF_CREDITS_MODEL_REASON =
  "You're out of credits. Upgrade, buy credits, or use your own key.";

/**
 * Once the org/guest is out of MCPJam credits, MCPJam-provided ("free")
 * models can't run — show them locked (grayed + tooltip) instead of letting
 * the user pick one and only discover the limit on send. BYOK/custom and
 * org-configured provider models stay enabled (that's the way out). Mirrors
 * applyGuestModelLocks.
 */
export function applyOutOfCreditsLocks(
  models: ModelDefinition[],
  outOfCredits: boolean
): ModelDefinition[] {
  if (!outOfCredits) return models;

  return models.map((model) => {
    if (!isMCPJamProvidedModelMenuItem(model)) {
      return model;
    }
    return {
      ...model,
      disabled: true,
      disabledReason: OUT_OF_CREDITS_MODEL_REASON,
    };
  });
}

/**
 * Append locally-detected Ollama models that the base list doesn't already
 * contain (e.g. org-managed lists never include the user's local daemon).
 */
export function appendDetectedLocalOllamaModels(
  models: ModelDefinition[],
  isOllamaRunning: boolean,
  ollamaModels: ModelDefinition[]
): ModelDefinition[] {
  if (!isOllamaRunning || ollamaModels.length === 0) return models;
  return models.concat(
    ollamaModels.filter(
      (ollamaModel) =>
        !models.some((model) => String(model.id) === String(ollamaModel.id))
    )
  );
}

/**
 * Every picker surface treats the model list as non-empty: `getDefaultModel`
 * ends in `availableModels[0]`, so an empty list hands the chat an `undefined`
 * `selectedModel`, which the surfaces then read unguarded — `isOrgManagedModel`
 * in useChatSession, `currentModel.disabled` in ModelSelector. That is
 * INSPECTOR-CLIENT-222: a blank Playground behind a route error screen.
 *
 * `useHostedModelCatalog` already promises a non-empty hosted source; this is
 * the floor for every other way the composition can still come out empty
 * (a caller passing an empty `hostedCatalog`, a future filter). Applied BEFORE
 * the guest/credit locks so floor models carry the same locks as any other
 * hosted row.
 */
function withHostedFloor(models: ModelDefinition[]): ModelDefinition[] {
  return models.length > 0 ? models : hostedModelDefinitionsFromSnapshot();
}

/**
 * The one model-list pipeline shared by every picker surface (Playground
 * chat, eval suite/judge editors, client builder Agent tab): org-managed
 * provider config when present, otherwise local BYOK keys (filtered to
 * MCPJam-provided models in hosted mode), plus locally-detected Ollama and
 * guest locks. Surfaces must not fork this composition — divergence here is
 * what previously left org-only providers (Bedrock, custom) out of pickers.
 */
export function composeAvailableModels(params: {
  orgConfig: OrgVisibleConfig | undefined;
  isAuthenticated: boolean;
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
  hasToken: (provider: keyof ProviderTokens) => boolean;
  getOpenRouterSelectedModels: () => string[];
  getAzureBaseUrl: () => string;
  customProviders: CustomProvider[];
  /** Lock MCPJam-provided ("free") models when the org/guest has 0 credits. */
  outOfCredits?: boolean;
  /**
   * The hosted ("free") model source from the backend catalog. When omitted,
   * composition falls back to the static `SUPPORTED_MODELS` hosted subset —
   * so this stays a drop-in for any caller that hasn't wired the catalog yet.
   */
  hostedCatalog?: ModelDefinition[];
}): ModelDefinition[] {
  const {
    orgConfig,
    isAuthenticated,
    isOllamaRunning,
    ollamaModels,
    hasToken,
    getOpenRouterSelectedModels,
    getAzureBaseUrl,
    customProviders,
    outOfCredits = false,
    hostedCatalog,
  } = params;

  if ((orgConfig?.providers.length ?? 0) > 0) {
    const orgModels = buildAvailableModelsFromOrgConfig(orgConfig, hostedCatalog);
    const orgModelsWithLocalOllama = appendDetectedLocalOllamaModels(
      orgModels,
      isOllamaRunning,
      ollamaModels
    );
    return applyOutOfCreditsLocks(
      applyGuestModelLocks(
        withHostedFloor(orgModelsWithLocalOllama),
        isAuthenticated
      ),
      outOfCredits
    );
  }

  const localModels = buildAvailableModels({
    hasToken,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    getAzureBaseUrl,
    customProviders,
    hostedCatalog,
  });
  const visibleModels = HOSTED_MODE
    ? localModels.filter((model) => isMCPJamProvidedModelMenuItem(model))
    : localModels;
  const guestLockedModels = applyGuestModelLocks(
    withHostedFloor(visibleModels),
    isAuthenticated
  );
  return applyOutOfCreditsLocks(guestLockedModels, outOfCredits);
}
