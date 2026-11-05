/**
 * The explicit target a model picker saves for a picked row while the
 * organization's AI key policy may be on. Pure and React-free.
 */
import {
  findModelForStoredChoice,
  modelSelectionFromDefinition,
  selectionBesideLegacyId,
  storedModelChoice,
} from "@/components/chat-v2/shared/model-selection";
import { modelTarget, type ModelTarget } from "@/lib/model-target";
import type { ModelDefinition } from "@/shared/types";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import {
  isOrgKeysDisallowedRow,
  orgKeysDisallowedRow,
  savedModelRow,
} from "@/components/chat-v2/shared/available-models";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";
import {
  applyHarnessModelLocks,
  type HarnessModelTarget,
} from "@/lib/harness-model-locks";

/**
 * The target a picked row saves. Under the organization's key policy, an
 * organization row whose id is bare (`gpt-5` on an org OpenAI connection) is
 * saved under its canonical id with its org selection: the bare id alone runs
 * as a legacy id, which the policy refuses (`org_keys_required`). Every other
 * row keeps its own id, and `syncExplicitTargets` adds the selection it can
 * carry beside it.
 */
export function pickedModelTarget(
  model: ModelDefinition,
  requireOrgKeys: boolean,
): ModelTarget {
  if (requireOrgKeys && !selectionBesideLegacyId(model, "evalTarget")) {
    const choice = storedModelChoice(model, undefined, "evalTarget");
    if (choice.selection?.source === "org") {
      return modelTarget(choice.modelId, choice.selection);
    }
  }
  return { modelId: String(model.id) };
}

/**
 * The rows a model picker may offer for an eval or environment target. Under
 * the organization's key policy a row is offered only when a pick saves it
 * with its organization connection ({@link pickedModelTarget}); every other
 * row would save a legacy id, which the launch refuses (`org_keys_required`).
 * A saved model the policy no longer allows stays, so its trigger can still
 * say so.
 */
export function orgSavableModels(
  models: ModelDefinition[],
  requireOrgKeys: boolean,
): ModelDefinition[] {
  if (!requireOrgKeys) return models;
  return models.filter(
    (model) =>
      isOrgKeysDisallowedRow(model) ||
      modelSelectionFromDefinition(model, undefined, "evalTarget")?.source ===
        "org",
  );
}

/**
 * The rows an eval model picker offers: {@link orgSavableModels}, with a
 * harness's lock on each row it can't run (under the policy, a harness runs
 * only on an organization connection to its own vendor).
 */
export function evalModelRows(
  models: ModelDefinition[],
  harness: HarnessModelTarget | null | undefined,
  requireOrgKeys: boolean,
): ModelDefinition[] {
  return applyHarnessModelLocks(
    orgSavableModels(models, requireOrgKeys),
    [harness],
    "eval",
    { requireOrgKeys },
  );
}

/** A saved strict target must name its source and connection, not just a model id. */
export function resolveEvalModelChoice(
  modelId: string,
  models: readonly ModelDefinition[],
  requireOrgKeys: boolean,
  {
    saved = true,
    selection,
  }: { saved?: boolean; selection?: ModelSelection } = {},
): ModelDefinition {
  const row = selection
    ? findModelForStoredChoice({ modelId, selection }, models, undefined, {
        exactSelection: requireOrgKeys,
      })
    : requireOrgKeys && saved && !isRuntimeChosenModelSentinel(modelId)
      ? undefined
      : models.find((model) => String(model.id) === modelId);
  return (
    row ??
    (requireOrgKeys && saved && !isRuntimeChosenModelSentinel(modelId)
      ? orgKeysDisallowedRow(savedModelRow(modelId, models))
      : { id: modelId, name: compactModelLabel(modelId), provider: "unknown" })
  );
}
