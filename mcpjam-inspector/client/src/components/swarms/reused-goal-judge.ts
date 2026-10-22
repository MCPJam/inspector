import type {
  GoalCompletionJudgeSlot,
  GoalJudgeConfig,
} from "@/components/shared/session-quality/judge-config";

/**
 * The judge a REUSED goal is patched with when the swarm picked one on
 * Confirm.
 *
 * The Confirm picker only authors the judge MODEL, and
 * `journeys:updateJourney` replaces the goal-completion slot wholesale, so
 * sending the pick as is would reset the goal's own `enabled`, `autoRun`,
 * `threshold` and `role` to the managed defaults: a goal with grading off
 * would start spending again. The pick is layered onto the goal's own slot
 * instead. The goal's old selection and its conversion marker belong to the
 * old model and are dropped; the pick carries its own selection when it has
 * one. Slots other than goal completion are omitted, and the backend carries
 * an omitted slot forward.
 */
export function reusedGoalJudgeConfig(
  own: GoalJudgeConfig | undefined,
  picked: GoalJudgeConfig,
): GoalJudgeConfig {
  const ownSlot: GoalCompletionJudgeSlot & { judgeSelectionOrigin?: unknown } =
    own?.goalCompletion ?? {};
  const {
    judgeSelection: _oldSelection,
    judgeSelectionOrigin: _oldOrigin,
    ...ownSettings
  } = ownSlot;
  return {
    goalCompletion: { ...ownSettings, ...picked.goalCompletion },
  };
}
