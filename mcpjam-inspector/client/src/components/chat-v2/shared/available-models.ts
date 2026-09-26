import type { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import {
  hostedModelDefinitionsFromSnapshot,
  isMCPJamGuestAllowedModel,
  modelObservationStatus,
  type ModelDefinition,
  type ModelObservationKey,
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
  "Sign in to use this frontier model";

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
  "Out of MCPJam credits. View your organization's credit options or wait for your allowance to renew.";

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

export const FREE_TIER_MODEL_REASON =
  "Not included in the free daily allowance. Upgrade your plan, add credits, or use your own API key to use this model.";

/**
 * On the free daily allowance with no credits to fall back on, the backend
 * refuses models priced above the free bucket (`free_tier_model_restricted`).
 * Lock those rows up front instead of letting the pick fail on send. Only an
 * explicit `freeTierEligible: false` from the catalog locks: a row without the
 * field (older backend, cached catalog, BYOK) keeps today's behavior. BYOK and
 * org-provider rows never lock; they are one way out. Rows already locked
 * (guest lock) keep their reason. Sits beside applyOutOfCreditsLocks, which
 * still wins when both apply.
 */
export function applyFreeTierLocks(
  models: ModelDefinition[],
  freeTierOnly: boolean
): ModelDefinition[] {
  if (!freeTierOnly) return models;

  return models.map((model) => {
    if (
      model.disabled ||
      model.freeTierEligible !== false ||
      !isMCPJamProvidedModelMenuItem(model)
    ) {
      return model;
    }
    return {
      ...model,
      disabled: true,
      disabledReason: FREE_TIER_MODEL_REASON,
    };
  });
}

/**
 * What a picker surface runs its model for. The workload decides which
 * catalog-observed capabilities a row needs and what an unverified one means:
 *
 * - `chat`: Playground chat with no MCP servers attached. Needs nothing.
 * - `mcpChat`: chat with servers attached. Needs tools; unverified is allowed
 *   with a warning.
 * - `host`: a host config's model (harness or emulated), which drives MCP
 *   tools. Needs tools; unverified is allowed with a warning, since a host is
 *   also run in chat and evals gate on their own picker.
 * - `evalTarget` / `persona`: eval and journey runs. Need tools; unverified is
 *   disabled, because a run that cannot call tools is not a valid result.
 */
export type ModelWorkload = "chat" | "mcpChat" | "host" | "evalTarget" | "persona";

export interface ModelWorkloadPolicy {
  requiredCapabilities: ModelObservationKey[];
  /** What an `unknown` observation does to a row on this surface. */
  unverified: "disable" | "warn";
}

export const MODEL_WORKLOAD_POLICIES: Record<ModelWorkload, ModelWorkloadPolicy> =
  {
    chat: { requiredCapabilities: [], unverified: "warn" },
    mcpChat: { requiredCapabilities: ["tools"], unverified: "warn" },
    host: { requiredCapabilities: ["tools"], unverified: "warn" },
    evalTarget: { requiredCapabilities: ["tools"], unverified: "disable" },
    persona: { requiredCapabilities: ["tools"], unverified: "disable" },
  };

const CAPABILITY_LABELS: Record<ModelObservationKey, string> = {
  tools: "tool calling",
  vision: "image input",
  temperature: "temperature",
  openRouterZdr: "zero data retention",
  gatewayZdr: "zero data retention",
  gatewayNoTraining: "no-training data policy",
};

export const NOT_VERIFIED_TAG = "Not verified";

export function unsupportedCapabilityReason(
  capability: ModelObservationKey
): string {
  return `This model does not support ${CAPABILITY_LABELS[capability]}, which this workload needs.`;
}

export function unverifiedCapabilityReason(
  capability: ModelObservationKey,
  unverified: ModelWorkloadPolicy["unverified"]
): string {
  const label = CAPABILITY_LABELS[capability];
  return unverified === "disable"
    ? `Support for ${label} is not verified for this model, so it can't be used here.`
    : `Support for ${label} is not verified for this model. Runs that need it may fail.`;
}

/**
 * Apply a surface's capability needs to its picker rows. Models are never
 * hidden: a row whose catalog observed a required capability as unsupported
 * is disabled with the reason, and one observed as unknown is tagged
 * "Not verified" (disabled or warned per {@link MODEL_WORKLOAD_POLICIES}).
 *
 * A row with no `catalogObservedAt` carries no observations to act on (a
 * backend that predates them, a cached catalog, a BYOK/org/local row). It is
 * left exactly as it was, so nothing selectable today becomes unselectable
 * before the backend reports observations. Rows already disabled keep their
 * reason.
 */
export function applyWorkloadCapabilityLocks(
  models: ModelDefinition[],
  workload: ModelWorkload | ModelWorkloadPolicy | undefined
): ModelDefinition[] {
  if (!workload) return models;
  const policy =
    typeof workload === "string" ? MODEL_WORKLOAD_POLICIES[workload] : workload;
  if (policy.requiredCapabilities.length === 0) return models;

  return models.map((model) => {
    if (model.catalogObservedAt === undefined) return model;

    const unsupported = policy.requiredCapabilities.find(
      (capability) => modelObservationStatus(model, capability) === "unsupported"
    );
    if (unsupported) {
      if (model.disabled) return model;
      return {
        ...model,
        disabled: true,
        disabledReason: unsupportedCapabilityReason(unsupported),
      };
    }

    const unverified = policy.requiredCapabilities.filter(
      (capability) => modelObservationStatus(model, capability) === "unknown"
    );
    if (unverified.length === 0) return model;

    const reason = unverifiedCapabilityReason(unverified[0]!, policy.unverified);
    if (policy.unverified === "disable") {
      return {
        ...model,
        unverifiedCapabilities: unverified,
        ...(model.disabled ? {} : { disabled: true, disabledReason: reason }),
      };
    }
    return { ...model, unverifiedCapabilities: unverified, warningReason: reason };
  });
}

/**
 * Newest first by `releasedAt`; rows without one keep their incoming order
 * after every dated row. Stable, so a catalog with no release dates (older
 * backend, BYOK) renders in exactly the order it arrived.
 */
export function sortModelsNewestFirst(
  models: ModelDefinition[]
): ModelDefinition[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const a = left.model.releasedAt;
      const b = right.model.releasedAt;
      if (a !== undefined && b !== undefined && a !== b) return b - a;
      if (a === undefined && b !== undefined) return 1;
      if (a !== undefined && b === undefined) return -1;
      return left.index - right.index;
    })
    .map(({ model }) => model);
}

const RETIRING_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Retiring Mar 3, 2027" for a row with a provider retirement date. */
export function retiringTag(model: ModelDefinition): string | undefined {
  if (model.deprecatedAt === undefined) return undefined;
  const date = new Date(model.deprecatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return `Retiring ${RETIRING_DATE_FORMAT.format(date)}`;
}

/**
 * "Catalog updated Sep 21, 2026": when the hosted catalog these rows came
 * from was last observed, for the picker footer. Takes the newest
 * `catalogObservedAt` across the rows (each row carries the time of the sync
 * that last saw it). Undefined when no row carries one, as with the offline
 * snapshot, so the footer shows nothing rather than a guess. Never an error:
 * an old date is information, not a failure.
 */
export function catalogFreshnessLabel(
  models: readonly ModelDefinition[]
): string | undefined {
  let newest: number | undefined;
  for (const model of models) {
    const observedAt = model.catalogObservedAt;
    if (observedAt === undefined || !Number.isFinite(observedAt)) continue;
    if (newest === undefined || observedAt > newest) newest = observedAt;
  }
  if (newest === undefined) return undefined;
  return `Catalog updated ${RETIRING_DATE_FORMAT.format(new Date(newest))}`;
}

export const JUDGE_INELIGIBLE_TAG = "Not eligible";

export const JUDGE_INELIGIBLE_REASON =
  "Not eligible as a judge. Judges run on MCPJam models with verified zero data retention. Pick another model to change it.";

/**
 * Whether a picker row can be offered as an eval judge: an MCPJam-hosted row
 * the catalog admits as a judge (`judge_eligible`, else an OpenRouter zero
 * data retention observation of `supported`; the backend refuses `unknown`).
 * Judges never run on BYOK, org or local keys.
 *
 * A row with no `catalogObservedAt` comes from a catalog that carries no
 * observations yet (an older backend, a cached catalog): it stays offered, as
 * it was before observations existed. Only a catalog that reports
 * observations can take a hosted row out of the judge list.
 */
export function isJudgeEligibleModel(model: ModelDefinition): boolean {
  if (!isMCPJamProvidedModelMenuItem(model)) return false;
  if (model.catalogObservedAt === undefined) return true;
  if (model.judgeEligible !== undefined) return model.judgeEligible;
  return modelObservationStatus(model, "openRouterZdr") === "supported";
}

function syntheticModelRow(modelId: string): ModelDefinition {
  const slash = modelId.indexOf("/");
  return {
    id: modelId,
    name: modelId,
    provider: (slash > 0
      ? modelId.slice(0, slash)
      : "unknown") as ModelDefinition["provider"],
  };
}

/**
 * The rows a judge picker offers (`purpose: "judge"`): judge-eligible hosted
 * rows, one per id, plus
 *  - the managed default, always selectable (picking it clears the override),
 *    even before the catalog loads;
 *  - the current value when it is not an eligible row (a BYOK id saved before
 *    judges were hosted-only, a model the catalog no longer admits), appended
 *    disabled with {@link JUDGE_INELIGIBLE_REASON} so the saved choice stays
 *    visible without being offered again. `currentIneligible` says so.
 */
export function judgeModelOptions(
  models: readonly ModelDefinition[],
  args: { currentModelId: string; managedDefaultModelId: string }
): { models: ModelDefinition[]; currentIneligible: boolean } {
  const rows: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = String(model.id);
    if (!id || seen.has(id) || !isJudgeEligibleModel(model)) continue;
    seen.add(id);
    rows.push(model);
  }
  const { currentModelId, managedDefaultModelId } = args;
  if (!seen.has(managedDefaultModelId)) {
    const listed = models.find(
      (model) =>
        String(model.id) === managedDefaultModelId &&
        isMCPJamProvidedModelMenuItem(model)
    );
    const row = listed ?? syntheticModelRow(managedDefaultModelId);
    rows.push({
      ...row,
      hosted: true,
      disabled: false,
      disabledReason: undefined,
    });
    seen.add(managedDefaultModelId);
  }
  if (!currentModelId || seen.has(currentModelId)) {
    return { models: rows, currentIneligible: false };
  }
  const listed =
    models.find(
      (model) =>
        String(model.id) === currentModelId &&
        isMCPJamProvidedModelMenuItem(model)
    ) ?? models.find((model) => String(model.id) === currentModelId);
  rows.push({
    ...(listed ?? syntheticModelRow(currentModelId)),
    disabled: true,
    disabledReason: JUDGE_INELIGIBLE_REASON,
  });
  return { models: rows, currentIneligible: true };
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
    ollamaModels
      .filter(
        (ollamaModel) =>
          !models.some((model) => String(model.id) === String(ollamaModel.id))
      )
      .map((model) => ({ ...model, hosted: false }))
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
   * The subject spends only the free daily allowance (no credits to fall back
   * on): lock hosted rows the catalog marks `freeTierEligible: false`.
   */
  freeTierOnly?: boolean;
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
    freeTierOnly = false,
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
      applyFreeTierLocks(
        applyGuestModelLocks(
          withHostedFloor(orgModelsWithLocalOllama),
          isAuthenticated
        ),
        freeTierOnly
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
  return applyOutOfCreditsLocks(
    applyFreeTierLocks(guestLockedModels, freeTierOnly),
    outOfCredits
  );
}
