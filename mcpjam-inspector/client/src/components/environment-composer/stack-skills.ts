/**
 * The Skills pill's extra choices for one composer stack: the scope and the
 * MCP-server skills that a saved environment's stack carries, and a cap that
 * counts both. A stack is a suite of one environment, so each choice comes from
 * the rules the Evaluate field applies to its environments.
 *
 * Only what the stack carries is offered, so the strip can show it and turn it
 * off or remove it. Turning the scope on and picking server skills stay the
 * Evaluate field's.
 */
import {
  leftOutChange,
  scopeChange,
  serverChange,
  serverSkillState,
} from "@/components/evals/suite-skill-channels";
import {
  suiteSkillState,
  type SuiteSkillsChange,
  type SuiteSkillsSource,
} from "@/components/evals/suite-skills";
import type { SkillSelectionAcross } from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import type { AllLibraryChoice } from "@/components/project-environments/all-library-skills";
import type { ServerSkillsChoice } from "@/components/project-environments/server-skills-section";
import type { EnvironmentStack } from "./environment-stack";

export function stackSkillChoices(
  stack: EnvironmentStack,
  patch: (change: Partial<EnvironmentStack>) => void,
): {
  across?: SkillSelectionAcross;
  allLibrary?: AllLibraryChoice;
  serverSkills?: ServerSkillsChoice;
} {
  const row: SuiteSkillsSource = {
    ...stack,
    serverAttachmentId: stack.serverAttachmentId ?? undefined,
  };
  const apply = (change: SuiteSkillsChange | undefined) => {
    if (change) patch(change);
  };
  const serverCount = stack.serverSkillSelection?.serverSkillIds.length ?? 0;
  return {
    // The backend's 20 covers Library and server skills together.
    across: serverCount ? suiteSkillState([row]).across : undefined,
    allLibrary: stack.skillScope
      ? {
          state: true,
          serverSkillCount: serverCount,
          onToggle: (on) => apply(scopeChange(row, on)),
          onLeaveOut: (skillId, rest) =>
            apply(leftOutChange(row, skillId, rest)),
        }
      : undefined,
    serverSkills: serverCount
      ? {
          ...serverSkillState([row]),
          serverAttachmentIds: [stack.serverAttachmentId],
          onChange: (edit) => apply(serverChange(row, edit)),
        }
      : undefined,
  };
}
