/**
 * Pure reads behind the Test run page: one test case inside one suite run.
 *
 * A launch that used several models is several suite runs (one per target),
 * so the page lists the case's iterations per target and the address names
 * the target it shows (`?target=`).
 */
import type { Predicate } from "@/shared/eval-matching";
import {
  isWidgetAssertion,
  WIDGET_ASSERTION_LABELS,
  type AssertStep,
} from "@/shared/steps";
import { labelForInlineAssert } from "@/shared/predicate-kinds";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { caseViewModel } from "../case-workspace/case-view-model";
import type { CaseScorecardInput } from "../case-scorecard/case-scorecard-model";
import { isToolCalledWithAssert } from "../simple-case/simple-case-model";
import {
  buildRunResultsMatrix,
  cellResult,
  resultCounts,
  type RunResultsMatrixData,
} from "../run-results-matrix-model";

export type TestRunTarget = RunResultsMatrixData["targets"][number];

/**
 * The launch's targets, each holding only this case's iterations.
 *
 * `iterations` are the case's rows across the launch's runs. A target with no
 * row yet still appears, so a run in flight shows the model it is waiting on.
 */
export function testRunTargets({
  run,
  runs,
  iterations,
  hostNamesById = new Map(),
}: {
  run: EvalSuiteRunListItem;
  runs: readonly EvalSuiteRunListItem[];
  iterations: readonly EvalIteration[];
  hostNamesById?: ReadonlyMap<string, string | null>;
}): TestRunTarget[] {
  return buildRunResultsMatrix({ run, runs, iterations, hostNamesById })
    .targets;
}

/** The target the address names, or the first one when it names none we have. */
export function selectTestRunTarget(
  targets: readonly TestRunTarget[],
  target: string | undefined,
): TestRunTarget | null {
  return (
    (target && targets.find((item) => item.targetKey === target)) ||
    targets[0] ||
    null
  );
}

export function caseIterations(
  target: TestRunTarget,
  testCaseId: string,
): EvalIteration[] {
  return target.cells.get(testCaseId) ?? [];
}

export type TestRunVerdict = {
  word: string;
  tone: "passed" | "failed" | "pending" | "muted";
  passed: number;
  total: number;
};

/** "Failed · 5/8 iterations passed", over every target's iterations. */
export function testRunVerdict(
  iterations: readonly EvalIteration[],
): TestRunVerdict {
  const counts = resultCounts(iterations);
  const result = cellResult(iterations);
  const base = { passed: counts.passed, total: iterations.length };
  switch (result) {
    case "passed":
      return { ...base, word: "Passed", tone: "passed" };
    case "failed":
      return { ...base, word: "Failed", tone: "failed" };
    case "pending":
      return { ...base, word: "In progress", tone: "pending" };
    case "cancelled":
      return { ...base, word: "Cancelled", tone: "muted" };
    default:
      return { ...base, word: "No iterations yet", tone: "muted" };
  }
}

/**
 * The case as it reads now, with its suite, as the scorecard model's input.
 * Built the way the case editor builds it, so the preview and the editor
 * number and order the same steps.
 */
export function caseScorecardInput(
  testCase: EvalCase,
  suite: Pick<
    EvalSuite,
    "defaultMatchOptions" | "defaultPredicates" | "judgeConfig" | "judgeRubric"
  > | null,
): CaseScorecardInput {
  const view = caseViewModel("draft", testCase);
  return {
    numbering: "action",
    steps: view.steps,
    toolsChoice: view.steps.some(isToolCalledWithAssert)
      ? "tools"
      : testCase.isNegativeTest
        ? "noTool"
        : "unset",
    kind: testCase.kind,
    matchOptions: testCase.matchOptions,
    suiteDefaultMatchOptions: suite?.defaultMatchOptions,
    predicates: testCase.predicates,
    suiteDefaultPredicates: (suite?.defaultPredicates ?? []) as Predicate[],
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
    expectedOutput: testCase.expectedOutput,
    judgeConfigOverride: testCase.judgeConfigOverride,
    suiteJudgeConfig: suite?.judgeConfig,
    suiteJudgeRubric: suite?.judgeRubric,
  };
}

/** One line for an assertion in the execution preview: `Tool was called with "read_me"`. */
export function previewAssertionLabel(step: AssertStep): string {
  const assertion = step.assertion;
  if (isWidgetAssertion(assertion)) {
    return WIDGET_ASSERTION_LABELS[assertion.kind];
  }
  const label = labelForInlineAssert(assertion.type).replace(/…$/, "");
  const toolName =
    "toolName" in assertion && typeof assertion.toolName === "string"
      ? assertion.toolName
      : "";
  return toolName && /\b(with|was)$/.test(label)
    ? `${label} “${toolName}”`
    : label;
}
