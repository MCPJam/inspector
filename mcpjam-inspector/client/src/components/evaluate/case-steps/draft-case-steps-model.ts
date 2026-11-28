/**
 * The steps editor's draft for a case not saved yet, and what its edits write
 * back: into Describe's form, or into a generated draft in the generation
 * store.
 */
import {
  buildCaseSavePayload,
  type CaseSaveForm,
} from "@/components/evals/case-save-payload";
import type { EvalCase } from "@/components/evals/types";
import type { CreateEvalTestCaseInput } from "@/lib/evals/generate-and-persist-tests";
import type { CaseStepsDraft } from "./case-step-edits";
import { seedCaseStepsDraft } from "./case-steps-seed";

/** The form fields the steps editor edits. Title, runs and models stay with the form. */
export function stepsFormFields(
  draft: CaseStepsDraft,
): Pick<
  CaseSaveForm,
  | "steps"
  | "expectedOutput"
  | "matchOptions"
  | "predicates"
  | "suppressedSuiteStandardCheckIds"
  | "judgeConfigOverride"
  | "advancedConfig"
> {
  return {
    steps: draft.steps,
    expectedOutput: draft.expectedOutput,
    matchOptions: draft.matchOptions,
    predicates: draft.predicates,
    suppressedSuiteStandardCheckIds: draft.suppressedSuiteStandardCheckIds,
    judgeConfigOverride: draft.judgeConfigOverride,
    advancedConfig: draft.advancedConfig,
  };
}

/** A generated draft holds a create body, which reads like a stored case. */
export function generatedDraftToSteps(
  input: CreateEvalTestCaseInput,
): CaseStepsDraft {
  return seedCaseStepsDraft({
    ...input,
    _id: "",
    testSuiteId: input.suiteId,
    createdBy: "",
  } as EvalCase);
}

/**
 * What a generated draft keeps of an edit, built the way a save builds it.
 * A generated draft stores no judge opt-out or tool error policy.
 */
export function generatedDraftPatch(draft: CaseStepsDraft) {
  const payload = buildCaseSavePayload(draft, {
    isNegativeTest: draft.toolsChoice === "noTool",
  });
  return {
    steps: payload.steps,
    expectedOutput: payload.expectedOutput,
    matchOptions: payload.matchOptions,
    predicates: payload.predicates,
    isNegativeTest: payload.isNegativeTest,
  };
}
