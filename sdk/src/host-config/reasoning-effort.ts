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
  type RequestedModelSelection,
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
  // STILL REFUSED, PENDING THE LIVE CHECK. The adapter has the mapping code
  // (`effort` option + adaptive thinking + effort env), but whether the AI
  // Gateway accepts adaptive thinking + `output_config.effort` per model, and
  // what reaches the wire, needs a staging run that has not happened. Fill
  // this row only from that check's evidence, never by inference.
  "claude-code": [],
  // Both transports apply it through their own option (exec `reasoningEffort`,
  // app-server `turn/start effort`). none / minimal / max stay refused until
  // verified.
  codex: ["low", "medium", "high", "xhigh"],
  cursor: [],
};

/**
 * The level a provider applies when the request sends NO effort, per model
 * family (the provider's documented default). The effort control captions
 * this level "Default"; picking Default sends `undefined`, never this value,
 * so a saved selection stays a default selection. `undefined` where the
 * provider documents no default or the family offers no effort.
 */
function providerDefaultEffort(
  providerKey: string,
  name: string
): ModelReasoningEffort | undefined {
  switch (providerKey) {
    case "openai": {
      const levels = openaiEfforts(name);
      if (levels.length === 0) return undefined;
      // GPT-5.1 and later default to no reasoning; earlier reasoning models
      // (GPT-5, o-series, Codex) default to medium.
      if (/^gpt-5\.\d+(?:[.-]|$)/.test(name) && levels.includes("none")) {
        return "none";
      }
      return levels.includes("medium") ? "medium" : undefined;
    }
    case "anthropic":
      // Claude applies `high` when no effort is sent.
      return anthropicEfforts(name).includes("high") ? "high" : undefined;
    case "google":
      // Gemini 3 thinks at `high` (dynamic) unless a level is sent.
      return googleEfforts(name).includes("high") ? "high" : undefined;
    default:
      return undefined;
  }
}

/** Provider key from a canonical `provider/model` id (`undefined` if bare). */
function providerOfModelId(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : undefined;
}

/**
 * The provider's default level for `modelId` on `route`: what the model does
 * when the request carries no effort. For the control's "Default" caption,
 * never to fill a request. `providerKey` is needed only when `modelId` is a
 * bare native id (direct BYOK rows); a canonical id carries its provider.
 * `org` (runtime unknown) answers `undefined`, like
 * {@link supportedReasoningEfforts}.
 */
export function defaultReasoningEffort(
  modelId: string,
  route: ReasoningEffortRoute,
  providerKey?: string
): ModelReasoningEffort | undefined {
  if (route === "org") return undefined;
  const provider = providerKey ?? providerOfModelId(modelId);
  if (provider === undefined) return undefined;
  return providerDefaultEffort(provider, bareModelName(modelId));
}

// ── Capability ───────────────────────────────────────────────────────────

/**
 * Where a call runs, which decides who owns the capability. Pass the CONCRETE
 * route: `org` means the org's runtime (cloud vs local) is not known yet, so
 * it answers "no efforts" rather than offer levels the cloud runtime would
 * refuse; resolve it to `direct` or `orgCloud` first.
 */
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
 * as non-reasoning). Codex models are hidden except the two documented ones (never `none`).
 */
function openaiEfforts(name: string): readonly ModelReasoningEffort[] {
  if (/-(?:pro|chat)(?:[.-]|$)/.test(name)) return [];
  // o-series: only the ids the provider sends effort for. `o1-mini` and
  // `o1-preview` reject the parameter, and unknown `oN` are unverified.
  if (/^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(name)) {
    return ["low", "medium", "high"];
  }
  // Codex variants differ (`-mini` takes fewer levels, some add `minimal`), and
  // only the two below are documented, so every other Codex id is hidden
  // rather than guessed from its family.
  if (/-codex(?:[.-]|$)/.test(name)) {
    return /^gpt-5\.1-codex-max$|^gpt-5\.2-codex$/.test(name)
      ? ["low", "medium", "high", "xhigh"]
      : [];
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
 * The efforts a harness adapter is verified to apply, whatever the model. For
 * "does this harness enforce an effort at all" questions; the levels a control
 * may offer for a model are {@link supportedReasoningEfforts}.
 */
export function harnessReasoningEfforts(
  harness: Harness
): ModelReasoningEffort[] {
  return orderedEfforts(HARNESS_REASONING_EFFORTS[harness] ?? []);
}

/**
 * The efforts a control may offer for this model on this route, in canonical
 * low-to-high order. Empty means "hide the control": the capability is
 * unknown or absent.
 *
 *  - harness  → the adapter's verified table intersected with the model's
 *    own levels (empty until verified, or when the model's are unknown).
 *  - hosted   → the catalog's list, nothing else.
 *  - direct   → the provider tables above.
 *  - org      → none: the concrete runtime is unknown (see the route type).
 *  - orgCloud → the provider tables, like direct: the backend's org-cloud
 *    stream maps an effort per org provider key and refuses one it cannot
 *    map. Providers this module has no table for offer nothing.
 */
export function supportedReasoningEfforts(
  input: SupportedReasoningEffortsInput
): ModelReasoningEffort[] {
  if (input.harness !== undefined) {
    // The adapter's table says what the RUNTIME can apply; the model's own
    // levels say what the MODEL accepts (`xhigh` on `gpt-5-nano` passes the
    // first and fails at the lease mint). Offer only what both allow, and
    // nothing when the model's levels are unknown (fail closed).
    const modelLevels = new Set<string>(
      supportedReasoningEfforts({ ...input, harness: undefined })
    );
    return orderedEfforts(
      (HARNESS_REASONING_EFFORTS[input.harness] ?? []).filter((level) =>
        modelLevels.has(level)
      )
    );
  }
  switch (input.route) {
    case "hosted":
      return orderedEfforts(input.catalogEfforts ?? []);
    case "org":
      return [];
    case "orgCloud":
    case "direct":
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

/**
 * A selection that runs exactly like its bare model id: the legacy form, or a
 * hosted selection with no settings and no `nativeModelId`. Its
 * {@link comparisonKey} is the bare `modelId`, byte-identical to the keys
 * stored before selections existed, so history, baselines and gates keyed on
 * it do not move. `fallback` is not identity.
 */
export function isDefaultSelection(selection: RequestedModelSelection): boolean {
  if (selection.source === "legacy") return true;
  if (selection.source !== "hosted") return false;
  if (selection.nativeModelId !== undefined) return false;
  const settings = selection.settings;
  return (
    settings === undefined ||
    (settings.reasoningEffort === undefined &&
      settings.temperature === undefined)
  );
}

/**
 * THE identity of a model choice wherever two choices are compared: matrix
 * cells, compare cards, result columns, run baselines, verdict variants.
 *
 * - a default selection ({@link isDefaultSelection}) keys as the bare
 *   `modelId` (unchanged from before selections);
 * - anything else keys as `modelId` + `\u0000` + the canonical selection JSON
 *   WITHOUT `fallback`, so Sonnet·High, Sonnet·Low, Sonnet on MCPJam and
 *   Sonnet on an org key are four different targets.
 *
 * Byte-identical to the backend's `comparisonKey`
 * (`convex/lib/modelSelection.ts`); a golden string is asserted in both repos.
 */
export function comparisonKey(selection: RequestedModelSelection): string {
  const variantKey = executionVariantSelectionKey(selection);
  return variantKey === undefined
    ? selection.modelId
    : `${selection.modelId}\u0000${variantKey}`;
}

/**
 * The `selectionKey` an eval execution variant carries: the canonical
 * selection JSON without `fallback` ({@link comparisonKey} minus its
 * `modelId` prefix), or `undefined` for a default selection so the verdict
 * key of every default variant is unchanged.
 */
export function executionVariantSelectionKey(
  selection: RequestedModelSelection
): string | undefined {
  if (isDefaultSelection(selection)) return undefined;
  const { fallback: _fallback, ...rest } = canonicalSelection(
    selection as ModelSelection
  );
  void _fallback;
  return JSON.stringify(rest);
}

/** Short level labels for distinguishers ("· High"). */
const DISTINGUISHER_EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

function connectionLabel(selection: RequestedModelSelection): string {
  if (selection.source === "legacy") return "Your key";
  if (selection.source === "hosted") return "MCPJam";
  const ref = selection.connectionRef;
  if (ref?.kind === "localProvider") {
    return ref.customProviderName ?? ref.providerKey;
  }
  return "Org key";
}

function settingsOf(selection: RequestedModelSelection) {
  return selection.source === "legacy" ? undefined : selection.settings;
}

/**
 * What tells `selection` apart from its siblings, as short labels in a fixed
 * order (source/connection, native id, effort, temperature). A set effort is
 * ALWAYS labelled, so a run at High reads "High" even alone; the other
 * dimensions (and "Default", an unset effort) appear only where they differ
 * among the siblings that share its `modelId`. Two Sonnet columns at Low and
 * High read "Low" / "High"; a lone Sonnet at High reads "High"; a lone
 * Sonnet with no effort reads nothing.
 *
 * `siblings` may include `selection` itself; selections for other model ids
 * are ignored (the model name already tells those apart).
 */
export function selectionDistinguishers(
  selection: RequestedModelSelection,
  siblings: readonly RequestedModelSelection[]
): string[] {
  const peers = siblings.filter(
    (sibling) =>
      sibling.modelId === selection.modelId &&
      comparisonKey(sibling) !== comparisonKey(selection)
  );
  const effortOf = (s: RequestedModelSelection) =>
    settingsOf(s)?.reasoningEffort;
  const ownEffort = effortOf(selection);
  if (peers.length === 0) {
    return ownEffort === undefined
      ? []
      : [DISTINGUISHER_EFFORT_LABELS[ownEffort]];
  }
  const labels: string[] = [];

  const own = connectionLabel(selection);
  const ownConnectionKey =
    selection.source === "legacy" ? "legacy" : connectionIdentity(selection);
  if (
    peers.some(
      (peer) =>
        (peer.source === "legacy" ? "legacy" : connectionIdentity(peer)) !==
        ownConnectionKey
    )
  ) {
    labels.push(own);
  }

  const nativeOf = (s: RequestedModelSelection) =>
    s.source === "legacy" ? undefined : s.nativeModelId;
  if (peers.some((peer) => nativeOf(peer) !== nativeOf(selection))) {
    const native = nativeOf(selection);
    if (native !== undefined) labels.push(native);
  }

  if (
    ownEffort !== undefined ||
    peers.some((peer) => effortOf(peer) !== ownEffort)
  ) {
    labels.push(
      ownEffort === undefined
        ? "Default"
        : DISTINGUISHER_EFFORT_LABELS[ownEffort]
    );
  }

  const temperatureOf = (s: RequestedModelSelection) =>
    settingsOf(s)?.temperature;
  if (peers.some((peer) => temperatureOf(peer) !== temperatureOf(selection))) {
    const temperature = temperatureOf(selection);
    labels.push(
      temperature === undefined ? "Default temp" : `Temp ${temperature}`
    );
  }

  return labels;
}

/** Source + connection only (no model id, no settings). */
function connectionIdentity(selection: ModelSelection): string {
  const ref = selection.connectionRef;
  if (ref === undefined) return selection.source;
  return ref.kind === "orgProvider"
    ? `${selection.source}:${ref.id}`
    : `${selection.source}:${ref.providerKey}:${ref.customProviderName ?? ""}`;
}
