import { useCallback } from "react";
import { useInsight } from "./use-insight";
import type { EvalSuiteRun } from "./types";

export interface GoalCompletionRunOverride {
  /** Per-run model override from the "⚙ Override for this run" disclosure. */
  judgeModel?: string;
  /** Per-run threshold override from the same disclosure. */
  threshold?: number;
}

export interface GoalCompletionRequestArgs {
  /**
   * Explicit per-run exploration override. Omit to clear any previously
   * persisted run override and grade against the suite-level config — the
   * card's default behavior. See `requestGoalCompletion` on the backend
   * for the clear-on-omit semantic.
   */
  runOverride?: GoalCompletionRunOverride;
}

/**
 * Request and track the Goal Completion judge (advisory LLM-as-judge that grades
 * each case's final answer against its expectedOutput). Thin wrapper around the
 * generic `useInsight` hook.
 *
 * `autoRequest: false` — this judge spends an LLM call, so it only runs when the
 * user explicitly clicks "Run judge".
 *
 * V2 arg shape (suite-as-authoritative-config): `requestGoalCompletion(
 * { runOverride? }, force?)`. The bare `{ judgeModel, threshold }` form is
 * gone — those fields now live on the suite (authoring) and run.configSnapshot
 * (snapshotted at run start). Callers passing only the override disclosure's
 * values can omit `runOverride` entirely to grade against the suite config;
 * the backend explicitly clears any previously persisted run override on
 * such a call, so re-running without re-confirming exploration returns to
 * the suite contract on its own.
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
      if (args.runOverride) {
        // Only include keys the user actually set so the backend doesn't see
        // `{ judgeModel: undefined }` (which would round-trip as an object with
        // explicit undefined fields through Convex's wire serialization).
        const cleaned: Record<string, unknown> = {};
        if (args.runOverride.judgeModel)
          cleaned.judgeModel = args.runOverride.judgeModel;
        if (typeof args.runOverride.threshold === "number")
          cleaned.threshold = args.runOverride.threshold;
        if (Object.keys(cleaned).length > 0) {
          extraArgs.runOverride = cleaned;
        }
      }
      hook.requestInsight(force, extraArgs);
    },
    // Depend on the stabilized `requestInsight` (memoized inside useInsight),
    // not the `hook` object literal — which is recreated every render and would
    // make this useCallback a no-op.
    [hook.requestInsight],
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
