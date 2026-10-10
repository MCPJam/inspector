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
  AI_SCOPE_UNRESOLVED_REASON,
  ORG_KEYS_MODEL_REASON,
  ORG_POLICY_LOADING_REASON,
} from "@/lib/org-keys-refusal";
import {
  buildAvailableModels,
  buildAvailableModelsFromOrgConfig,
  compactModelLabel,
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "./model-helpers";
import { orgKeysRequired } from "./org-ai-policy";
import {
  findModelForStoredChoice,
  modelRowKey,
} from "./model-selection";
import type { ModelSelection } from "@mcpjam/sdk/browser";

export {
  AI_SCOPE_UNRESOLVED_REASON,
  ORG_KEYS_MODEL_REASON,
  ORG_POLICY_LOADING_REASON,
};

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

export const FREE_TIER_MODEL_REASON = "Sign in to use this model";

/**
 * For a guest on the free daily allowance, the backend refuses models priced
 * above the free bucket (`free_tier_model_restricted`).
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
  "Not eligible as a judge. Judges run on MCPJam models with verified zero data retention, or on an organization provider. Pick another model to change it.";

/**
 * Whether a picker row can be offered as an eval judge:
 *  - an ORG row (the BYOK judge) whose connection the backend runs AI
 *    requests on directly — `buildAvailableModelsFromOrgConfig` stamps those
 *    `judgeEligible: true`; a local-runtime or shared-gateway connection's
 *    rows never are;
 *  - an MCPJam-hosted row the catalog admits as a judge (`judge_eligible`,
 *    else an OpenRouter zero data retention observation of `supported`; the
 *    backend refuses `unknown`).
 * Personal (local) keys never run a judge.
 *
 * A hosted row with no `catalogObservedAt` comes from a catalog that carries
 * no observations yet (an older backend, a cached catalog): it stays offered,
 * as it was before observations existed. Only a catalog that reports
 * observations can take a hosted row out of the judge list.
 */
export function isJudgeEligibleModel(model: ModelDefinition): boolean {
  if (model.orgProvider && !isMCPJamProvidedModelMenuItem(model)) {
    return model.judgeEligible === true;
  }
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
 * The row a saved model id names when the rows on offer may not list it:
 * `pool`'s (hosted first), else the hosted catalog's, so a trigger keeps the
 * model's display name; a synthetic row carrying the id only when neither
 * lists it.
 */
export function savedModelRow(
  modelId: string,
  pool: readonly ModelDefinition[] = [],
): ModelDefinition {
  return (
    pool.find(
      (model) =>
        String(model.id) === modelId && isMCPJamProvidedModelMenuItem(model),
    ) ??
    pool.find((model) => String(model.id) === modelId) ??
    hostedModelDefinitionsFromSnapshot().find(
      (model) => String(model.id) === modelId,
    ) ??
    syntheticModelRow(modelId)
  );
}

/**
 * A saved model the organization's AI key policy no longer allows (a hosted
 * or personal-key model saved before the organization required its own
 * keys). Pickers never list it: it shows only on the trigger, as
 * {@link orgKeysDisallowedNotice}, so the saved choice is never silently
 * switched to another model.
 */
export function orgKeysDisallowedRow(row: ModelDefinition): ModelDefinition {
  const { warningReason: _warning, ...rest } = row;
  return { ...rest, disabled: true, disabledReason: ORG_KEYS_MODEL_REASON };
}

/** Whether `model` is a {@link orgKeysDisallowedRow}. */
export function isOrgKeysDisallowedRow(
  model: ModelDefinition | null | undefined,
): boolean {
  return (
    !!model &&
    String(model.id) !== "" &&
    model.disabled === true &&
    model.disabledReason === ORG_KEYS_MODEL_REASON
  );
}

/** "Claude Haiku 4.5 isn't allowed here. Choose an organization model." */
export function orgKeysDisallowedNotice(model: ModelDefinition): string {
  const name = compactModelLabel(model.name) || String(model.id);
  return `${name} isn't allowed here. Choose an organization model.`;
}

/**
 * The rows a judge picker offers (`purpose: "judge"`): judge-eligible rows
 * ({@link isJudgeEligibleModel}), one per row identity, plus
 *  - the managed default, always selectable (picking it clears the override),
 *    even before the catalog loads;
 *  - the current value when it is not an eligible row (a personal-key id
 *    saved before org judges existed, a model the catalog no longer admits),
 *    appended disabled so the saved choice stays visible without being
 *    offered again. `currentIneligible` says so.
 *
 * While the organization requires its own keys (`requireOrgKeys`), only org
 * rows are offered and there is no managed default: a judge must be chosen
 * from an organization provider, so an unset judge (or the managed default's
 * id) resolves to no `current`. A saved judge the policy no longer allows is
 * `current` as an {@link orgKeysDisallowedRow} and is not listed: it shows
 * only on the trigger.
 *
 * `current` is the row the current value resolves to (by its saved selection
 * when given, so an org judge stored under its canonical id finds its bare-id
 * row).
 */
export function judgeModelOptions(
  models: readonly ModelDefinition[],
  args: {
    currentModelId: string;
    managedDefaultModelId: string;
    /** The selection saved beside `currentModelId`, when there is one. */
    currentSelection?: ModelSelection | null;
    /** The organization requires its own provider keys for AI features. */
    requireOrgKeys?: boolean;
  },
): {
  models: ModelDefinition[];
  currentIneligible: boolean;
  current?: ModelDefinition;
} {
  const requireOrgKeys = args.requireOrgKeys === true;
  const rows: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = String(model.id);
    if (!id) continue;
    const key = modelRowKey(model);
    if (seen.has(key)) continue;
    const eligible = requireOrgKeys
      ? !isMCPJamProvidedModelMenuItem(model) &&
        !!model.orgProvider &&
        model.judgeEligible === true
      : isJudgeEligibleModel(model);
    if (!eligible) continue;
    seen.add(key);
    rows.push(model);
  }
  const { currentModelId, managedDefaultModelId } = args;
  if (
    !requireOrgKeys &&
    !rows.some((row) => String(row.id) === managedDefaultModelId)
  ) {
    const listed = models.find(
      (model) =>
        String(model.id) === managedDefaultModelId &&
        isMCPJamProvidedModelMenuItem(model),
    );
    const row = listed ?? syntheticModelRow(managedDefaultModelId);
    rows.push({
      ...row,
      hosted: true,
      disabled: false,
      disabledReason: undefined,
    });
  }
  // Under the policy the managed default's id names no judge (unless an org
  // selection saved under the same canonical id says otherwise).
  if (
    !currentModelId ||
    (requireOrgKeys &&
      currentModelId === managedDefaultModelId &&
      args.currentSelection?.source !== "org")
  ) {
    return { models: rows, currentIneligible: false };
  }
  const current = args.currentSelection
    ? findModelForStoredChoice(
        { modelId: currentModelId, selection: args.currentSelection },
        rows,
        undefined,
      )
    : (rows.find(
        (row) =>
          String(row.id) === currentModelId &&
          isMCPJamProvidedModelMenuItem(row),
      ) ?? rows.find((row) => String(row.id) === currentModelId));
  if (current) {
    return { models: rows, currentIneligible: false, current };
  }
  const saved = savedModelRow(currentModelId, models);
  if (requireOrgKeys) {
    return {
      models: rows,
      currentIneligible: true,
      current: orgKeysDisallowedRow(saved),
    };
  }
  const ineligible: ModelDefinition = {
    ...saved,
    disabled: true,
    disabledReason: JUDGE_INELIGIBLE_REASON,
  };
  rows.push(ineligible);
  return { models: rows, currentIneligible: true, current: ineligible };
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

type ComposeAvailableModelsParams = {
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
   * A guest spending the free daily allowance: lock hosted rows the catalog
   * marks `freeTierEligible: false`.
   */
  freeTierOnly?: boolean;
  /**
   * The hosted ("free") model source from the backend catalog. When omitted,
   * composition falls back to the static `SUPPORTED_MODELS` hosted subset —
   * so this stays a drop-in for any caller that hasn't wired the catalog yet.
   */
  hostedCatalog?: ModelDefinition[];
  /**
   * Model ids the surface has SAVED (the chat's lead and compare picks). When
   * the organization's policy no longer offers one, it is kept in the list as
   * an {@link orgKeysDisallowedRow} instead of vanishing — so a surface never
   * silently switches a saved choice to another model. Pickers show it only
   * on the trigger, never as a row.
   */
  savedModelIds?: readonly (string | null | undefined)[];
};

function lockEveryRow(
  models: ModelDefinition[],
  reason: string,
): ModelDefinition[] {
  return models.map((model) => ({
    ...model,
    disabled: true,
    disabledReason: reason,
  }));
}

/**
 * Keep each saved id the offered list no longer contains, as an
 * {@link orgKeysDisallowedRow}. The row is the one the unrestricted list has
 * for that id (hosted first), else the hosted catalog's, else a synthetic
 * one; `unrestricted` is computed only when a saved id is actually missing.
 */
export function withSavedSelectionLocks(
  offered: ModelDefinition[],
  savedModelIds: readonly (string | null | undefined)[] | undefined,
  unrestricted: () => readonly ModelDefinition[],
): ModelDefinition[] {
  const missing = [
    ...new Set(
      (savedModelIds ?? [])
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  ].filter((id) => !offered.some((model) => String(model.id) === id));
  if (missing.length === 0) return offered;
  const pool = unrestricted();
  return [
    ...offered,
    ...missing.map((id) => orgKeysDisallowedRow(savedModelRow(id, pool))),
  ];
}

/**
 * The one model-list pipeline shared by every picker surface (Playground
 * chat, eval suite/judge editors, client builder Agent tab): org-managed
 * provider config when present, otherwise local BYOK keys (filtered to
 * MCPJam-provided models in hosted mode), plus locally-detected Ollama and
 * guest locks. Surfaces must not fork this composition — divergence here is
 * what previously left org-only providers (Bedrock, custom) out of pickers.
 *
 * The organization's AI key policy narrows it:
 *  - while the org requires its own keys (`aiKeyPolicy.requireOrgKeys`), only
 *    rows from its eligible connections are offered — no hosted rows (and no
 *    hosted floor), no personal keys, no locally detected Ollama, no
 *    OpenRouter or local-runtime org connection. The list may be EMPTY; the
 *    picker then offers "Add a provider" / "Ask an organization admin";
 *  - while the config is loading (`pending`) every row is locked, so nothing
 *    hosted becomes a usable default before the policy is known;
 *  - a project no organization owns (`unresolved`) locks every row.
 */
export function composeAvailableModels(
  params: ComposeAvailableModelsParams,
): ModelDefinition[] {
  const { orgConfig, hostedCatalog, savedModelIds } = params;

  if (orgConfig?.pending) {
    return lockEveryRow(
      composeUnrestrictedModels(params),
      ORG_POLICY_LOADING_REASON,
    );
  }

  if (orgKeysRequired(orgConfig)) {
    // Eligible org connections only; `buildAvailableModelsFromOrgConfig`
    // applies the policy. Guest / credit locks only ever touch hosted rows,
    // and there are none.
    const orgModels = buildAvailableModelsFromOrgConfig(
      orgConfig,
      hostedCatalog,
    );
    return withSavedSelectionLocks(orgModels, savedModelIds, () =>
      composeUnrestrictedModels({
        ...params,
        // The same config with the policy lifted: only used to find the row
        // a saved id named, never offered.
        orgConfig: orgConfig
          ? {
              providers: orgConfig.providers,
              ...(orgConfig.aiReadiness
                ? {
                    aiReadiness: {
                      ...orgConfig.aiReadiness,
                      requireOrgKeys: false,
                    },
                  }
                : {}),
            }
          : undefined,
      }),
    );
  }

  if (orgConfig?.unresolved) {
    return lockEveryRow(
      composeUnrestrictedModels(params),
      AI_SCOPE_UNRESOLVED_REASON,
    );
  }

  return composeUnrestrictedModels(params);
}

/** Today's composition, with no organization AI key policy in force. */
function composeUnrestrictedModels(
  params: ComposeAvailableModelsParams,
): ModelDefinition[] {
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
    const orgModels = buildAvailableModelsFromOrgConfig(
      orgConfig,
      hostedCatalog,
    );
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
