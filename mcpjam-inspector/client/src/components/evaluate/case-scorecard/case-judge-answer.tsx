/**
 * The judge's answer for the selected trial, and the one request that gets it.
 *
 * Lives in its own component so `useGoalCompletion` is called unconditionally
 * against one run, and so the request rule sits next to the row that shows its
 * result.
 *
 * The request is deliberately narrow. It fires once per run, only for a run
 * this page launched, only when the run has finished, only when the suite's
 * judge is enabled, and only when `autoRun` is off — with `autoRun` on the
 * backend already asked at terminalization and asking again is refused as a
 * conflict. It is a model call the user did not explicitly click, so anything
 * looser would spend on their behalf repeatedly.
 */

import { useEffect, useRef, type ReactNode } from "react";
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
  shouldRequest,
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
  /**
   * Whether this page launched the run and still owes it a judge request.
   * False for a run opened from History — grading someone else's run from a
   * page the user is only reading would spend without an action.
   */
  shouldRequest: boolean;
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
  const requestedRef = useRef<Set<string>>(new Set());

  const judgeConfig = run?.configSnapshot?.judgeConfig?.goalCompletion;
  const enabled = judgeConfig?.enabled !== false;
  const autoRun = judgeConfig?.autoRun === true;
  const threshold =
    judgeConfig?.threshold ?? GOAL_COMPLETION_DEFAULTS.threshold;
  const gating = judgeConfig?.role === "gating";
  const status = run?.goalCompletionStatus;

  useEffect(() => {
    if (!shouldRequest || !run?._id) return;
    if (isQuickRun || skippedForCase || !enabled || autoRun) return;
    // Only a finished run can be judged; the backend refuses anything else.
    if (run.status !== "completed") return;
    if (status !== undefined) return;
    if (!canRequest) return;
    if (requestedRef.current.has(run._id)) return;
    requestedRef.current.add(run._id);
    requestGoalCompletion();
  }, [
    shouldRequest,
    run?._id,
    run?.status,
    status,
    isQuickRun,
    skippedForCase,
    enabled,
    autoRun,
    canRequest,
    requestGoalCompletion,
  ]);

  const judgeCase = resolveIterationJudge(iteration, run ? [run] : []);
  const state = judgeAnswerState({
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
        (judgeCase ? <JudgeVerdictPanel judgeCase={judgeCase} /> : null)}
    </JudgeAnswerRow>
  );
}
