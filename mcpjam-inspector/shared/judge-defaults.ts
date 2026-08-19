/**
 * Resolved defaults for the goal-completion (LLM as Judge) grader.
 *
 * The AUTHORITY is the backend constant `GOAL_COMPLETION_DEFAULTS` in
 * mcpjam-backend `convex/lib/judgeConfig.ts` — its `resolveGoalCompletionConfig`
 * is what actually decides whether a run gets graded, with which model, and
 * against which threshold. This module is the inspector-side mirror, kept in
 * sync by hand per the two-repo layout: grep `GOAL_COMPLETION_DEFAULTS` across
 * both repos when one of these values moves.
 *
 * Deliberately ONE mirror for the whole inspector: the v1 suite DTO resolves
 * `settings.judge` through it (so the API never reports a half-resolved judge —
 * `enabled: true` with `model: null` is a combination that never exists at run
 * time), and the judge UI reads the same values to render the managed default
 * without a round-trip.
 */

/** Every field the backend resolver guarantees on a resolved judge config. */
export type ResolvedGoalCompletionConfig = {
  /** Judge is available on the suite. Does NOT by itself grade anything. */
  enabled: boolean;
  /** OpenRouter model id the grader runs on. */
  judgeModel: string;
  /** Advisory pass threshold (`passed = score >= threshold`), in [0, 1]. */
  threshold: number;
  /** The flag that makes grading HAPPEN: fire the judge as each run completes. */
  autoRun: boolean;
};

export const GOAL_COMPLETION_DEFAULTS: ResolvedGoalCompletionConfig = {
  enabled: true,
  judgeModel: "openai/gpt-5.4-mini",
  threshold: 0.7,
  autoRun: false,
};
