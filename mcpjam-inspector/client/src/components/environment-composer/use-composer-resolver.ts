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
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useModelMatrixCapability } from "@/hooks/use-model-matrix-capability";
import { useEnsureAdhocEnvironments } from "@/hooks/useProjectEnvironments";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { useHostHarnessLoader } from "@/hooks/use-host-harness-targets";

export function useComposerResolver(rawProjectId: string): (args: {
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
  const computersEnabled = useComputersEnabled();
  const modelMatrixEnabled = useModelMatrixCapability(projectId);
  // Read at resolve time, per client with explicit model picks, so a pair the
  // client's harness cannot run is skipped (and reported) instead of minted.
  const loadHostHarness = useHostHarnessLoader();

  return useCallback(
    ({ state, liveEnvironments, max }) =>
      resolveComposerEnvironments({
        projectId,
        state,
        liveEnvironments,
        ensureAdhocEnvironments,
        skillsEnabled,
        computersEnabled,
        max,
        modelMatrixEnabled: modelMatrixEnabled === true,
        loadHostHarness,
      }),
    [
      computersEnabled,
      ensureAdhocEnvironments,
      loadHostHarness,
      modelMatrixEnabled,
      projectId,
      skillsEnabled,
    ]
  );
}
