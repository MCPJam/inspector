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
import { useEnsureAdhocEnvironments } from "@/hooks/useProjectEnvironments";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

export function useComposerResolver(projectId: string): (args: {
  state: EnvironmentComposerState;
  liveEnvironments: ProjectEnvironmentView[];
  max: number;
}) => Promise<ResolveComposerResult> {
  const ensureAdhocEnvironments = useEnsureAdhocEnvironments();
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();

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
      }),
    [
      computersEnabled,
      ensureAdhocEnvironments,
      projectId,
      skillsEnabled,
    ]
  );
}
