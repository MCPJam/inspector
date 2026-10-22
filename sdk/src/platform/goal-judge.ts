import type { RequestedModelSelection } from "../host-config/model-selection.js";

/**
 * A goal's goal-completion judge as a read reports it: RESOLVED over the
 * managed defaults, the way `PlatformEvalSuiteGoalCompletionJudge` is, so it
 * is what a run would grade with.
 */
export interface PlatformGoalJudge {
  /** The judge is available on the goal. Grading happens with `autoRun`. */
  enabled: boolean;
  /**
   * Judge model id. COMPUTED from `modelSelection` when the goal stores one.
   * On a write, `mcpjam/<vendor>/<model>` names a hosted model.
   */
  model: string;
  /**
   * The judge's saved model choice (source, connection, effort), when the
   * goal stores one. May be a STORED legacy selection: "own key only". On a
   * write it must name `model` when both are sent; sent alone, it names the
   * model.
   */
  modelSelection?: RequestedModelSelection;
  /**
   * `"backfill"` when a conversion (not a person) chose `modelSelection`.
   * Read-only: a write may echo it back and it changes nothing.
   */
  modelSelectionOrigin?: "backfill";
  /** Grade every session as a run completes. SPENDS on each run. */
  autoRun: boolean;
  /** Advisory pass threshold (`passed = score >= threshold`), in [0, 1]. */
  threshold: number;
}

/**
 * A goal's judge on a write takes the keys a read returns, each optional, so
 * a read can be sent back. A create omitting the judge gets the managed
 * defaults, and an update moves only what it names. The API refuses a judge
 * with no field besides `modelSelectionOrigin`.
 */
export type PlatformGoalJudgeWrite = Partial<PlatformGoalJudge>;
