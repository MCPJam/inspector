import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import type { EvalSuiteRun } from "@/components/evals/types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { toast } from "@/lib/toast";

/** Mounted by the Evaluate tab for each run ID returned by Run test. */
export function LaunchedCaseJudge({ runId }: { runId: string }) {
  const run = useQuery("testSuites:getTestSuiteRun" as any, { runId }) as
    EvalSuiteRun | null | undefined;
  const request = useMutation("goalCompletion:requestGoalCompletion" as any);
  const requested = useRef(false);

  useEffect(() => {
    if (!run || run._id !== runId || requested.current) return;
    const config = run.configSnapshot?.judgeConfig?.goalCompletion;
    if (config?.enabled === false || config?.autoRun === true) return;
    if (run.status !== "completed" || run.goalCompletionStatus !== undefined)
      return;
    requested.current = true;
    request({ suiteRunId: runId }).catch((error: unknown) => {
      toast.error(
        getBillingErrorMessage(
          error,
          "Could not start the judge. Retry from the run.",
        ),
      );
    });
  }, [run, runId, request]);

  return null;
}
