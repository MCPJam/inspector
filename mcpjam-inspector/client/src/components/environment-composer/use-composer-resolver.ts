/**
 * React binding for {@link resolveComposerEnvironments}: wires the batch ad-hoc
 * mutation and the two slot flags so a surface only has to pass its own state.
 */
import { useCallback } from "react";
import {
  resolveComposerEnvironments,
  type ResolveComposerResult,
} from "@/components/environment-composer/resolve-stacks";
import type { EnvironmentComposerState } from "@/components/environment-composer/environment-stack";
import { useModelMatrixCapability } from "@/hooks/use-model-matrix-capability";
import { useModelSelectionsCapability } from "@/hooks/use-project-environment-capability";
import { useEnsureAdhocEnvironments } from "@/hooks/useProjectEnvironments";
import { useSandboxImagesEnabled } from "@/hooks/useSandboxImagesEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { useHostHarnessLoader } from "@/hooks/use-host-harness-targets";

export function useComposerResolver(
  rawProjectId: string,
  options: {
    /** Explicit selection is required for eval and swarm targets. */
    requireServerAttachment?: boolean;
    allowEmptyServerSelection?: boolean;
    /** User Testing: a client on the organization's vendor key can't run there. */
    refuseOrgKeyClients?: boolean;
  } = {},
): (args: {
  state: EnvironmentComposerState;
  liveEnvironments: ProjectEnvironmentView[];
  max: number;
}) => Promise<ResolveComposerResult> {
  // Trimmed to match `useProjectEnvironments`, which normalizes internally. A
  // padded id lists environments fine and then fails the mutation's id
  // validator, which reads as "compose is broken" rather than "bad id".
  const projectId = rawProjectId.trim();
  const ensureAdhocEnvironments = useEnsureAdhocEnvironments();
  const skillsEnabled = useSkillsEnabled();
  // An image pin rides `sandbox-images-enabled`, not `computers-enabled`.
  const sandboxImagesEnabled = useSandboxImagesEnabled();
  const modelMatrixEnabled = useModelMatrixCapability(projectId);
  const requireServerAttachment = options.requireServerAttachment === true;
  const allowEmptyServerSelection = options.allowEmptyServerSelection !== false;
  // Read at resolve time, per client with explicit model picks, so a pair the
  // client's harness cannot run is skipped (and reported) instead of minted.
  const loadHostHarness = useHostHarnessLoader();
  const modelSelectionsEnabled = useModelSelectionsCapability(projectId);
  const refuseOrgKeyClients = options.refuseOrgKeyClients === true;

  return useCallback(
    ({ state, liveEnvironments, max }) =>
      resolveComposerEnvironments({
        projectId,
        state,
        liveEnvironments,
        ensureAdhocEnvironments,
        skillsEnabled,
        computersEnabled: sandboxImagesEnabled,
        max,
        modelMatrixEnabled: modelMatrixEnabled === true,
        requireServerAttachment,
        allowEmptyServerSelection,
        loadHostHarness,
        modelSelectionsEnabled: modelSelectionsEnabled === true,
        refuseOrgKeyClients,
      }),
    [
      refuseOrgKeyClients,
      ensureAdhocEnvironments,
      loadHostHarness,
      modelMatrixEnabled,
      modelSelectionsEnabled,
      projectId,
      requireServerAttachment,
      allowEmptyServerSelection,
      sandboxImagesEnabled,
      skillsEnabled,
    ],
  );
}
