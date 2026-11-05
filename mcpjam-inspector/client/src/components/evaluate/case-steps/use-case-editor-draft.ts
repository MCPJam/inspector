/**
 * Loads one test case (or starts a new one), holds the editor's draft of it,
 * and saves through `createTestCase` / `updateTestCase`. Saving fires
 * `eval_test_case_created` and `eval_test_case_edited`, the events the old
 * editor fires (`evals/test-template-editor.tsx`), with the same properties.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "sonner";
import { mintCaseId } from "@mcpjam/sdk/contract";
import {
  normalizeSteps,
  promptTurnsToSteps,
  resolvePromptTurnsWithLegacyProbe,
  type TestStep,
} from "@/shared/steps";
import { track } from "@/lib/analytics";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { DEFAULTS } from "@/components/evals/constants";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { getStepsBlockReason } from "@/components/evals/test-template-editor";
import {
  buildCreateCasePayload,
  buildUpdateCasePayload,
  type CaseEditorDraft,
} from "./case-save-payload";

const ANALYTICS_LOCATION = "case_steps_editor";
const FALLBACK_MODELS = [
  { provider: "anthropic", model: "anthropic/claude-haiku-4.5" },
];

const getTestSuiteRef = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalSuite | null
>("testSuites:getTestSuite");
const listTestCasesRef = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalCase[]
>("testSuites:listTestCases");
const createTestCaseRef = makeFunctionReference<
  "mutation",
  ReturnType<typeof buildCreateCasePayload>,
  string
>("testSuites:createTestCase");
const updateTestCaseRef = makeFunctionReference<
  "mutation",
  ReturnType<typeof buildUpdateCasePayload>,
  unknown
>("testSuites:updateTestCase");

function newCaseDraft(): CaseEditorDraft {
  return {
    title: "Untitled test case",
    steps: [{ id: "prompt-1", kind: "prompt", prompt: "" }],
  };
}

/** Stored steps, bridging a pre-steps case through the legacy resolver once. */
function loadSteps(testCase: EvalCase): TestStep[] {
  if (Array.isArray(testCase.steps) && testCase.steps.length > 0)
    return normalizeSteps(testCase.steps);
  return promptTurnsToSteps(
    resolvePromptTurnsWithLegacyProbe(
      testCase as Parameters<typeof resolvePromptTurnsWithLegacyProbe>[0],
    ),
  );
}

function draftFromCase(testCase: EvalCase): CaseEditorDraft {
  return {
    title: testCase.title,
    steps: loadSteps(testCase),
    predicates: testCase.predicates,
    expectedOutput: testCase.expectedOutput,
    judgeConfigOverride: testCase.judgeConfigOverride,
    isNegativeTest: testCase.isNegativeTest,
  };
}

export type CaseEditorDraftState = ReturnType<typeof useCaseEditorDraft>;

/** `caseId` is `null` for a new case. */
export function useCaseEditorDraft(suiteId: string, caseId: string | null) {
  const canQuery = useActorCanQuery();
  const suite = useQuery(getTestSuiteRef, canQuery ? { suiteId } : "skip");
  const testCases = useQuery(listTestCasesRef, canQuery ? { suiteId } : "skip");
  const createTestCase = useMutation(createTestCaseRef);
  const updateTestCase = useMutation(updateTestCaseRef);

  const testCase = useMemo(
    () =>
      caseId ? (testCases?.find((item) => item._id === caseId) ?? null) : null,
    [caseId, testCases],
  );
  const [draft, setDraft] = useState<CaseEditorDraft | null>(() =>
    caseId ? null : newCaseDraft(),
  );
  const [baseline, setBaseline] = useState<string | null>(() =>
    caseId ? null : JSON.stringify(newCaseDraft()),
  );
  const [isSaving, setIsSaving] = useState(false);
  const loadedCaseId = useRef<string | null>(null);

  // Seed once per case: a later subscription tick must not wipe edits.
  useEffect(() => {
    if (!caseId || !testCase || loadedCaseId.current === caseId) return;
    loadedCaseId.current = caseId;
    const loaded = draftFromCase(testCase);
    setDraft(loaded);
    setBaseline(JSON.stringify(loaded));
  }, [caseId, testCase]);

  const isDirty = draft !== null && JSON.stringify(draft) !== baseline;
  const update = useCallback(
    (patch: Partial<CaseEditorDraft>) =>
      setDraft((current) => (current ? { ...current, ...patch } : current)),
    [],
  );

  /** Returns the saved case's id, or `null` when the save was refused. */
  const save = useCallback(async (): Promise<string | null> => {
    if (!draft || isSaving) return null;
    const blocked = getStepsBlockReason(draft.steps);
    if (blocked) {
      toast.error(blocked);
      return null;
    }
    setIsSaving(true);
    try {
      if (!caseId) {
        const models = collectUniqueModelsFromTestCases(testCases ?? []);
        const newId = await createTestCase(
          buildCreateCasePayload(draft, {
            suiteId,
            caseId: mintCaseId(),
            models: models.length > 0 ? models : FALLBACK_MODELS,
            runs: DEFAULTS.RUNS_PER_TEST,
          }),
        );
        track("eval_test_case_created", {
          location: ANALYTICS_LOCATION,
          suite_id: suiteId,
          test_case_id: newId,
          num_models: models.length || FALLBACK_MODELS.length,
          num_steps: draft.steps.length,
        });
        setBaseline(JSON.stringify(draft));
        toast.success("Test case created");
        return newId;
      }
      if (!testCase) return null;
      const payload = buildUpdateCasePayload(draft, testCase._id);
      await updateTestCase(payload);
      track("eval_test_case_edited", {
        location: ANALYTICS_LOCATION,
        suite_id: suiteId,
        test_case_id: testCase._id,
        num_models: testCase.models?.length ?? 0,
        num_steps: draft.steps.length,
        has_match_options: testCase.matchOptions != null,
        has_predicates: payload.predicates != null,
      });
      setBaseline(JSON.stringify(draft));
      toast.success("Changes saved");
      return testCase._id;
    } catch (error) {
      toast.error(
        getBillingErrorMessage(
          error,
          caseId
            ? "Couldn't save the test case. Try again."
            : "Couldn't create the test case. Try again.",
        ),
      );
      return null;
    } finally {
      setIsSaving(false);
    }
  }, [
    draft,
    isSaving,
    caseId,
    testCase,
    testCases,
    suiteId,
    createTestCase,
    updateTestCase,
  ]);

  return {
    suite,
    testCase,
    /** `undefined` while loading, `null` when the case is not in the suite. */
    status:
      testCases === undefined || suite === undefined
        ? ("loading" as const)
        : caseId && !testCase
          ? ("missing" as const)
          : ("ready" as const),
    draft,
    update,
    isDirty,
    isSaving,
    save,
  };
}
