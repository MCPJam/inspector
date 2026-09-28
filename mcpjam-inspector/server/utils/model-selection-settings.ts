/**
 * Effective sampling settings for one run of a saved model selection.
 *
 * A saved selection can carry `settings` (`temperature`, `reasoningEffort`).
 * Before this module the runner resolved temperature from the host config and
 * the case's `advancedConfig` only, so a saved local selection with
 * `temperature: 0.2` ran with whatever the host said (or none). The settings
 * are now resolved ONCE per run, here, and that one result is what the
 * provider call receives and what the execution record says it received.
 *
 * PRECEDENCE, per setting, highest first:
 *
 *   1. per-run override  (the eval case's `advancedConfig`)
 *   2. saved selection   (`selection.settings`)
 *   3. host defaults     (the host config's `temperature`)
 *
 * A setting that cannot be honoured on the route the run takes is REFUSED
 * (`capability_missing`), never dropped: running a different configuration
 * than the one saved and calling it the saved one is the failure this exists
 * to prevent. The one value that is dropped rather than refused is a host
 * DEFAULT temperature under a reasoning effort, because a default is not a
 * request (the backend's `/stream` drops it the same way).
 *
 * Which route honours what:
 *
 *  - `direct`: the inspector calls the provider itself (a `local` selection,
 *    or an org connection on the local runtime). Temperature goes on the
 *    call; a reasoning effort becomes provider options for the providers the
 *    AI SDK exposes one for ({@link reasoningEffortProviderOptions}).
 *  - `hosted`: backend `/stream`. The selection rides the request as
 *    `modelSelection` and the backend applies its settings; the runner sends
 *    the effective temperature as the top-level field, which the backend
 *    prefers over the selection's, so the two can never disagree.
 *  - `orgCloud`: backend `/stream/org`. Applies the selection's temperature
 *    (top-level first, as on `/stream`) but not a reasoning effort, so an
 *    effort is refused on this route.
 *  - `org`: an org selection before its runtime is known (the org config
 *    decides cloud vs local at call time). Temperature is resolved now; the
 *    effort is checked on the concrete rail by the caller that learns it.
 */
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelReasoningEffort, ModelSelection } from "@mcpjam/sdk";
import {
  modelDefinitionSupportsTemperature,
  type ModelDefinition,
} from "@/shared/types";
import type { ModelRefusal } from "./model-resolution-local.js";

export type ModelSettingsRoute = "direct" | "hosted" | "orgCloud" | "org";

export type EffectiveModelSettings = {
  temperature?: number;
  reasoningEffort?: ModelReasoningEffort;
};

export type ModelSettingSource = "override" | "selection" | "host";

/** Provider options for a direct AI SDK call (`streamText({ providerOptions })`). */
export type DirectProviderOptions = ProviderOptions;

export type EffectiveModelSettingsResult =
  | {
      ok: true;
      settings: EffectiveModelSettings;
      /** Where each effective value came from. */
      sources: {
        temperature?: ModelSettingSource;
        reasoningEffort?: ModelSettingSource;
      };
      /** `direct` route with an effort only. */
      providerOptions?: DirectProviderOptions;
    }
  | { ok: false; refusal: ModelRefusal };

export type ResolveEffectiveModelSettingsInput = {
  route: ModelSettingsRoute;
  /** The model the call runs (its provider and temperature support). */
  modelDefinition: Pick<ModelDefinition, "id" | "provider"> &
    Partial<ModelDefinition>;
  /** Precedence 1: this run's own settings (eval `advancedConfig`). */
  override?: { temperature?: number; reasoningEffort?: ModelReasoningEffort };
  /** Precedence 2: the saved selection. */
  selection?: Pick<ModelSelection, "modelId" | "settings">;
  /** Precedence 3: host defaults. */
  host?: { temperature?: number };
};

function pick<T>(
  candidates: Array<[ModelSettingSource, T | undefined]>,
): { value: T; source: ModelSettingSource } | undefined {
  for (const [source, value] of candidates) {
    if (value !== undefined) return { value, source };
  }
  return undefined;
}

function refuse(
  reason: string,
  evidence: Record<string, unknown>,
): EffectiveModelSettingsResult {
  return {
    ok: false,
    refusal: { code: "capability_missing", reason, evidence },
  };
}

/**
 * Resolve the settings a run executes with (see the module doc for the
 * precedence and the per-route rules). Pure.
 */
export function resolveEffectiveModelSettings(
  input: ResolveEffectiveModelSettingsInput,
): EffectiveModelSettingsResult {
  const { route, modelDefinition } = input;
  const modelId = input.selection?.modelId ?? String(modelDefinition.id);
  const temperature = pick<number>([
    ["override", input.override?.temperature],
    ["selection", input.selection?.settings?.temperature],
    ["host", input.host?.temperature],
  ]);
  const effort = pick<ModelReasoningEffort>([
    ["override", input.override?.reasoningEffort],
    ["selection", input.selection?.settings?.reasoningEffort],
  ]);

  const settings: EffectiveModelSettings = {};
  const sources: {
    temperature?: ModelSettingSource;
    reasoningEffort?: ModelSettingSource;
  } = {};
  let providerOptions: DirectProviderOptions | undefined;

  if (effort) {
    if (route === "orgCloud") {
      return refuse(
        `reasoning effort "${effort.value}" cannot be applied on an organization cloud connection; remove it from the saved model or run the connection on the local runtime`,
        { setting: "reasoningEffort", route, modelId },
      );
    }
    if (route === "direct") {
      const options = reasoningEffortProviderOptions({
        providerKey: String(modelDefinition.provider),
        modelId,
        effort: effort.value,
      });
      if (!options) {
        return refuse(
          `reasoning effort "${effort.value}" is not supported for ${modelId} on the ${String(modelDefinition.provider)} provider`,
          {
            setting: "reasoningEffort",
            route,
            modelId,
            providerKey: String(modelDefinition.provider),
          },
        );
      }
      providerOptions = options;
    }
    settings.reasoningEffort = effort.value;
    sources.reasoningEffort = effort.source;
  }

  if (temperature) {
    if (effort) {
      // An effort and a temperature are not sent together (reasoning
      // providers reject or ignore sampling temperature). A host default
      // yields; an explicit temperature is a request that cannot be honoured.
      if (temperature.source !== "host") {
        return refuse(
          `a temperature (${temperature.value}) and a reasoning effort ("${effort.value}") cannot both be applied to ${modelId}; keep one`,
          {
            setting: "temperature",
            route,
            modelId,
            temperatureSource: temperature.source,
          },
        );
      }
    } else if (
      !modelDefinitionSupportsTemperature(modelDefinition as ModelDefinition)
    ) {
      if (temperature.source === "selection") {
        return refuse(
          `${modelId} does not accept a temperature, so the saved temperature (${temperature.value}) cannot be applied`,
          { setting: "temperature", route, modelId },
        );
      }
      // Override / host defaults: unchanged behaviour, the provider default
      // applies (the chat pipeline omits the field for such models).
    } else {
      settings.temperature = temperature.value;
      sources.temperature = temperature.source;
    }
  }

  return {
    ok: true,
    settings,
    sources,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

// ── Reasoning effort on a direct provider call ─────────────────────────────

const OPENAI_EFFORTS: readonly ModelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const ANTHROPIC_EFFORTS: readonly ModelReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const GOOGLE_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/** The model name without a `provider/` prefix. */
function bareModelName(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/**
 * The provider options that apply `effort` on a direct AI SDK call, or
 * `undefined` when this provider/model has no effort control the installed
 * AI SDK provider exposes (the caller refuses the setting then). Levels are
 * the AI SDK provider's own enums; the model families are the ones whose
 * effort control the provider documents (OpenAI reasoning models, Claude,
 * Gemini 3+). The same mapping the backend uses for `/stream`.
 */
export function reasoningEffortProviderOptions(args: {
  providerKey: string;
  modelId: string;
  effort: ModelReasoningEffort;
}): DirectProviderOptions | undefined {
  const name = bareModelName(args.modelId);
  switch (args.providerKey) {
    case "openai":
      return /^(gpt-5|o[1-9])(?:[.-]|$)/.test(name) &&
        OPENAI_EFFORTS.includes(args.effort)
        ? { openai: { reasoningEffort: args.effort } }
        : undefined;
    case "anthropic":
      return /^claude-/.test(name) && ANTHROPIC_EFFORTS.includes(args.effort)
        ? {
            anthropic: {
              effort: args.effort,
              ...(/^claude-opus-4[.-]5(?:-|$)/.test(name)
                ? {}
                : { thinking: { type: "adaptive" } }),
            },
          }
        : undefined;
    case "google":
      return /^gemini-([3-9]|[1-9][0-9])(?:[.-]|$)/.test(name) &&
        GOOGLE_EFFORTS.includes(args.effort)
        ? { google: { thinkingConfig: { thinkingLevel: args.effort } } }
        : undefined;
    default:
      return undefined;
  }
}
