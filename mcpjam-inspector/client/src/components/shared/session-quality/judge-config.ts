/**
 * Product-neutral goal-completion judge config — the client mirror of the
 * backend `judgeConfigValidator` (mcpjam-backend `convex/lib/judgeConfig.ts`).
 * Shared by Evals (suite-level) and Swarms (journey-level) so both surfaces
 * drive the same `JudgesSection` UI and the same backend grader. Kept in sync
 * with the backend validator by hand, per the two-repo layout.
 *
 * The envelope currently carries `goalCompletion` only, but is forward-
 * compatible with additional judges (refusal judge, etc.) without a second
 * pass on the type surface.
 */
export type GoalJudgeConfig = {
  goalCompletion?: {
    enabled?: boolean;
    judgeModel?: string;
    threshold?: number;
    /**
     * When true, the judge fires automatically as each run completes. Default
     * off so surfaces preserve cost-conscious behavior until they opt in.
     */
    autoRun?: boolean;
  };
};

/** Per-item judge override (per-case in Evals). Opt-out only in V1. */
export type GoalJudgeConfigOverride = {
  goalCompletion?: {
    enabled?: boolean;
  };
};

/** Per-run exploration override; persists on the run for transparency. */
export type GoalJudgeRunOverride = {
  goalCompletion?: {
    judgeModel?: string;
    threshold?: number;
  };
};

/**
 * Defaults mirror the backend `GOAL_COMPLETION_DEFAULTS`. The backend is the
 * authority; these exist so the UI can render the managed default without a
 * round-trip and select it explicitly.
 */
export const MANAGED_DEFAULT_JUDGE_MODEL = "openai/gpt-5.4-mini";
export const DEFAULT_JUDGE_THRESHOLD = 0.7;
