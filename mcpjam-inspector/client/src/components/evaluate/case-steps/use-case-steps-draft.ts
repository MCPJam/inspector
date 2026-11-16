/**
 * The saved case the editor works on: the stored row and suite, the draft
 * seeded from them, dirty state, and Save. Every edit, assertions included,
 * stays in the draft until Save.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  buildCaseUpdatePayload,
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
import type { CaseStepsDraft, DraftEdit } from "./case-step-edits";
import { isCaseStepsDirty, seedCaseStepsDraft } from "./case-steps-seed";

const LOCATION = "case_steps_editor";

export function useCaseStepsDraft({
  suiteId,
  testCaseId,
}: {
  suiteId: string;
  testCaseId: string;
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
  const { updateTestCase } = useCaseSaveMutations();

  const testCase = useMemo(
    () => testCases?.find((item) => item._id === testCaseId) ?? null,
    [testCases, testCaseId],
  );
  const status: "loading" | "ready" | "missing" =
    suite === undefined || testCases === undefined
      ? "loading"
      : !suite || !testCase
        ? "missing"
        : "ready";

  const [draft, setDraftState] = useState<CaseStepsDraft | null>(null);
  const [invalidField, setInvalidField] = useState(false);
  const seededFor = useRef<string | null>(null);
  // Re-seed only when the case changes, never on a live update mid-edit.
  useEffect(() => {
    if (!testCase || seededFor.current === testCaseId) return;
    seededFor.current = testCaseId;
    setDraftState(seedCaseStepsDraft(testCase));
  }, [testCaseId, testCase]);

  const setDraft = useCallback((update: DraftEdit) => {
    setDraftState((current) => (current ? update(current) : current));
  }, []);

  const readOnly =
    isCiOwnedSuite(suite ?? null) || capabilities?.ownership?.ciOwned === true;
  const dirty = Boolean(draft && testCase && isCaseStepsDirty(draft, testCase));

  const card = useMemo<CaseScorecard | null>(
    () =>
      draft && suite
        ? buildCaseScorecard({
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
            numbering: "action",
          })
        : null,
    [draft, suite, capabilities],
  );

  const save = async (
    opts: { quiet?: boolean } = {},
  ): Promise<{ ok: boolean }> => {
    const quiet = opts.quiet ?? false;
    if (!draft || !testCase || readOnly) return { ok: false };
    if (invalidField) {
      refuseCaseSave("Complete the highlighted fields before saving.", quiet);
      return { ok: false };
    }
    const blocked = getStepsBlockReason(draft.steps);
    if (blocked) {
      refuseInvalidCaseSave(blocked, quiet);
      return { ok: false };
    }
    const payload = buildCaseUpdatePayload(draft, {
      isNegativeTest: draft.toolsChoice === "noTool",
      storedAdvancedConfig: testCase.advancedConfig,
    });
    try {
      await updateTestCase({ testCaseId, ...payload });
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
    setInvalidField,
  };
}
