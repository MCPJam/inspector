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
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import {
  orgKeysDisallowedRow,
  savedModelRow,
} from "@/components/chat-v2/shared/available-models";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";

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
