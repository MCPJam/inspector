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
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";

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
    /**
     * Whether this judge's verdict may DECIDE a trial, or only describe it.
     *
     * Absent means advisory, which is what every suite written before the gate
     * means — so a missing field can never be read as an accidental gate. The
     * backend refuses to store `gating` unless the suite is calibrated against
     * its current rubric and judge template, or an organization owner has
     * acknowledged the gap.
     *
     * Mirrors `goalCompletionConfigFieldsValidator` in the backend's
     * `convex/lib/judgeConfig.ts`. Deliberately absent from
     * `GoalJudgeConfigOverride` below: the backend admits no per-case role, and
     * a per-run override may only lower to `"advisory"`.
     */
    role?: "advisory" | "gating";
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
 *
 * Re-exported from `@/shared/judge-defaults` rather than re-typed here: the v1
 * suite DTO resolves `settings.judge` through the same mirror, so the API and
 * the UI cannot disagree about what "unset" means.
 */
export const MANAGED_DEFAULT_JUDGE_MODEL = GOAL_COMPLETION_DEFAULTS.judgeModel;
export const DEFAULT_JUDGE_THRESHOLD = GOAL_COMPLETION_DEFAULTS.threshold;
