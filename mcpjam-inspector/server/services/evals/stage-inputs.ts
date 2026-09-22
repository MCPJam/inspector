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
  isPositiveToolCallPredicateKind,
  isSelectionPredicateKind,
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

  const assertSteps = steps.filter(isAssertStep);

  /** The predicate `type` an assertion carries, when it is a transcript one. */
  const predicateKind = (assertion: unknown): string | undefined =>
    isWidgetAssertion(assertion as never)
      ? undefined
      : (assertion as { type?: unknown })?.type as string | undefined;

  const assertedPredicateKinds = [
    ...assertSteps.map((s) => predicateKind(s.assertion)),
    ...(args.test.successPredicates ?? []).map(predicateKind),
  ];

  // UVH-IN1. A case asserting "call tool X" expects a call just as surely as
  // one authoring `expectedToolCalls` does, and before this its assertion set
  // `call` to `notApplicable` — a stage the case plainly exercises reported as
  // one it does not.
  //
  // `toolNeverCalled` is deliberately NOT among them: a case whose only tool
  // assertion forbids a call expects none, and turning `call` on for it would
  // demand evidence of the very thing the case exists to rule out.
  const expectsToolCall =
    (args.test.expectedToolCalls?.length ?? 0) > 0 ||
    turns.some((t) => (t.expectedToolCalls?.length ?? 0) > 0) ||
    steps.some(isToolCallStep) ||
    assertedPredicateKinds.some(isPositiveToolCallPredicateKind);

  const expectsWidgetRender =
    args.test.caseType === "widget_probe" ||
    assertSteps.some((s) => isWidgetAssertion(s.assertion));

  // What could speak to "the user's actual request was satisfied": authored
  // predicates, an expected output to compare against, and assert steps.
  //
  // Tool-call assertions are EXCLUDED, because UVH-IN1 routes their results to
  // `selection`. Counting them here would leave `userValue` applicable with
  // nothing left to grade it, so a case whose only assertion is
  // "never call the admin tool" would report a permanent `notMeasured`
  // user-value gap that no author could ever close.
  const gradesUserValue = (kind: string | undefined) =>
    !isSelectionPredicateKind(kind);

  const assertionCount =
    (args.test.successPredicates ?? []).filter((p) =>
      gradesUserValue(predicateKind(p))
    ).length +
    (args.test.expectedOutput !== undefined ? 1 : 0) +
    assertSteps.filter((s) => gradesUserValue(predicateKind(s.assertion)))
      .length;

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
