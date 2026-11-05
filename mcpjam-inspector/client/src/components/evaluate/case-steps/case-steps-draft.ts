/**
 * The steps editor's working copy of a case, and what Save sends.
 *
 * Only the fields the editor shows are held here. A save sends those and
 * leaves the rest of the case (models, runs, advanced config) to the backend,
 * which keeps any field the call omits.
 */

import {
  deriveExpectedToolCalls,
  deriveQuery,
  normalizeSteps,
  promptTurnsToSteps,
  resolvePromptTurnsWithLegacyProbe,
  newStepId,
  type TestStep,
} from "@/shared/steps";
import type { CasePredicates, EvalMatchOptions } from "@/shared/eval-matching";
import type {
  EvalCase,
  EvalJudgeConfigOverride,
  EvalSuite,
} from "@/components/evals/types";
import { DEFAULTS } from "@/components/evals/constants";
import { getStepsBlockReason } from "@/components/evals/test-template-editor";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import {
  initialToolsChoice,
  isToolCalledWithAssert,
  readSimpleCase,
  type CaseKind,
} from "../simple-case/simple-case-model";
import {
  buildCaseScorecard,
  type CaseScorecard,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";

export type CaseStepsDraft = {
  title: string;
  steps: TestStep[];
  /** The judge's goal sentence, stored in `expectedOutput` (plan O2). */
  expectedOutput: string;
  predicates?: CasePredicates;
  matchOptions?: EvalMatchOptions;
  suppressedSuiteStandardCheckIds?: string[];
  judgeConfigOverride?: EvalJudgeConfigOverride;
  kind?: CaseKind;
  /** As stored. The editor never infers it from the step shape. */
  isNegativeTest: boolean;
};

/**
 * Steps as stored, or bridged once from the legacy prompt turns of a case
 * written before `steps` existed. The same rule the old editor loads with.
 */
export function loadCaseSteps(testCase: EvalCase): TestStep[] {
  if (Array.isArray(testCase.steps) && testCase.steps.length > 0) {
    return normalizeSteps(testCase.steps);
  }
  return promptTurnsToSteps(
    resolvePromptTurnsWithLegacyProbe(
      testCase as Parameters<typeof resolvePromptTurnsWithLegacyProbe>[0],
    ),
  );
}

export function draftFromCase(testCase: EvalCase): CaseStepsDraft {
  return {
    title: testCase.title,
    steps: loadCaseSteps(testCase),
    expectedOutput: testCase.expectedOutput ?? "",
    predicates: testCase.predicates,
    matchOptions: testCase.matchOptions,
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
    judgeConfigOverride: testCase.judgeConfigOverride,
    kind: testCase.kind,
    isNegativeTest: testCase.isNegativeTest === true,
  };
}

export const NEW_CASE_TITLE = "Untitled test case";

/** A new case: one empty User prompt, ready for its first assertion. */
export function newCaseDraft(): CaseStepsDraft {
  return {
    title: NEW_CASE_TITLE,
    steps: [{ id: newStepId("prompt"), kind: "prompt", prompt: "" }],
    expectedOutput: "",
    isNegativeTest: false,
  };
}

/**
 * A negative case passes when the model calls no tool, so a required
 * "Tool was called with" assertion contradicts it. Adding one turns the flag
 * off; otherwise the stored answer stands.
 */
export function draftIsNegative(draft: CaseStepsDraft): boolean {
  return draft.isNegativeTest && !draft.steps.some(isToolCalledWithAssert);
}

/** The fields both `createTestCase` and `updateTestCase` take from the draft. */
export function caseSavePayload(draft: CaseStepsDraft) {
  const isNegativeTest = draftIsNegative(draft);
  const steps = draft.steps;
  const predicates =
    draft.predicates?.mode === "inherit"
      ? { ...draft.predicates, list: [] }
      : draft.predicates;
  return {
    title: draft.title.trim() || NEW_CASE_TITLE,
    // Display projections of `steps`; the runner reads `steps`.
    query: deriveQuery(steps),
    expectedToolCalls: isNegativeTest ? [] : deriveExpectedToolCalls(steps),
    // The judge's rubric. "" clears it: the backend keeps a field it is not
    // sent, and the judge treats "" as absent.
    expectedOutput: draft.expectedOutput.trim(),
    steps,
    isNegativeTest,
    matchOptions: draft.matchOptions,
    predicates,
    suppressedSuiteStandardCheckIds:
      draft.suppressedSuiteStandardCheckIds ?? [],
    ...(draft.judgeConfigOverride !== undefined
      ? { judgeConfigOverride: draft.judgeConfigOverride }
      : {}),
    ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
  };
}

/** What `createTestCase` needs beyond the draft: the models and run count. */
export function newCaseDefaults(suiteCases: EvalCase[]) {
  const collected = collectUniqueModelsFromTestCases(suiteCases);
  return {
    models:
      collected.length > 0
        ? collected
        : [{ provider: "anthropic", model: "anthropic/claude-haiku-4.5" }],
    runs: DEFAULTS.RUNS_PER_TEST,
  };
}

/** Why Save is refused, or null. Same rules the backend enforces. */
export function caseSaveBlockReason(draft: CaseStepsDraft): string | null {
  return getStepsBlockReason(draft.steps);
}

export function draftsEqual(a: CaseStepsDraft, b: CaseStepsDraft): boolean {
  return (
    JSON.stringify(caseSavePayload(a)) === JSON.stringify(caseSavePayload(b))
  );
}

/**
 * The draft's scorecard, numbered by action so its step numbers match the
 * editor's. The editor's after-run rows and the preview both read it.
 */
export function draftScorecard(
  draft: CaseStepsDraft,
  suite: Pick<
    EvalSuite,
    "defaultPredicates" | "defaultMatchOptions" | "judgeConfig" | "judgeRubric"
  >,
  judgePolicy?: CaseScorecardInput["judgePolicy"],
): CaseScorecard {
  return buildCaseScorecard({
    steps: draft.steps,
    toolsChoice: initialToolsChoice({
      tools: readSimpleCase(draft.steps).tools,
      isNegativeTest: draftIsNegative(draft),
    }),
    kind: draft.kind,
    matchOptions: draft.matchOptions,
    suiteDefaultMatchOptions: suite.defaultMatchOptions,
    predicates: draft.predicates,
    suiteDefaultPredicates: suite.defaultPredicates,
    suppressedSuiteStandardCheckIds: draft.suppressedSuiteStandardCheckIds,
    expectedOutput: draft.expectedOutput,
    judgeConfigOverride: draft.judgeConfigOverride,
    suiteJudgeConfig: suite.judgeConfig,
    judgePolicy,
    suiteJudgeRubric: suite.judgeRubric,
    numbering: "action",
  });
}
