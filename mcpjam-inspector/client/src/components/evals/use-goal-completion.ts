import { useCallback } from "react";
import { useInsight } from "./use-insight";
import type { EvalSuiteRun } from "./types";

export interface GoalCompletionRequestArgs {
  /** User-selected judge model id. Omit to use the managed default. */
  judgeModel?: string;
  /** Advisory pass threshold in [0,1]. Omit to use the backend default (0.7). */
  threshold?: number;
}

/**
 * Request and track the Goal Completion judge (advisory LLM-as-judge that grades
 * each case's final answer against its expectedOutput). Thin wrapper around the
 * generic `useInsight` hook.
 *
 * `autoRequest: false` — this judge spends an LLM call, so it only runs when the
 * user explicitly clicks "Run judge".
 */
export function useGoalCompletion(run: EvalSuiteRun | null) {
  const hook = useInsight(
    run,
    {
      getStatus: (r) => r.goalCompletionStatus,
      getResult: (r) => r.goalCompletion,
      requestMutation: "goalCompletion:requestGoalCompletion",
      cancelMutation: "goalCompletion:cancelGoalCompletion",
    },
    { autoRequest: false },
  );

  const requestGoalCompletion = useCallback(
    (args: GoalCompletionRequestArgs = {}, force?: boolean) => {
      const extraArgs: Record<string, unknown> = {};
      if (args.judgeModel) {
        extraArgs.judgeModel = args.judgeModel;
      }
      if (typeof args.threshold === "number") {
        extraArgs.threshold = args.threshold;
      }
      hook.requestInsight(force, extraArgs);
    },
    [hook],
  );

  return {
    canRequest: hook.canRequest,
    error: hook.error,
    unavailable: hook.unavailable,
    requested: hook.requested,
    requestGoalCompletion,
    cancelGoalCompletion: hook.cancelInsight,
    summary: hook.summary,
    pending: hook.pending,
    failedGeneration: hook.failedGeneration,
    result: hook.result,
  };
}
