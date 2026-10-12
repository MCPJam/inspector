/**
 * The explicit target a model picker saves for a picked row while the
 * organization's AI key policy may be on. Pure and React-free.
 */
import {
  selectionBesideLegacyId,
  storedModelChoice,
} from "@/components/chat-v2/shared/model-selection";
import { modelTarget, type ModelTarget } from "@/lib/model-target";
import type { ModelDefinition } from "@/shared/types";

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
