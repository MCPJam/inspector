/**
 * The explicit target a model picker saves for a picked row while the
 * organization's AI key policy may be on. Pure and React-free.
 */
import {
  findModelForStoredChoice,
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
  orgKeysDisallowedRow,
  savedModelRow,
} from "@/components/chat-v2/shared/available-models";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";

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
  const choice = storedModelChoice(model, undefined, purpose);
  return choice.selection?.source === "org"
    ? { modelId: choice.modelId, selection: choice.selection }
    : undefined;
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
  return org ? modelTarget(org.modelId, org.selection) : { modelId: String(model.id) };
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
