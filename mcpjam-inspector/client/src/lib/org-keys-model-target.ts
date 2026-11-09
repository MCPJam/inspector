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
import type {
  ModelSelection,
  ModelSelectionPurpose,
} from "@mcpjam/sdk/browser";
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
 * The canonical target of an organization row whose id is bare (`gpt-5` on an
 * org OpenAI connection): its canonical id with its org selection. The bare id
 * alone runs as a legacy id, which the organization's key policy refuses
 * (`org_keys_required`). `undefined` for every other row, including one whose
 * selection can sit beside its unchanged id.
 */
export function orgCanonicalTarget(
  model: ModelDefinition,
  purpose: ModelSelectionPurpose,
): Required<ModelTarget> | undefined {
  if (selectionBesideLegacyId(model, purpose)) return undefined;
  return orgSelectionTarget(model, purpose);
}

/**
 * The id and organization selection a pick of this row saves. `undefined`
 * when the row cannot be saved as one, such as an organization row whose bare
 * id has no canonical catalog id: the policy refuses it after reload.
 */
export function orgSelectionTarget(
  model: ModelDefinition,
  purpose: ModelSelectionPurpose,
): Required<ModelTarget> | undefined {
  const choice = storedModelChoice(model, undefined, purpose);
  return choice.selection?.source === "org"
    ? { modelId: choice.modelId, selection: choice.selection }
    : undefined;
}

/**
 * Under the organization's key policy, a picker that saves a model offers
 * only rows it can save with an organization selection. Disabled rows stay,
 * so the saved model's warning row is still shown on the trigger.
 */
export function orgKeysSavableRows(
  models: ModelDefinition[],
  requireOrgKeys: boolean,
  purpose: ModelSelectionPurpose,
): ModelDefinition[] {
  if (!requireOrgKeys) return models;
  return models.filter(
    (row) => row.disabled === true || orgSelectionTarget(row, purpose),
  );
}

/**
 * The target a picked row saves. Under the organization's key policy, a
 * bare-id organization row is saved as its {@link orgCanonicalTarget}. Every
 * other row keeps its own id, and `syncExplicitTargets` adds the selection it
 * can carry beside it.
 */
export function pickedModelTarget(
  model: ModelDefinition,
  requireOrgKeys: boolean,
): ModelTarget {
  const org = requireOrgKeys
    ? orgCanonicalTarget(model, "evalTarget")
    : undefined;
  return org
    ? modelTarget(org.modelId, org.selection)
    : { modelId: String(model.id) };
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
 * only on an organization connection that serves its API).
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
