/**
 * The model a client created from a catalog template starts on while the
 * organization requires its own provider keys. Pure and React-free.
 *
 * A template names a hosted model (`openai/gpt-5.6-luna` for ChatGPT), which
 * the policy refuses, so a new client takes the first organization model it
 * can run instead: the template's own model on an organization connection,
 * else the first listed model from the template's provider, else the first
 * listed model. With none, nothing may be created: the backend cannot store a
 * client without a model, and a hosted one would only show "isn't allowed
 * here". Policy off, the template is used exactly as it is.
 */
import type { ModelDefinition } from "@/shared/types";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { storedModelChoice } from "@/components/chat-v2/shared/model-selection";
import { harnessPickerModels } from "@/lib/harness-model-locks";
import { HOST_MODEL_SELECTION_PURPOSE } from "@/lib/host-model-selection";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";

export type OrgBoundTemplateSeed =
  | { kind: "unchanged"; input: HostConfigInputV2 }
  | {
      kind: "bound";
      input: HostConfigInputV2;
      /** The organization row the client starts on, for the success message. */
      row: ModelDefinition;
      /** `firstConfigured` means a model other than the template's was chosen. */
      via: "template" | "firstConfigured";
    }
  | { kind: "needs_model" };

/** Why a template create saved nothing, and what to do about it. */
export function needsOrgModelMessage(
  label: string,
  canManageProviders: boolean,
): string {
  return canManageProviders
    ? `${label} was not created. Your organization has no model this client can run; add one in AI providers, then try again.`
    : `${label} was not created. Your organization has no model this client can run; ask an organization admin to add one.`;
}

/** A success message, naming the model when it is not the template's own. */
export function withStartedOn(message: string, startedOn?: string): string {
  if (!startedOn) return message;
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} It starts on ${startedOn}.`;
}

export function bindTemplateSeedToOrg(
  seed: HostConfigInputV2,
  context: {
    requireOrgKeys: boolean;
    /** The scoped project's picker rows (organization rows under the policy). */
    models: readonly ModelDefinition[];
    /** The deployment stores a model selection beside a model id. */
    selectionsSupported: boolean;
  },
): OrgBoundTemplateSeed {
  if (!context.requireOrgKeys || isRuntimeChosenModelSentinel(seed.modelId)) {
    return { kind: "unchanged", input: seed };
  }
  // Without a stored selection an organization row saves only its bare id,
  // which the policy refuses as well.
  if (!context.selectionsSupported) return { kind: "needs_model" };

  const runnable = harnessPickerModels(
    [...context.models],
    seed.harness ? { harnessId: seed.harness } : null,
    { requireOrgKeys: true },
  ).filter((row) => row.disabled !== true);
  const candidates = runnable.flatMap((row) => {
    const choice = storedModelChoice(row, undefined, HOST_MODEL_SELECTION_PURPOSE);
    return choice.selection?.source === "org"
      ? [{ row, modelId: choice.modelId, selection: choice.selection }]
      : [];
  });

  const templateProvider = seed.modelId.split("/")[0];
  const template = candidates.find((c) => c.modelId === seed.modelId);
  const picked =
    template ??
    candidates.find((c) => String(c.row.provider) === templateProvider) ??
    candidates[0];
  if (!picked) return { kind: "needs_model" };
  return {
    kind: "bound",
    input: {
      ...seed,
      modelId: picked.modelId,
      modelSelection: picked.selection,
    },
    row: picked.row,
    via: template ? "template" : "firstConfigured",
  };
}
