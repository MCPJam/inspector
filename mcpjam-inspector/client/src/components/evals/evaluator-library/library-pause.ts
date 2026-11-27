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
        "Decision questions are paused while the goal-completion judge is off. Turn it on to run them.",
      judges:
        "Custom judges are paused while the goal-completion judge is off. Turn it on to run them.",
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
