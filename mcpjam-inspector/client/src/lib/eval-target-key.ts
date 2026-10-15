/**
 * Result views key every run and iteration by its TARGET — the
 * `comparisonKey` of the model selection it ran with (backend `targetKey`).
 *
 * A default selection (legacy, or plain hosted with no settings and no native
 * id) keys as the bare model id, byte-identical to what these views keyed by
 * before selections existed, so unlabelled and default runs land in exactly
 * the columns, lanes and baselines they always did. Anything else keys as
 * `modelId + "\u0000" + canonical selection JSON` (no `fallback`), so
 * Sonnet·High and Sonnet·Low are two targets.
 *
 * Labels show only what differs (`selectionDistinguishers`): a lone target
 * reads as its model, two targets of one model read "Sonnet 5.5 · High" and
 * "Sonnet 5.5 · Low".
 */
import {
  comparisonKey,
  executionVariantSelectionKey,
  selectionDistinguishers,
  type ModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import { compactModelIdTail } from "@/lib/environment-label";

export const TARGET_KEY_SEPARATOR = "\u0000";

/** Not identity (`comparisonKey` drops it); only fills the required field. */
const NO_FALLBACK: ModelSelection["fallback"] = {
  provider: "none",
  model: "none",
};

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The model id a target key names (the part before the separator). */
export function modelIdFromTargetKey(key: string): string {
  const cut = key.indexOf(TARGET_KEY_SEPARATOR);
  return cut === -1 ? key : key.slice(0, cut);
}

/**
 * The selection a target key encodes, for labelling.
 *
 * - A bare key (a default selection) reads as a plain hosted selection with no
 *   settings: the key cannot tell legacy from hosted-default apart, and
 *   reading it as hosted keeps "Sonnet" vs "Sonnet · High" labelled by the
 *   effort that differs rather than by a connection nobody chose.
 * - A non-default key parses its canonical JSON back; `fallback` (dropped from
 *   the key) is filled with `none`.
 * - A key whose JSON part does not parse to a selection for the same model
 *   falls back to the bare-key reading of its model id.
 */
export function selectionFromTargetKey(key: string): RequestedModelSelection {
  const modelId = modelIdFromTargetKey(key);
  const bare: RequestedModelSelection = {
    modelId,
    source: "hosted",
    fallback: NO_FALLBACK,
  };
  const cut = key.indexOf(TARGET_KEY_SEPARATOR);
  if (cut === -1) return bare;
  try {
    const parsed = JSON.parse(key.slice(cut + 1)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { modelId?: unknown }).modelId !== modelId ||
      typeof (parsed as { source?: unknown }).source !== "string"
    ) {
      return bare;
    }
    if ((parsed as { source: string }).source === "legacy") {
      return parsed as RequestedModelSelection;
    }
    const selection = parsed as ModelSelection;
    return { ...selection, fallback: selection.fallback ?? NO_FALLBACK };
  } catch {
    return bare;
  }
}

/** Fields a run row may carry to name its target. */
export type TargetKeyedRun = {
  targetKey?: string | null;
  effectiveModelId?: string;
};

/** Fields an iteration row may carry to name its target. */
export type TargetKeyedIteration = {
  targetKey?: string | null;
  testCaseSnapshot?: {
    model?: string;
    selection?: RequestedModelSelection | null;
  } | null;
};

/**
 * A run's target: `run.targetKey`, else (older backends, or the list
 * projection) its `effectiveModelId`, which equals the key of every default
 * run. Undefined when the run names neither.
 */
export function runTargetKey(
  run: TargetKeyedRun | null | undefined,
): string | undefined {
  return nonEmpty(run?.targetKey) ?? nonEmpty(run?.effectiveModelId);
}

/**
 * An iteration's target: `iteration.targetKey`, else the `comparisonKey` of
 * its snapshot selection, else its snapshot model id.
 */
export function iterationTargetKey(
  iteration: TargetKeyedIteration | null | undefined,
): string | undefined {
  const own = nonEmpty(iteration?.targetKey);
  if (own) return own;
  const selection = iteration?.testCaseSnapshot?.selection;
  if (selection && nonEmpty(selection.modelId)) {
    return comparisonKey(selection);
  }
  return nonEmpty(iteration?.testCaseSnapshot?.model);
}

/**
 * The `selectionKey` of the execution variant an iteration ran under (the
 * verdict aggregation key appends it): the selection part of its target key,
 * or of its snapshot selection. Undefined for a default selection, so the
 * verdict key of every default variant is unchanged.
 */
export function iterationSelectionKey(
  iteration: TargetKeyedIteration | null | undefined,
): string | undefined {
  const own = nonEmpty(iteration?.targetKey);
  if (own) {
    const cut = own.indexOf(TARGET_KEY_SEPARATOR);
    return cut === -1 ? undefined : nonEmpty(own.slice(cut + 1));
  }
  const selection = iteration?.testCaseSnapshot?.selection;
  return selection && nonEmpty(selection.modelId)
    ? executionVariantSelectionKey(selection)
    : undefined;
}

/**
 * The target ONE iteration of `run` belongs to. A run with one effective model
 * keys all its iterations by the run's target (as the views always grouped
 * them by `effectiveModelId`); a run without one (case models, client
 * default) keys each iteration by its own target.
 */
export function runIterationTargetKey(
  run: TargetKeyedRun | null | undefined,
  iteration: TargetKeyedIteration | null | undefined,
): string | undefined {
  if (nonEmpty(run?.effectiveModelId)) return runTargetKey(run);
  return iterationTargetKey(iteration);
}

/**
 * Two runs ran the same target. Compares `targetKey`s when both carry one, and
 * `effectiveModelId` otherwise — so a run recorded before targets existed
 * still pairs with its successor instead of losing its baseline at the
 * upgrade.
 */
export function sameRunTarget(a: TargetKeyedRun, b: TargetKeyedRun): boolean {
  const aKey = nonEmpty(a.targetKey);
  const bKey = nonEmpty(b.targetKey);
  if (aKey && bKey) return aKey === bKey;
  return a.effectiveModelId === b.effectiveModelId;
}

/**
 * What tells `key` apart from the other targets in view, as short labels
 * ("High"); empty for a lone target of its model.
 */
export function targetKeyDistinguishers(
  key: string,
  siblingKeys: Iterable<string>,
): string[] {
  const siblings = [...new Set(siblingKeys)].map(selectionFromTargetKey);
  const own = selectionFromTargetKey(key);
  // An effort string the SDK has no short label for (usage rows carry a loose
  // string) is shown as recorded rather than dropped.
  const rawEffort =
    own.source === "legacy" ? undefined : own.settings?.reasoningEffort;
  return selectionDistinguishers(own, siblings).flatMap((label) =>
    label !== undefined
      ? [label]
      : rawEffort !== undefined
        ? [String(rawEffort)]
        : [],
  );
}

/** `" · High"` (or `""` when nothing differs). */
export function targetKeySuffix(
  key: string,
  siblingKeys: Iterable<string>,
): string {
  const labels = targetKeyDistinguishers(key, siblingKeys);
  return labels.length > 0 ? ` · ${labels.join(" · ")}` : "";
}

/**
 * The display label for a target among its siblings: the model (via
 * `modelLabel`, compact id tail by default) plus only what differs.
 * A bare key with no differing sibling reads exactly as `modelLabel(key)`.
 */
export function targetKeyLabel(
  key: string,
  siblingKeys: Iterable<string>,
  modelLabel: (modelId: string) => string = compactModelIdTail,
): string {
  return `${modelLabel(modelIdFromTargetKey(key))}${targetKeySuffix(
    key,
    siblingKeys,
  )}`;
}

/** {@link targetKeyLabel} for every key, each labelled against all of them. */
export function targetKeyLabels(
  keys: Iterable<string>,
  modelLabel: (modelId: string) => string = compactModelIdTail,
): Map<string, string> {
  const unique = [...new Set(keys)];
  return new Map(
    unique.map((key) => [key, targetKeyLabel(key, unique, modelLabel)]),
  );
}

/**
 * The key of a (model × effective effort) usage row — what run metrics group
 * by — as a target key, so the same labeller names it: an effort-less row is
 * the bare model, an effort row a hosted selection at that effort.
 */
export function modelEffortTargetKey(
  model: string,
  reasoningEffort: string | undefined,
): string {
  if (!reasoningEffort) return model;
  return comparisonKey({
    modelId: model,
    source: "hosted",
    settings: {
      reasoningEffort: reasoningEffort as NonNullable<
        ModelSelection["settings"]
      >["reasoningEffort"],
    },
    fallback: NO_FALLBACK,
  });
}
