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
 * `none` is GPT-5.1 only and `xhigh` GPT-5.1-Codex-Max / GPT-5.2+, and a wrong
 * level is an API error). Families this does not know return none: the
 * control is hidden rather than guessed. `-pro` and `-chat` models are hidden
 * the same way (pro takes narrower levels; the provider classes `gpt-5*-chat*`
 * as non-reasoning). Codex models never take `none`.
 */
function openaiEfforts(name: string): readonly ModelReasoningEffort[] {
  if (/-(?:pro|chat)(?:[.-]|$)/.test(name)) return [];
  if (/^o[1-9](?:[.-]|$)/.test(name)) return ["low", "medium", "high"];
  const codex = /-codex(?:[.-]|$)/.test(name);
  if (/^gpt-5\.1-codex-max(?:[.-]|$)/.test(name)) {
    return ["low", "medium", "high", "xhigh"];
  }
  const minor = /^gpt-5\.(\d+)(?:[.-]|$)/.exec(name);
  if (minor) {
    const m = Number(minor[1]);
    if (codex) {
      return m >= 2
        ? ["low", "medium", "high", "xhigh"]
        : ["low", "medium", "high"];
    }
    return m >= 2
      ? ["none", "low", "medium", "high", "xhigh"]
      : ["none", "low", "medium", "high"];
  }
  if (/^gpt-5(?:-|$)/.test(name)) {
    return codex
      ? ["low", "medium", "high"]
      : ["minimal", "low", "medium", "high"];
  }
  return [];
}

/**
 * Claude levels by model version (the provider package documents that effort
 * arrived with Opus 4.5 with low/medium/high, `max` came with the adaptive-
 * thinking models, and `xhigh` with Opus 4.7). Older Claude (3.x, 4.0/4.1)
 * rejects the fields, and Haiku and unknown families are not verified, so
 * they offer nothing. A trailing date (`-20250514`) is not a minor version.
 */
function anthropicEfforts(name: string): readonly ModelReasoningEffort[] {
  const m =
    /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2})(?!\d))?(?:[.-]|$)/.exec(
      name
    );
  if (!m) return [];
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  const ALL: readonly ModelReasoningEffort[] = ANTHROPIC_REASONING_EFFORTS;
  // Version 5+ (Opus, Sonnet, Fable) documents the full set. Within 4.x only
  // the documented minors are listed; an undocumented minor (4.10+) is
  // unverified and offers nothing.
  if (m[1] === "haiku") return [];
  if (major >= 5) return ALL;
  if (major !== 4 || minor >= 10) return [];
  if (m[1] === "opus") {
    if (minor >= 7) return ALL;
    if (minor === 6) return ["low", "medium", "high", "max"];
    if (minor === 5) return ["low", "medium", "high"];
    return [];
  }
  // sonnet / fable 4.x
  return m[1] === "sonnet" && minor >= 6
    ? ["low", "medium", "high", "max"]
    : [];
}

/**
 * Gemini 3+ thinking levels, per the provider package: 3.1 Pro takes low /
 * medium / high, 3 Pro takes low / high, 3 Flash takes all four. Other
 * families (Flash-Lite, image models, later versions) are not verified and
 * offer nothing.
 */
function googleEfforts(name: string): readonly ModelReasoningEffort[] {
  if (/^gemini-3\.\d+-pro(?:-preview)?(?:-\d+)?$/.test(name)) {
    return ["low", "medium", "high"];
  }
  if (/^gemini-3-pro(?:-preview)?(?:-\d+)?$/.test(name)) return ["low", "high"];
  if (/^gemini-3(?:\.\d+)?-flash(?:-preview)?(?:-\d+)?$/.test(name)) {
    return GOOGLE_REASONING_EFFORTS;
  }
  return [];
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
      return anthropicEfforts(name);
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
