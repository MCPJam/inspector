import type { EvalCase, EvalSuite } from "../../evals/types";
import { loadCaseSteps } from "../../evals/load-case-steps";
import type { ExecutionPreviewInput } from "../case-steps/case-steps-model";
import {
  initialToolsChoice,
  readSimpleCase,
} from "../simple-case/simple-case-model";

/**
 * A saved case and its suite as the execution preview reads them: the same
 * fields the editor seeds its draft scorecard with, so a test run and the
 * editor list the same steps under the same keys.
 */
export function executionPreviewInputFor(
  testCase: EvalCase,
  suite: EvalSuite,
): ExecutionPreviewInput {
  const steps = loadCaseSteps(testCase);
  return {
    steps,
    toolsChoice: initialToolsChoice({
      tools: readSimpleCase(steps).tools,
      isNegativeTest: testCase.isNegativeTest,
    }),
    kind: testCase.kind,
    matchOptions: testCase.matchOptions,
    predicates: testCase.predicates,
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
    expectedOutput: testCase.expectedOutput,
    judgeConfigOverride: testCase.judgeConfigOverride,
    suiteDefaultMatchOptions: suite.defaultMatchOptions,
    suiteDefaultPredicates: suite.defaultPredicates ?? [],
    suiteJudgeConfig: suite.judgeConfig,
    suiteJudgeRubric: suite.judgeRubric,
  };
}
