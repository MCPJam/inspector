/**
 * What the steps editor sends to `createTestCase` and `updateTestCase`.
 *
 * The editor owns a case's title, steps, after-run assertions, expected
 * outcome and judge opt-out; every other field is left out of an update so
 * the backend keeps it. `query` and `expectedToolCalls` are display fields the
 * backend derives from `steps` on every write; a create still sends them
 * because the mutation requires `query`.
 */

import type { CasePredicates } from "@/shared/eval-matching";
import {
  deriveExpectedToolCalls,
  deriveQuery,
  type TestStep,
} from "@/shared/steps";
import type { EvalJudgeConfigOverride } from "@/components/evals/types";

export type CaseEditorDraft = {
  title: string;
  steps: TestStep[];
  predicates?: CasePredicates;
  expectedOutput?: string;
  judgeConfigOverride?: EvalJudgeConfigOverride;
  /** Suite defaults this case turns off (Test Case Evaluators). */
  suppressedSuiteStandardCheckIds?: string[];
  /** As stored; the editor has no control for it. */
  isNegativeTest?: boolean;
};

/**
 * The stored envelope. `inherit` runs only the suite's defaults, so a draft
 * list kept while the case inherits is dropped rather than validated.
 */
export function normalizeCasePredicates(
  predicates: CasePredicates | undefined,
): CasePredicates | undefined {
  if (!predicates) return undefined;
  return predicates.mode === "inherit"
    ? { ...predicates, list: [] }
    : predicates;
}

/** A case that asserts a tool call cannot also expect no tool calls. */
function resolveIsNegativeTest(draft: CaseEditorDraft): boolean {
  return deriveExpectedToolCalls(draft.steps).length > 0
    ? false
    : draft.isNegativeTest === true;
}

/** Fields both writes share. `""` clears the expected outcome (O2). */
function sharedFields(draft: CaseEditorDraft) {
  return {
    title: draft.title.trim() || "Untitled test case",
    steps: draft.steps,
    expectedOutput: draft.expectedOutput?.trim() ?? "",
    isNegativeTest: resolveIsNegativeTest(draft),
    suppressedSuiteStandardCheckIds:
      draft.suppressedSuiteStandardCheckIds ?? [],
  };
}

export function buildCreateCasePayload(
  draft: CaseEditorDraft,
  context: {
    suiteId: string;
    caseId: string;
    models: unknown[];
    runs: number;
  },
) {
  const predicates = normalizeCasePredicates(draft.predicates);
  return {
    suiteId: context.suiteId,
    caseId: context.caseId,
    models: context.models,
    runs: context.runs,
    ...sharedFields(draft),
    query: deriveQuery(draft.steps),
    expectedToolCalls: deriveExpectedToolCalls(draft.steps),
    ...(predicates ? { predicates } : {}),
    ...(draft.judgeConfigOverride
      ? { judgeConfigOverride: draft.judgeConfigOverride }
      : {}),
  };
}

/** `null` clears a stored override, matching the old editor's update call. */
export function buildUpdateCasePayload(
  draft: CaseEditorDraft,
  testCaseId: string,
) {
  return {
    testCaseId,
    ...sharedFields(draft),
    predicates: normalizeCasePredicates(draft.predicates) ?? null,
    judgeConfigOverride: draft.judgeConfigOverride ?? null,
  };
}
