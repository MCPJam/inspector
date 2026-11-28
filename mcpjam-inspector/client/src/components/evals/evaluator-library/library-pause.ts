import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { judgeMode } from "../suite-grading-model";
import type { EvalJudgeConfig } from "../types";

// One wording per switch, wherever the suite shows it. Decision questions are
// rubric checks, so the Rubric checks row turns them on and off.
export const RUBRIC_CHECKS_GOAL_OFF_COPY =
  "Rubric checks, including decision questions, are paused while the goal-completion judge is off. Turn it on to run them.";
export const RUBRIC_CHECKS_OFF_COPY =
  "Rubric checks, including decision questions, are off for this suite. Turn on Rubric checks in the evaluators table to run them.";
export const CUSTOM_JUDGES_OFF_COPY =
  "Custom judges are off for this suite, so they will not run. Turn them on under Judges you write.";

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
      questions: RUBRIC_CHECKS_GOAL_OFF_COPY,
      judges:
        "Custom judges are paused while the goal-completion judge is off. Turn it on to run them.",
    };
  }
  return {
    ...(judgeConfig?.rubricChecks?.enabled === false
      ? { questions: RUBRIC_CHECKS_OFF_COPY }
      : {}),
    ...(judgeConfig?.customJudges?.enabled === false
      ? { judges: CUSTOM_JUDGES_OFF_COPY }
      : {}),
  };
}
