/**
 * Reasoning effort — what a model can be asked to do, and how a saved
 * selection is compared.
 *
 * ONE table for every surface that is not the hosted catalog. The hosted
 * route reads the backend's `supportedReasoningEfforts` (the catalog owns
 * those); BYOK / org / local rows and harnesses read the tables here, so the
 * UI, the API and the runner cannot disagree about what to offer. An unknown
 * model or harness has NO efforts: the control is hidden, never guessed.
 *
 * Levels per provider are the AI SDK provider's own enums. OpenAI's `max` is
 * accepted by the backend / Gateway only, so it is absent from the direct
 * table (the installed OpenAI provider package does not send it).
 *
 * Pure + browser-safe: no Node-only APIs, no external imports beyond types.
 */

import type { Harness } from "./types.js";
import {
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
  type ModelSelection,
} from "./model-selection.js";

// ── Level tables ─────────────────────────────────────────────────────────

export const OPENAI_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const ANTHROPIC_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const GOOGLE_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * Efforts each harness adapter is VERIFIED to apply, per adapter. Evidence,
 * like `shared/harness-model-support-evidence.json`: empty until an adapter's
 * mapping is verified, so a saved effort on a harness host is refused rather
 * than dropped. Extend a row only with a verified mapping.
 */
export const HARNESS_REASONING_EFFORTS: Readonly<
  Record<Harness, readonly ModelReasoningEffort[]>
> = {
  "claude-code": [],
  codex: [],
  cursor: [],
};

// ── Capability ───────────────────────────────────────────────────────────

/** Where a call runs, which decides who owns the capability. */
export type ReasoningEffortRoute = "direct" | "hosted" | "orgCloud" | "org";

/** The model name without a `provider/` prefix. */
function bareModelName(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/**
 * OpenAI levels are model-specific (the provider package documents that
 * `none` is GPT-5.1+ only and `xhigh` GPT-5.2+/Codex-Max only, and a wrong
 * level is an API error). Families this does not know return none: the
 * control is hidden rather than guessed. `-pro` models are hidden the same
 * way (their accepted levels are narrower and not documented by the package).
 */
function openaiEfforts(name: string): readonly ModelReasoningEffort[] {
  if (/-pro(?:[.-]|$)/.test(name)) return [];
  if (/^o[1-9](?:[.-]|$)/.test(name)) return ["low", "medium", "high"];
  if (/^gpt-5\.1-codex-max(?:[.-]|$)/.test(name)) {
    return ["low", "medium", "high", "xhigh"];
  }
  const minor = /^gpt-5\.(\d+)(?:[.-]|$)/.exec(name);
  if (minor) {
    return Number(minor[1]) >= 2
      ? ["none", "low", "medium", "high", "xhigh"]
      : ["none", "low", "medium", "high"];
  }
  if (/^gpt-5(?:-|$)/.test(name)) return ["minimal", "low", "medium", "high"];
  return [];
}

/**
 * Claude models that implement `output_config.effort` (and adaptive
 * thinking): Opus 4.5+, Sonnet 4.6+, and the Fable family. Older Claude
 * (3.x, 4.0/4.1) reject the fields, and Haiku is not verified, so those offer
 * nothing. A trailing date (`-20250514`) is not a minor version.
 */
function anthropicSupportsEffort(name: string): boolean {
  const m =
    /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d)(?!\d))?(?:[.-]|$)/.exec(
      name
    );
  if (!m) return false;
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  switch (m[1]) {
    case "opus":
      return major > 4 || (major === 4 && minor >= 5);
    case "sonnet":
      return major > 4 || (major === 4 && minor >= 6);
    case "fable":
      return major >= 5;
    default:
      return false;
  }
}

/**
 * Gemini 3+ thinking levels. Pro models take only low and high; the other
 * Gemini 3+ families (Flash) take the full set.
 */
function googleEfforts(name: string): readonly ModelReasoningEffort[] {
  if (!/^gemini-([3-9]|[1-9][0-9])(?:[.-]|$)/.test(name)) return [];
  return /-pro(?:[.-]|$)/.test(name)
    ? ["low", "high"]
    : GOOGLE_REASONING_EFFORTS;
}

/**
 * The efforts a provider/model pair accepts on a direct AI SDK call, from the
 * model families whose effort control the provider documents (OpenAI
 * reasoning models, Claude, Gemini 3+). Empty for anything else.
 */
function directEfforts(
  providerKey: string,
  modelId: string
): readonly ModelReasoningEffort[] {
  const name = bareModelName(modelId);
  switch (providerKey) {
    case "openai":
      return openaiEfforts(name);
    case "anthropic":
      return anthropicSupportsEffort(name) ? ANTHROPIC_REASONING_EFFORTS : [];
    case "google":
      return googleEfforts(name);
    default:
      return [];
  }
}

export type SupportedReasoningEffortsInput = {
  route: ReasoningEffortRoute;
  /** The model's provider key (`openai`, `anthropic`, …). */
  providerKey: string;
  modelId: string;
  /** The hosted catalog's `supportedReasoningEfforts` for this model. */
  catalogEfforts?: readonly string[];
  /** The turn runs inside this harness: its adapter table decides. */
  harness?: Harness;
};

const EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS);

/** Ordered subset of `MODEL_REASONING_EFFORTS` present in `values`. */
function orderedEfforts(values: readonly string[]): ModelReasoningEffort[] {
  const present = new Set(values.filter((v) => EFFORT_SET.has(v)));
  return MODEL_REASONING_EFFORTS.filter((level) => present.has(level));
}

/**
 * The efforts a control may offer for this model on this route, in canonical
 * low-to-high order. Empty means "hide the control": the capability is
 * unknown or absent.
 *
 *  - harness  → the adapter's verified table (empty until verified).
 *  - hosted   → the catalog's list, nothing else.
 *  - direct / org → the provider tables above.
 *  - orgCloud → none yet: the org-cloud stream does not apply an effort
 *    (flip when it does, in the same change as the backend).
 */
export function supportedReasoningEfforts(
  input: SupportedReasoningEffortsInput
): ModelReasoningEffort[] {
  if (input.harness !== undefined) {
    return orderedEfforts(HARNESS_REASONING_EFFORTS[input.harness] ?? []);
  }
  switch (input.route) {
    case "hosted":
      return orderedEfforts(input.catalogEfforts ?? []);
    case "orgCloud":
      return [];
    case "direct":
    case "org":
      return orderedEfforts(directEfforts(input.providerKey, input.modelId));
  }
}

// ── Direct provider options ──────────────────────────────────────────────

/**
 * Provider options for a direct AI SDK call
 * (`streamText({ providerOptions })`). Structurally the AI SDK's
 * `ProviderOptions`, declared here so the SDK stays free of that import.
 */
export type ReasoningEffortProviderOptions = Record<
  string,
  Record<string, unknown>
>;

/**
 * The provider options that apply `effort` on a direct AI SDK call, or
 * `undefined` when this provider/model has no effort control the installed
 * AI SDK provider exposes (the caller refuses the setting then). The same
 * mapping the backend uses for `/stream`.
 */
export function reasoningEffortProviderOptions(args: {
  providerKey: string;
  modelId: string;
  effort: ModelReasoningEffort;
}): ReasoningEffortProviderOptions | undefined {
  if (!directEfforts(args.providerKey, args.modelId).includes(args.effort)) {
    return undefined;
  }
  const name = bareModelName(args.modelId);
  switch (args.providerKey) {
    case "openai":
      return { openai: { reasoningEffort: args.effort } };
    case "anthropic":
      return {
        anthropic: {
          effort: args.effort,
          ...(/^claude-opus-4[.-]5(?:-|$)/.test(name)
            ? {}
            : { thinking: { type: "adaptive" } }),
        },
      };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: args.effort } } };
    default:
      return undefined;
  }
}

// ── Identity ─────────────────────────────────────────────────────────────

/**
 * Canonical form of a selection INCLUDING its settings: fields in declaration
 * order, empty `settings` dropped. Byte-identical (as JSON) to the backend's
 * `canonicalModelSelection`, which the ad-hoc environment fingerprint hashes,
 * so a client can decide "did this change" and "is this the same row" exactly
 * as the server does.
 */
function canonicalSelection(selection: ModelSelection): ModelSelection {
  const ref = selection.connectionRef;
  const settings = selection.settings;
  const hasSettings =
    settings !== undefined &&
    (settings.reasoningEffort !== undefined ||
      settings.temperature !== undefined);
  return {
    modelId: selection.modelId,
    source: selection.source,
    ...(ref === undefined
      ? {}
      : ref.kind === "orgProvider"
        ? { connectionRef: { kind: ref.kind, id: ref.id } }
        : {
            connectionRef: {
              kind: ref.kind,
              providerKey: ref.providerKey,
              ...(ref.customProviderName !== undefined
                ? { customProviderName: ref.customProviderName }
                : {}),
            },
          }),
    ...(selection.nativeModelId !== undefined
      ? { nativeModelId: selection.nativeModelId }
      : {}),
    ...(hasSettings
      ? {
          settings: {
            ...(settings.reasoningEffort !== undefined
              ? { reasoningEffort: settings.reasoningEffort }
              : {}),
            ...(settings.temperature !== undefined
              ? { temperature: settings.temperature }
              : {}),
          },
        }
      : {}),
    fallback: {
      provider: selection.fallback.provider,
      model: selection.fallback.model,
    },
  };
}

/**
 * Identity of a selection INCLUDING its settings. Use it for change
 * detection and reuse ("did the user edit anything", "is this the row I
 * already have"). {@link selectionKey} deliberately ignores settings — it is
 * the picker row / cache key, and an effort must not split a row — so it can
 * NOT tell that two selections differ only by effort.
 */
export function selectionConfigKey(selection: ModelSelection): string {
  return JSON.stringify(canonicalSelection(selection));
}

/**
 * The selection, only if it is for `modelId`. A saved selection belongs to
 * one model (its `modelId`, source, connection and settings were chosen for
 * it); after the model changes it must be dropped, not carried onto a model
 * it was never validated for.
 */
export function selectionIfMatches(
  selection: ModelSelection | undefined,
  modelId: string | undefined
): ModelSelection | undefined {
  if (selection === undefined || modelId === undefined) return undefined;
  return selection.modelId === modelId.trim() ? selection : undefined;
}
