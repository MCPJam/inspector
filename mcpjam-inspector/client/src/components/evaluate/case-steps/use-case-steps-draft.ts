/**
 * The steps editor's draft of one case, and its Save.
 *
 * Save creates the case through `createTestCase` the first time and updates
 * it through `updateTestCase` after that, firing the same two events the old
 * editor fires.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "sonner";
import { mintCaseId } from "@mcpjam/sdk/contract";
import { track } from "@/lib/analytics";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { CASE_SAVE_FAILURE_MESSAGE } from "@/components/evals/case-save-feedback";
import type { EvalCase } from "@/components/evals/types";
import {
  caseSaveBlockReason,
  caseSavePayload,
  draftFromCase,
  draftsEqual,
  newCaseDefaults,
  newCaseDraft,
  type CaseStepsDraft,
} from "./case-steps-draft";

type SavePayload = ReturnType<typeof caseSavePayload>;

const createTestCaseRef = makeFunctionReference<
  "mutation",
  SavePayload & {
    suiteId: string;
    caseId: string;
    models: Array<{ model: string; provider: string }>;
    runs: number;
  },
  string
>("testSuites:createTestCase");

const updateTestCaseRef = makeFunctionReference<
  "mutation",
  Omit<SavePayload, "matchOptions" | "predicates" | "judgeConfigOverride"> & {
    testCaseId: string;
    // `null` clears a stored override; omitting it would keep the old one.
    matchOptions: SavePayload["matchOptions"] | null;
    predicates: SavePayload["predicates"] | null;
    judgeConfigOverride: CaseStepsDraft["judgeConfigOverride"] | null;
  },
  unknown
>("testSuites:updateTestCase");

/** Where the events say they came from, beside the old editor's location. */
const EVENT_LOCATION = "evaluate_case_steps_editor";

export type CaseStepsDraftState = {
  draft: CaseStepsDraft;
  update: (patch: Partial<CaseStepsDraft>) => void;
  dirty: boolean;
  /** The draft differs from what was loaded (a fresh New case is not edited). */
  edited: boolean;
  /** Drops the edits, back to what was loaded. */
  discard: () => void;
  saving: boolean;
  blockReason: string | null;
  /** Saves and returns the case id, or null when the save was refused. */
  save: () => Promise<string | null>;
};

export function useCaseStepsDraft({
  suiteId,
  testCase,
  suiteCases,
  onCreated,
}: {
  suiteId: string;
  /** Null for a new case. */
  testCase: EvalCase | null;
  suiteCases: EvalCase[];
  onCreated: (testCaseId: string) => void;
}): CaseStepsDraftState {
  const createTestCase = useMutation(createTestCaseRef);
  const updateTestCase = useMutation(updateTestCaseRef);
  const caseId = testCase?._id ?? null;
  const [baseline, setBaseline] = useState<CaseStepsDraft>(() =>
    testCase ? draftFromCase(testCase) : newCaseDraft(),
  );
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);

  // A different case (or New case after a save) starts a fresh draft. Edits
  // made elsewhere to the same case do not reset unsaved work here.
  const loadedCaseId = useRef(caseId);
  useEffect(() => {
    if (loadedCaseId.current === caseId) return;
    loadedCaseId.current = caseId;
    const next = testCase ? draftFromCase(testCase) : newCaseDraft();
    setBaseline(next);
    setDraft(next);
  }, [caseId, testCase]);

  const update = useCallback(
    (patch: Partial<CaseStepsDraft>) =>
      setDraft((current) => ({ ...current, ...patch })),
    [],
  );
  const edited = useMemo(
    () => !draftsEqual(draft, baseline),
    [draft, baseline],
  );
  const dirty = !testCase || edited;
  const discard = useCallback(() => setDraft(baseline), [baseline]);
  const blockReason = caseSaveBlockReason(draft);

  const save = useCallback(async (): Promise<string | null> => {
    if (saving) return null;
    if (blockReason) {
      toast.error(blockReason);
      return null;
    }
    const payload = caseSavePayload(draft);
    setSaving(true);
    try {
      if (!testCase) {
        const defaults = newCaseDefaults(suiteCases);
        const newId = await createTestCase({
          suiteId,
          caseId: mintCaseId(),
          ...defaults,
          ...payload,
        });
        track("eval_test_case_created", {
          location: EVENT_LOCATION,
          suite_id: suiteId,
          test_case_id: newId,
          num_models: defaults.models.length,
          num_steps: payload.steps.length,
        });
        toast.success("Test case created");
        setBaseline(draft);
        onCreated(newId);
        return newId;
      }
      await updateTestCase({
        testCaseId: testCase._id,
        ...payload,
        matchOptions: payload.matchOptions ?? null,
        predicates: payload.predicates ?? null,
        judgeConfigOverride: draft.judgeConfigOverride ?? null,
      });
      track("eval_test_case_edited", {
        location: EVENT_LOCATION,
        suite_id: suiteId,
        test_case_id: testCase._id,
        num_models: testCase.models?.length ?? 0,
        num_steps: payload.steps.length,
        has_match_options: payload.matchOptions != null,
        has_predicates: payload.predicates != null,
      });
      toast.success("Changes saved");
      setBaseline(draft);
      return testCase._id;
    } catch (error) {
      toast.error(getBillingErrorMessage(error, CASE_SAVE_FAILURE_MESSAGE));
      return null;
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    blockReason,
    draft,
    testCase,
    suiteCases,
    suiteId,
    createTestCase,
    updateTestCase,
    onCreated,
  ]);

  return { draft, update, dirty, edited, discard, saving, blockReason, save };
}
