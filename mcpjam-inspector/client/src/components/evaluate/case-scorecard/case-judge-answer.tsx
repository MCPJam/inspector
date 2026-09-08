/** The selected trial’s judge answer and explicit retry control. */

import type { ReactNode } from "react";
import type { EvalSuiteRun } from "@/components/evals/types";
import {
  resolveIterationJudge,
  JudgeVerdictPanel,
} from "@/components/evals/goal-completion-presentation";
import { useGoalCompletion } from "@/components/evals/use-goal-completion";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";
import { JudgeAnswerRow, judgeAnswerState } from "./judge-answer-row";

export function CaseJudgeAnswer({
  run,
  iteration,
  isQuickRun,
  skippedForCase,
  hidden = false,
  onOpenSuiteSettings,
  children,
}: {
  run: EvalSuiteRun | null;
  iteration:
    | {
        _id?: string;
        suiteRunId?: string | null;
        iterationNumber?: number;
        testCaseSnapshot?: { caseKey?: string } | null;
      }
    | null
    | undefined;
  isQuickRun: boolean;
  skippedForCase: boolean;
  /** True while a reviewer is labelling and has not revealed the verdict. */
  hidden?: boolean;
  onOpenSuiteSettings?: () => void;
  /**
   * The trial's judge panel — the review flow when a label is being taken,
   * the verdict panel otherwise. Passed in rather than chosen here, because
   * the blind-label protocol belongs to the caller that knows whether a
   * reviewer is active.
   */
  children?: ReactNode;
}) {
  const { requestGoalCompletion, canRequest } = useGoalCompletion(run);

  const judgeConfig = run?.configSnapshot?.judgeConfig?.goalCompletion;
  const enabled = judgeConfig?.enabled !== false;
  const threshold =
    run?.goalCompletion?.threshold ??
    judgeConfig?.threshold ??
    GOAL_COMPLETION_DEFAULTS.threshold;
  const gating = judgeConfig?.role === "gating";
  const status = run?.goalCompletionStatus;

  const judgeCase = resolveIterationJudge(iteration, run ? [run] : []);
  const state = judgeAnswerState({
    hidden,
    isQuickRun,
    judgeEnabledOnSuite: enabled,
    skippedForCase,
    runJudgeStatus: status,
    judgeCase,
    threshold,
    gating,
  });

  return (
    <JudgeAnswerRow
      state={state}
      onRetry={
        canRequest ? () => requestGoalCompletion(undefined, true) : undefined
      }
      onOpenSuiteSettings={onOpenSuiteSettings}
    >
      {children ??
        (judgeCase && !hidden ? (
          <JudgeVerdictPanel judgeCase={judgeCase} />
        ) : null)}
    </JudgeAnswerRow>
  );
}
