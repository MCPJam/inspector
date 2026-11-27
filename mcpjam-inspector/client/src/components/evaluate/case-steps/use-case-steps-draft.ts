/**
 * The case the editor works on: the stored row and suite, the draft seeded
 * from them, dirty state, and Save. Every edit, assertions included, stays in
 * the draft until Save. A New case (testCaseId null) starts blank, and its
 * Save creates the case.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { mintCaseId } from "@mcpjam/sdk/contract";
import {
  buildCaseSavePayload,
  buildCaseUpdatePayload,
  buildDraftTestCase,
  caseAccountsChanged,
  useCaseSaveMutations,
} from "@/components/evals/case-save-payload";
import {
  CASE_SAVE_FAILURE_MESSAGE,
  refuseCaseSave,
  refuseInvalidCaseSave,
} from "@/components/evals/case-save-feedback";
import { getStepsBlockReason } from "@/components/evals/test-template-editor";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { isModelFree } from "@/shared/steps";
import {
  caseHasOwnAssertion,
  isToolCalledWithAssert,
  resolveToolsQuestion,
  UNSET_TOOLS_BLOCK_REASON,
} from "../simple-case/simple-case-model";
import type { CaseScorecard } from "../case-scorecard/case-scorecard-model";
import type { CaseStepsDraft, DraftEdit } from "./case-step-edits";
import {
  blankCaseStepsDraft,
  isCaseStepsDirty,
  seedCaseStepsDraft,
} from "./case-steps-seed";
import { caseStepsScorecard } from "./case-steps-suite";

const LOCATION = "case_steps_editor";

type SaveResult = { ok: boolean; testCaseId?: string };

/**
 * A new positive case must assert something, or it passes vacuously and the
 * backend refuses it. Today's editor asks the same tool question.
 */
function newCaseBlockReason(draft: CaseStepsDraft): string | null {
  if (isModelFree(draft.steps)) return null;
  const question = resolveToolsQuestion({
    choice: draft.toolsChoice,
    hasToolAsserts: draft.steps.some(isToolCalledWithAssert),
    hasOwnAssertion: caseHasOwnAssertion(draft),
  });
  return question === "unset" ? UNSET_TOOLS_BLOCK_REASON : null;
}

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
  const { createTestCase, updateTestCase } = useCaseSaveMutations();

  const testCase = useMemo(
    () => testCases?.find((item) => item._id === testCaseId) ?? null,
    [testCases, testCaseId],
  );
  const status: "loading" | "ready" | "missing" =
    suite === undefined || testCases === undefined
      ? "loading"
      : !suite || (testCaseId !== null && !testCase)
        ? "missing"
        : "ready";

  const [draft, setDraftState] = useState<CaseStepsDraft | null>(null);
  const [invalidField, setInvalidField] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const seededFor = useRef<string | null>(null);
  const baseline = useRef<EvalCase | null>(null);
  // Seed when the case changes; a New case seeds a blank draft once. A live
  // update reseeds only a draft with no edits of its own, so edits are kept.
  const seedKey = testCaseId ?? (testCases ? `new:${suiteId}` : null);
  useEffect(() => {
    if (!seedKey || (testCaseId !== null && !testCase)) return;
    const before = baseline.current;
    baseline.current = testCase;
    if (seededFor.current !== seedKey) {
      seededFor.current = seedKey;
      if (testCase) setDraftState(seedCaseStepsDraft(testCase));
      else {
        const blank = buildDraftTestCase("draft:prompt", testCases);
        setDraftState(blankCaseStepsDraft(blank.title, blank.runs));
      }
    } else if (testCase && before && before !== testCase) {
      setDraftState((current) =>
        current && !isCaseStepsDirty(current, before)
          ? seedCaseStepsDraft(testCase)
          : current,
      );
    }
  }, [seedKey, testCaseId, testCase, testCases]);

  const setDraft = useCallback((update: DraftEdit) => {
    setDraftState((current) => (current ? update(current) : current));
  }, []);

  const readOnly =
    isCiOwnedSuite(suite ?? null) || capabilities?.ownership?.ciOwned === true;
  const dirty = useMemo(
    () =>
      Boolean(
        draft &&
        (testCase ? isCaseStepsDirty(draft, testCase) : testCaseId === null),
      ),
    [draft, testCase, testCaseId],
  );

  const card = useMemo<CaseScorecard | null>(
    () =>
      draft && suite
        ? caseStepsScorecard(
            draft,
            suite,
            capabilities?.judges?.goalCompletion.policy,
          )
        : null,
    [draft, suite, capabilities],
  );

  const saveDraft = async (quiet: boolean): Promise<SaveResult> => {
    if (!draft || readOnly) return { ok: false };
    if (invalidField) {
      refuseCaseSave("Complete the highlighted fields before saving.", quiet);
      return { ok: false };
    }
    const blocked =
      getStepsBlockReason(draft.steps) ??
      (testCaseId === null ? newCaseBlockReason(draft) : null);
    if (blocked) {
      refuseInvalidCaseSave(blocked, quiet);
      return { ok: false };
    }
    if (testCaseId === null) return create(draft, quiet);
    if (!testCase) return { ok: false };
    const payload = buildCaseUpdatePayload(draft, {
      isNegativeTest: draft.toolsChoice === "noTool",
      storedAdvancedConfig: testCase.advancedConfig,
    });
    try {
      await updateTestCase({
        testCaseId,
        ...payload,
        ...(caseAccountsChanged(draft, testCase) ? { accounts: draft.accounts } : {}),
      });
      track("eval_test_case_edited", {
        location: LOCATION,
        suite_id: suiteId,
        test_case_id: testCaseId,
        num_models: testCase.models?.length ?? 0,
        num_steps: draft.steps.length,
        has_match_options: payload.matchOptions !== null,
        has_predicates: payload.predicates !== null,
      });
      if (!quiet) toast.success("Changes saved");
      return { ok: true };
    } catch (error) {
      refuseCaseSave(
        getBillingErrorMessage(error, CASE_SAVE_FAILURE_MESSAGE),
        quiet,
      );
      return { ok: false };
    }
  };

  const create = async (
    form: CaseStepsDraft,
    quiet: boolean,
  ): Promise<{ ok: boolean; testCaseId?: string }> => {
    const models = buildDraftTestCase("draft:prompt", testCases).models;
    try {
      const newId = await createTestCase({
        suiteId,
        models,
        caseId: mintCaseId(),
        ...buildCaseSavePayload(form, {
          isNegativeTest: form.toolsChoice === "noTool",
        }),
      });
      track("eval_test_case_created", {
        location: LOCATION,
        suite_id: suiteId,
        test_case_id: newId,
        num_models: models.length,
        num_steps: form.steps.length,
      });
      if (!quiet) toast.success("Test case created");
      return { ok: true, testCaseId: newId };
    } catch (error) {
      refuseCaseSave(
        getBillingErrorMessage(
          error,
          "Could not create the test case. Try again.",
        ),
        quiet,
      );
      return { ok: false };
    }
  };

  /** One save at a time: a second click while one runs does nothing. */
  const save = async (opts: { quiet?: boolean } = {}): Promise<SaveResult> => {
    if (inFlight.current) return { ok: false };
    inFlight.current = true;
    setSaving(true);
    try {
      return await saveDraft(opts.quiet ?? false);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return {
    status,
    suite: suite ?? undefined,
    testCase,
    draft,
    setDraft,
    dirty,
    readOnly,
    card,
    capabilities,
    save,
    saving,
    invalidField,
    setInvalidField,
  };
}
