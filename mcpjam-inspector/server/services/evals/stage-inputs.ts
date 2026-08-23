/**
 * Build the analyzer's authored-case input from a runner `EvalTestCase`.
 *
 * `deriveStageResults` needs to know what the case ASSERTS before it reads a
 * single span, because that is the only way `notApplicable` is derivable — and
 * without it, a stage the case never exercised (a `selection` stage on a
 * model-free render probe, say) would be reported as an evidence gap that
 * someone is then asked to go and close.
 *
 * Every field here is INFERRED from what the case already declares. Authors
 * never toggle stages on or off, which is why this takes the case rather than
 * any new authoring surface.
 */

import {
  isAssertStep,
  isToolCallStep,
  isWidgetAssertion,
  type StageAuthoredCase,
  type TestStep,
} from "@mcpjam/sdk/contract";

/** The subset of `EvalTestCase` the stage inputs are inferred from. */
type StageCaseSource = {
  isNegativeTest?: boolean;
  expectedOutput?: string;
  expectedToolCalls?: readonly unknown[];
  successPredicates?: readonly unknown[];
  caseType?: string;
};

/** The subset of a per-turn summary the stage inputs are inferred from. */
type StageTurnSource = {
  expectedToolCalls?: readonly unknown[];
};

export function buildStageAuthoredCase(args: {
  test: StageCaseSource;
  /** Resolved authored steps, when the case has them. */
  steps?: readonly TestStep[];
  /** Authored turns (or the per-turn trace summaries, which mirror them). */
  turns?: readonly StageTurnSource[];
  /**
   * Whether any turn needs the model. A case with no model turn has nothing
   * that could CHOOSE a tool, so `selection` does not apply to it at all.
   */
  caseNeedsModel: boolean;
}): StageAuthoredCase {
  const steps = args.steps ?? [];
  const turns = args.turns ?? [];

  const expectsToolCall =
    (args.test.expectedToolCalls?.length ?? 0) > 0 ||
    turns.some((t) => (t.expectedToolCalls?.length ?? 0) > 0) ||
    steps.some(isToolCallStep);

  const assertSteps = steps.filter(isAssertStep);
  const expectsWidgetRender =
    args.test.caseType === "widget_probe" ||
    assertSteps.some((s) => isWidgetAssertion(s.assertion));

  // What could speak to "the user's actual request was satisfied": authored
  // predicates, an expected output to compare against, and assert steps.
  const assertionCount =
    (args.test.successPredicates?.length ?? 0) +
    (args.test.expectedOutput !== undefined ? 1 : 0) +
    assertSteps.length;

  return {
    mode: args.caseNeedsModel ? "model_driven" : "model_free",
    ...(args.test.isNegativeTest !== undefined
      ? { isNegativeTest: args.test.isNegativeTest }
      : {}),
    expectsToolCall,
    expectsWidgetRender,
    assertionCount,
  };
}
