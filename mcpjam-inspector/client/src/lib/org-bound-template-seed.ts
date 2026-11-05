/**
 * The model a client created from a catalog template starts on while the
 * organization requires its own provider keys. Pure and React-free.
 *
 * The template's model binds to an organization connection when available.
 * Otherwise the client keeps its template model until a person chooses an
 * organization model in its editor. Execution enforces the key policy.
 */
import type { ModelDefinition } from "@/shared/types";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { storedModelChoice } from "@/components/chat-v2/shared/model-selection";
import { harnessPickerModels } from "@/lib/harness-model-locks";
import { HOST_MODEL_SELECTION_PURPOSE } from "@/lib/host-model-selection";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";

export type OrgBoundTemplateSeed =
  | { kind: "unchanged"; input: HostConfigInputV2 }
  | { kind: "bound"; input: HostConfigInputV2 }
  | { kind: "needs_choice"; input: HostConfigInputV2 }
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

/** The next step for a client whose template model cannot use org keys. */
export function withModelChoiceNotice(
  message: string,
  needsModelChoice?: boolean,
): string {
  if (!needsModelChoice) return message;
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} Choose an organization model in the client's Agent tab before running it.`;
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
    const connection = choice.selection?.connectionRef;
    return choice.selection?.source === "org" && connection?.kind === "orgProvider"
      ? [{
          modelId: choice.modelId,
          selection: choice.selection,
          connectionId: connection.id,
        }]
      : [];
  });

  if (candidates.length === 0) return { kind: "needs_model" };
  const picked = candidates
    .filter((candidate) => candidate.modelId === seed.modelId)
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId))[0];
  if (!picked) return { kind: "needs_choice", input: seed };
  return {
    kind: "bound",
    input: {
      ...seed,
      modelId: picked.modelId,
      modelSelection: picked.selection,
    },
  };
}
