/**
 * One explicit model choice — a model id plus the saved selection behind it —
 * and THE identity two choices are compared by.
 *
 * Identity is the SDK's `comparisonKey`: a target with no selection (an
 * unlabelled pick) or a default selection keys as its bare model id, exactly
 * like before selections existed; anything else (an effort, a temperature, an
 * org connection) keys as the id plus the canonical selection. So Sonnet·High
 * and Sonnet·Low are two targets — two matrix cells, two environments — while
 * the same key picked twice is one.
 *
 * Pure and React-free: the composer, the resolver, the run matrix and the
 * label vocabulary all read it.
 */
import {
  comparisonKey,
  selectionConfigKey,
  selectionKey,
  type ModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";

export type ModelTarget = {
  modelId: string;
  /**
   * The saved selection (source, connection, settings) behind `modelId`.
   * Absent = an unlabelled pick, which runs exactly as a bare id did.
   */
  selection?: ModelSelection;
};

/** A selection belongs to one model; one for another id is dropped. */
export function modelTarget(
  modelId: string,
  selection?: ModelSelection | null,
): ModelTarget {
  return selection && selection.modelId === modelId
    ? { modelId, selection }
    : { modelId };
}

/** The target's `comparisonKey` (the bare id when it has no selection). */
export function modelTargetKey(target: ModelTarget): string {
  return target.selection && target.selection.modelId === target.modelId
    ? comparisonKey(target.selection)
    : target.modelId;
}

/**
 * The selection a target is labelled and distinguished by. An unlabelled
 * target stands in as a legacy selection: same bare-id key, no settings.
 */
export function targetIdentitySelection(
  target: ModelTarget,
): RequestedModelSelection {
  return target.selection && target.selection.modelId === target.modelId
    ? target.selection
    : { source: "legacy", modelId: target.modelId };
}

/** List order kept; a later target with a key already seen is dropped. */
export function dedupeModelTargets(
  targets: readonly ModelTarget[],
): ModelTarget[] {
  const seen = new Set<string>();
  const out: ModelTarget[] = [];
  for (const target of targets) {
    if (!target.modelId) continue;
    const normalized = modelTarget(target.modelId, target.selection);
    const key = modelTargetKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/** The target an environment row runs (undefined = inherits the client's). */
export function environmentModelTarget(environment: {
  modelId?: string | null;
  modelSelection?: ModelSelection | null;
}): ModelTarget | undefined {
  return environment.modelId
    ? modelTarget(environment.modelId, environment.modelSelection)
    : undefined;
}

/**
 * Whether two targets are the same choice, for REUSING a saved row.
 *
 * Same `comparisonKey`, and — when both carry a stored selection — the same
 * source and connection (`selectionKey`). Two default selections share a key across sources (a stored
 * legacy selection runs on your own key, a plain hosted one on MCPJam
 * credits), so reusing one for the other would change who pays. An
 * unlabelled side matches on the key alone, as a bare id always did.
 */
export function sameModelTarget(
  left: ModelTarget,
  right: ModelTarget,
): boolean {
  if (modelTargetKey(left) !== modelTargetKey(right)) return false;
  const a = modelTarget(left.modelId, left.selection).selection;
  const b = modelTarget(right.modelId, right.selection).selection;
  if (!a || !b) return true;
  return selectionKey(a) === selectionKey(b);
}

/**
 * Config-strict key for "did this choice change?" (dirty checks): unlike
 * {@link modelTargetKey} it tells a stored selection from no selection.
 */
export function modelTargetConfigKey(target: ModelTarget): string {
  const { selection } = modelTarget(target.modelId, target.selection);
  return selection
    ? `${target.modelId}\u0000${selectionConfigKey(selection)}`
    : target.modelId;
}
