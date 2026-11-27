import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { judgeMode } from "../suite-grading-model";
import type { EvalJudgeConfig } from "../types";

/**
 * Why this suite will not run the decision questions or custom judges it
 * has, if it will not. Adding one never switches them back on, so every
 * place that adds one says so.
 */
export function libraryPauseMessages(
  judgeConfig: EvalJudgeConfig | undefined,
  capabilities: Pick<SuiteCapabilities, "judges"> | null | undefined,
): { questions?: string; judges?: string } {
  const goalOff =
    judgeMode(judgeConfig, capabilities?.judges?.goalCompletion?.policy) ===
    "off";
  if (goalOff) {
    return {
      questions:
        "Decision questions run on the iterations the goal-completion judge grades, so they are paused while that judge is off.",
      judges:
        "Custom judges run on the iterations the goal-completion judge grades, so they are paused while that judge is off.",
    };
  }
  return {
    ...(judgeConfig?.rubricChecks?.enabled === false
      ? {
          questions:
            "Rubric checks are off for this suite, so decision questions will not run. Turn rubric checks on in the evaluators table.",
        }
      : {}),
    ...(judgeConfig?.customJudges?.enabled === false
      ? { judges: "Custom judges are off for this suite, so they will not run." }
      : {}),
  };
}
