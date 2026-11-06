/**
 * Test Case Evaluators saves each change as it is made. Saves run one at a
 * time, so a slower request cannot overwrite a newer edit, and a failed one
 * offers a retry. Same behaviour as today's editor (saveCaseChecks).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { areAllChecksValid } from "@/components/evals/checks-section";
import type {
  CaseSavePayload,
  UpdateTestCaseArgs,
} from "@/components/evals/case-save-payload";
import type { CaseStepsDraft } from "./case-step-edits";

export function useCaseChecksAutosave({
  testCaseId,
  draft,
  readOnly,
  updateTestCase,
}: {
  testCaseId: string | null;
  draft: CaseStepsDraft | null;
  readOnly: boolean;
  updateTestCase: (args: UpdateTestCaseArgs) => Promise<unknown>;
}) {
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    setStatus(null);
    return () => {
      // Toast actions can outlive this page or the case they were made for.
      revision.current += 1;
    };
  }, [testCaseId]);

  const saveChecks = (changes: Partial<CaseSavePayload>) => {
    if (readOnly || !testCaseId || !draft) return;
    const mine = ++revision.current;
    // A key present in `changes` wins even when undefined: that clears it.
    const predicates =
      "predicates" in changes ? changes.predicates : draft.predicates;
    const judgeConfigOverride =
      "judgeConfigOverride" in changes
        ? changes.judgeConfigOverride
        : draft.judgeConfigOverride;
    const payload: UpdateTestCaseArgs = {
      testCaseId,
      predicates: predicates ?? null,
      suppressedSuiteStandardCheckIds:
        changes.suppressedSuiteStandardCheckIds ??
        draft.suppressedSuiteStandardCheckIds ??
        [],
      judgeConfigOverride: judgeConfigOverride ?? null,
    };
    if (
      predicates &&
      predicates.mode !== "inherit" &&
      !areAllChecksValid(predicates.list)
    ) {
      setStatus("Complete the assertion fields to save your changes.");
      return;
    }
    const enqueue = (retry = false) => {
      if (mine !== revision.current) return;
      setStatus("Saving…");
      queue.current = queue.current
        .then(() => {
          if (retry && mine !== revision.current) return;
          return updateTestCase(payload);
        })
        .then(() => {
          if (mine === revision.current) setStatus(null);
        })
        .catch((error) => {
          if (mine !== revision.current) return;
          setStatus("Changes could not be saved. Edit again or retry.");
          toast.error(
            getBillingErrorMessage(
              error,
              "Could not save the evaluator changes.",
            ),
            { action: { label: "Retry", onClick: () => enqueue(true) } },
          );
        });
    };
    enqueue();
  };

  return { saveChecks, checksSaveStatus: status };
}
