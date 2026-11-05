import { useCallback } from "react";
import { toast } from "@/lib/toast";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  bindTemplateSeedToOrg,
  needsOrgModelMessage,
  type OrgBoundTemplateSeed,
} from "@/lib/org-bound-template-seed";

export type PreparedTemplateSeed = {
  input: HostConfigInputV2;
  /**
   * The organization model a new client starts on when it is not the
   * template's own, for the success message. Absent otherwise.
   */
  startedOn?: string;
};

/**
 * Binds catalog template seeds to the scoped project's organization models
 * while its key policy is on (see `bindTemplateSeedToOrg`). Every surface that
 * creates a client from a template goes through it.
 *
 * `ready` is false until the policy (and, under it, the selections capability)
 * has answered: before that the model list says the policy is off, and a
 * create would save the template's hosted model.
 */
export function useOrgBoundTemplateSeed(projectId: string | null): {
  ready: boolean;
  bind: (seed: HostConfigInputV2) => OrgBoundTemplateSeed;
  /**
   * `bind`, for a surface with a person in front of it: on `needs_model` it
   * shows the prompt and returns `null`, so the caller creates nothing.
   */
  prepare: (
    seed: HostConfigInputV2,
    label: string,
  ) => PreparedTemplateSeed | null;
} {
  const {
    availableModels,
    requireOrgKeys,
    modelSelectionsSupported,
    pending,
    onManageOrgProviders,
  } = useAvailableModels({ projectId });

  const bind = useCallback(
    (seed: HostConfigInputV2) =>
      bindTemplateSeedToOrg(seed, {
        requireOrgKeys,
        models: availableModels,
        selectionsSupported: modelSelectionsSupported,
      }),
    [availableModels, modelSelectionsSupported, requireOrgKeys],
  );

  const prepare = useCallback(
    (seed: HostConfigInputV2, label: string) => {
      const bound = bind(seed);
      if (bound.kind === "needs_model") {
        toast.error(
          needsOrgModelMessage(label, onManageOrgProviders !== undefined),
          onManageOrgProviders
            ? {
                action: {
                  label: "Open AI providers",
                  onClick: onManageOrgProviders,
                },
              }
            : undefined,
        );
        return null;
      }
      return bound.kind === "bound" && bound.via === "firstConfigured"
        ? {
            input: bound.input,
            startedOn:
              compactModelLabel(bound.row.name) || String(bound.row.id),
          }
        : { input: bound.input };
    },
    [bind, onManageOrgProviders],
  );

  return { ready: !pending, bind, prepare };
}
