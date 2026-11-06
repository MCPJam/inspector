/**
 * The case the editor works on: the stored row and suite, the draft seeded
 * from them, dirty state, and Save. A New case (testCaseId null) is a blank
 * draft that nothing writes until Save case.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { mintCaseId } from "@mcpjam/sdk/contract";
import { track } from "@/lib/analytics";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  buildCaseSavePayload,
  buildDraftTestCase,
  useCaseSaveMutations,
} from "@/components/evals/case-save-payload";
import {
  CASE_SAVE_FAILURE_MESSAGE,
  refuseCaseSave,
  refuseInvalidCaseSave,
} from "@/components/evals/case-save-feedback";
import { getStepsBlockReason } from "@/components/evals/test-template-editor";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import type { Predicate } from "@/shared/eval-matching";
import {
  buildCaseScorecard,
  type CaseScorecard,
} from "../case-scorecard/case-scorecard-model";
import type { ExecutionPreviewInput } from "./case-steps-model";
import type { CaseStepsDraft, DraftEdit } from "./case-step-edits";
import {
  blankCaseStepsDraft,
  isCaseStepsDirty,
  seedCaseStepsDraft,
} from "./case-steps-seed";
import { useCaseChecksAutosave } from "./use-case-checks-autosave";

const LOCATION = "case_steps_editor";

export function useCaseStepsDraft({
  suiteId,
  testCaseId,
}: {
  suiteId: string;
  /** null = New case */
  testCaseId: string | null;
}) {
  const canQuery = useActorCanQuery();
  const suite = useQuery(
    "testSuites:getTestSuite" as never,
    canQuery ? ({ suiteId } as never) : "skip",
  ) as EvalSuite | null | undefined;
  const testCases = useQuery(
    "testSuites:listTestCases" as never,
    canQuery ? ({ suiteId } as never) : "skip",
  ) as EvalCase[] | undefined;
  const capabilities = useSuiteCapabilities(suiteId).capabilities;
  const { updateTestCase, createTestCase } = useCaseSaveMutations();

  const testCase = useMemo(
    () =>
      testCaseId
        ? (testCases?.find((item) => item._id === testCaseId) ?? null)
        : null,
    [testCases, testCaseId],
  );
  const loaded = suite !== undefined && testCases !== undefined;
  const status: "loading" | "ready" | "missing" = !loaded
    ? "loading"
    : !suite || (testCaseId !== null && !testCase)
      ? "missing"
      : "ready";

  const [draft, setDraftState] = useState<CaseStepsDraft | null>(null);
  const [invalidField, setInvalidField] = useState(false);
  const seededFor = useRef<string | null>(null);
  // Re-seed only when the case changes, never on a live update mid-edit.
  const seedKey = testCaseId ?? (loaded ? "new" : null);
  useEffect(() => {
    if (!seedKey || seededFor.current === seedKey) return;
    if (testCaseId && !testCase) return;
    seededFor.current = seedKey;
    if (testCase) setDraftState(seedCaseStepsDraft(testCase));
    else {
      const blank = buildDraftTestCase("draft:prompt", testCases);
      setDraftState(blankCaseStepsDraft(blank.title, blank.runs));
    }
  }, [seedKey, testCaseId, testCase, testCases]);

  const setDraft = useCallback((update: DraftEdit) => {
    setDraftState((current) => (current ? update(current) : current));
  }, []);

  const readOnly =
    isCiOwnedSuite(suite ?? null) || capabilities?.ownership?.ciOwned === true;
  const dirty = Boolean(draft && testCase && isCaseStepsDirty(draft, testCase));

  const previewInput = useMemo<ExecutionPreviewInput | null>(
    () =>
      draft && suite
        ? {
            steps: draft.steps,
            toolsChoice: draft.toolsChoice,
            kind: draft.kind,
            matchOptions: draft.matchOptions,
            suiteDefaultMatchOptions: suite.defaultMatchOptions,
            predicates: draft.predicates,
            suiteDefaultPredicates: (suite.defaultPredicates ??
              []) as Predicate[],
            suppressedSuiteStandardCheckIds:
              draft.suppressedSuiteStandardCheckIds,
            expectedOutput: draft.expectedOutput,
            judgeConfigOverride: draft.judgeConfigOverride,
            suiteJudgeConfig: suite.judgeConfig,
            judgePolicy: capabilities?.judges?.goalCompletion.policy,
            suiteJudgeRubric: suite.judgeRubric,
          }
        : null,
    [draft, suite, capabilities],
  );
  const card = useMemo<CaseScorecard | null>(
    () =>
      previewInput
        ? buildCaseScorecard({ ...previewInput, numbering: "action" })
        : null,
    [previewInput],
  );

  const save = async (
    opts: { quiet?: boolean } = {},
  ): Promise<{ ok: boolean; testCaseId?: string }> => {
    const quiet = opts.quiet ?? false;
    if (!draft || readOnly || !suite) return { ok: false };
    if (invalidField) {
      refuseCaseSave("Complete the highlighted fields before saving.", quiet);
      return { ok: false };
    }
    const blocked = getStepsBlockReason(draft.steps);
    if (blocked) {
      refuseInvalidCaseSave(blocked, quiet);
      return { ok: false };
    }
    const payload = buildCaseSavePayload(draft, {
      isNegativeTest: draft.toolsChoice === "noTool",
    });
    const numSteps = draft.steps.length;
    if (!testCaseId) {
      const models = buildDraftTestCase("draft:prompt", testCases).models;
      try {
        const newId = await createTestCase({
          suiteId,
          models,
          caseId: mintCaseId(),
          ...payload,
        });
        track("eval_test_case_created", {
          location: LOCATION,
          suite_id: suiteId,
          test_case_id: newId,
          num_models: models.length,
          num_steps: numSteps,
        });
        toast.success("Test case created");
        return { ok: true, testCaseId: newId };
      } catch (error) {
        toast.error(
          getBillingErrorMessage(error, "Failed to create test case"),
        );
        return { ok: false };
      }
    }
    try {
      await updateTestCase({
        testCaseId,
        ...payload,
        matchOptions: payload.matchOptions ?? null,
        predicates: payload.predicates ?? null,
        judgeConfigOverride: payload.judgeConfigOverride ?? null,
      });
      track("eval_test_case_edited", {
        location: LOCATION,
        suite_id: suiteId,
        test_case_id: testCaseId,
        num_models: testCase?.models?.length ?? 0,
        num_steps: numSteps,
        has_match_options: payload.matchOptions != null,
        has_predicates: payload.predicates != null,
      });
      if (!quiet) toast.success("Changes saved");
      return { ok: true, testCaseId };
    } catch (error) {
      refuseCaseSave(
        getBillingErrorMessage(error, CASE_SAVE_FAILURE_MESSAGE),
        quiet,
      );
      return { ok: false };
    }
  };

  const autosave = useCaseChecksAutosave({
    testCaseId,
    draft,
    readOnly,
    updateTestCase,
  });

  return {
    status,
    suite: suite ?? undefined,
    testCase,
    draft,
    setDraft,
    dirty,
    readOnly,
    card,
    previewInput,
    capabilities,
    save,
    saveChecks: autosave.saveChecks,
    checksSaveStatus: autosave.checksSaveStatus,
    setInvalidField,
  };
}
