/**
 * Pure model behind the steps editor and the execution preview.
 *
 * Storage does not change: `testCase.steps` stays one flat, ordered list of
 * `prompt`, `toolCall`, `interact` and `assert` steps, and an assert grades
 * whatever precedes it. The editor shows that list as numbered steps with
 * their assertions nested underneath; `groupCaseSteps` is that view and
 * `flattenCaseSteps` is its exact inverse, so saving a grouped list writes
 * back the bytes it was read from.
 *
 * The grouping rule itself is `actionRows` in `shared/steps.ts` — the case
 * spine already uses it, and two copies of "which step does this assertion
 * grade" would drift. This module adds the editor's labels and the preview's
 * sections on top.
 */

import { filterSuppressedSuiteAssertions } from "@mcpjam/sdk/contract";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import {
  actionRows,
  type AssertStep,
  type InteractStep,
  type PromptStep,
  type TestStep,
  type ToolCallStep,
} from "@/shared/steps";

/** The three step kinds the editor numbers. Assertions nest under them. */
export type EditorStepKind = Exclude<TestStep["kind"], "assert">;

/** The one label per editor step kind. */
export const EDITOR_STEP_LABELS: Record<EditorStepKind, string> = {
  prompt: "User prompt",
  toolCall: "Tool call",
  interact: "Interact",
};

/** Section heading for case-level assertions graded over the finished run (DD1). */
export const AFTER_RUN_ASSERTIONS_LABEL = "After-run assertions";

/** An assert step and its position in the stored list. */
export type EditorAssertion = { step: AssertStep; index: number };

/** One numbered editor step and the assertions that grade it. */
export type EditorStep = {
  step: PromptStep | ToolCallStep | InteractStep;
  kind: EditorStepKind;
  label: string;
  /** 1-based among editor steps: the number the editor shows. */
  ordinal: number;
  /** Position of the step itself in the stored list. */
  index: number;
  /** The runner turn this step belongs to (an interact shares its turn). */
  turnIndex: number;
  assertions: EditorAssertion[];
};

export type GroupedCaseSteps = {
  /**
   * Assertions stored before any step (CLI-authored). The runner opens a turn
   * of their own for them, so nesting them under step 1 would claim they grade
   * that step when they do not. The editor shows them above step 1.
   */
  leadingAssertions: EditorAssertion[];
  steps: EditorStep[];
};

function isEditorStep(
  step: TestStep,
): step is PromptStep | ToolCallStep | InteractStep {
  return step.kind !== "assert";
}

/**
 * Group a flat step list into editor steps with nested assertions.
 *
 * INVARIANT (pinned by test): `flattenCaseSteps(groupCaseSteps(steps))`
 * returns `steps` — same steps, same order, same object references.
 */
export function groupCaseSteps(steps: TestStep[]): GroupedCaseSteps {
  const { leading, actions } = actionRows(steps);
  const grouped: EditorStep[] = [];
  for (const action of actions) {
    const { step } = action;
    // `actionRows` opens a block only for non-assert steps; the guard narrows.
    if (!isEditorStep(step)) continue;
    grouped.push({
      step,
      kind: step.kind,
      label: EDITOR_STEP_LABELS[step.kind],
      ordinal: action.ordinal,
      index: action.index,
      turnIndex: action.turnIndex,
      assertions: action.checks,
    });
  }
  return { leadingAssertions: leading, steps: grouped };
}

/** The stored list for a grouped view: leading assertions, then each block. */
export function flattenCaseSteps(grouped: GroupedCaseSteps): TestStep[] {
  return [
    ...grouped.leadingAssertions.map((assertion) => assertion.step),
    ...grouped.steps.flatMap((editorStep) => [
      editorStep.step,
      ...editorStep.assertions.map((assertion) => assertion.step),
    ]),
  ];
}

export type ExecutionPreviewInput = {
  steps: TestStep[];
  /** The case's assertion envelope (`testCase.predicates`). */
  predicates?: CasePredicates;
  /** `testCase.expectedOutput`: the sentence the judge grades against (O2). */
  expectedOutput?: string | null;
  /** The suite's default assertions. */
  suiteDefaultPredicates?: Predicate[];
  suppressedSuiteStandardCheckIds?: readonly string[];
};

export type ExecutionPreview = GroupedCaseSteps & {
  /** Case-level assertions, graded once over the finished transcript. */
  afterRunAssertions: { label: string; assertions: Predicate[] };
  /** Trimmed expected outcome, or `null` when the case has none. */
  expectedOutcome: string | null;
  suiteDefaultEvaluators: {
    /** Suite defaults that run for this case, after suppression. */
    assertions: Predicate[];
    /** Suite defaults this case replaced, and therefore does not run. */
    replacedCount: number;
  };
};

/**
 * Everything a run of this case will do, in the order the preview shows it:
 * numbered steps with their assertions, after-run assertions, the expected
 * outcome, then the suite's default evaluators.
 *
 * The split between after-run assertions and suite defaults follows
 * `resolveCasePredicates`: `inherit` (or no envelope) runs only the suite's
 * defaults and ignores any stored list, `extend` runs both, and `replace`
 * runs only the case's list. Together the two sections hold exactly the
 * assertions the runner will evaluate after the run (pinned by test).
 */
export function buildExecutionPreview(
  input: ExecutionPreviewInput,
): ExecutionPreview {
  const mode = input.predicates?.mode ?? "inherit";
  const caseList: Predicate[] =
    mode === "inherit" ? [] : (input.predicates?.list ?? []);
  const suiteDefaults = filterSuppressedSuiteAssertions(
    input.suiteDefaultPredicates ?? [],
    input.suppressedSuiteStandardCheckIds,
  );
  const replaced = mode === "replace";
  const expectedOutcome = input.expectedOutput?.trim() ?? "";
  return {
    ...groupCaseSteps(input.steps),
    afterRunAssertions: {
      label: AFTER_RUN_ASSERTIONS_LABEL,
      assertions: caseList,
    },
    expectedOutcome: expectedOutcome === "" ? null : expectedOutcome,
    suiteDefaultEvaluators: {
      assertions: replaced ? [] : suiteDefaults,
      replacedCount: replaced ? suiteDefaults.length : 0,
    },
  };
}
