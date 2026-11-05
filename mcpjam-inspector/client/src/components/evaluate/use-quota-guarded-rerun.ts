import { useCallback, useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import { getEvalIterationQuotaDisabledReason } from "@/lib/eval-iteration-quota";
import { usePlanLimitDialogStore } from "@/stores/plan-limit-dialog-store";
import type { useEvalHandlers } from "../evals/use-eval-handlers";

type EvalHandlers = ReturnType<typeof useEvalHandlers>;

/**
 * Starting runs on Evaluate behind the org's eval iteration quota. A blocked
 * Run opens the plan limit dialog (a toast when there is no org to upgrade).
 * Case-scoped launches are collected in `judgeRunIds` so the page can mount a
 * `LaunchedCaseJudge` for each.
 */
export function useQuotaGuardedRerun({
  organizationId,
  handlers,
}: {
  organizationId: string | null | undefined;
  handlers: Pick<EvalHandlers, "handleRerun" | "handleRunTestCase">;
}) {
  const { quota } = useEvalIterationQuota({
    organizationId,
    enabled: Boolean(organizationId),
  });
  const disabledReason = useMemo(
    () => getEvalIterationQuotaDisabledReason(quota),
    [quota],
  );

  const guard = useCallback(() => {
    if (!disabledReason) {
      return true;
    }
    // The user just clicked Run — highest-intent moment there is. Give them a
    // decision surface instead of a dismissible error. Falls back to the
    // toast when we can't resolve the org (nothing to upgrade).
    if (organizationId && quota) {
      usePlanLimitDialogStore.getState().open({
        kind: "evalIterations",
        organizationId,
        used: quota.used,
        allowed: quota.allowed,
        resetsAt: quota.resetsAt,
        windowKind: quota.windowKind,
        origin: "evals",
      });
      return false;
    }
    toast.error(disabledReason);
    return false;
  }, [quota, disabledReason, organizationId]);

  const [judgeRunIds, setJudgeRunIds] = useState<string[]>([]);
  const { handleRerun, handleRunTestCase } = handlers;
  const rerun = useCallback(
    async (...args: Parameters<EvalHandlers["handleRerun"]>) => {
      if (!guard()) {
        if (args[1]?.throwOnFailure)
          throw new Error(disabledReason ?? "Eval iteration limit reached.");
        return;
      }
      const launch = await handleRerun(...args);
      if (
        args[1]?.caseIds?.length &&
        !args[1]?.skipJudge &&
        launch?.runIds.length
      ) {
        setJudgeRunIds((current) => [
          ...new Set([...current, ...launch.runIds]),
        ]);
      }
      return launch;
    },
    [guard, handleRerun, disabledReason],
  );

  const runTestCase = useCallback(
    (...args: Parameters<EvalHandlers["handleRunTestCase"]>) => {
      if (!guard()) {
        return Promise.resolve(null);
      }
      return handleRunTestCase(...args);
    },
    [guard, handleRunTestCase],
  );

  return { quota, disabledReason, guard, rerun, runTestCase, judgeRunIds };
}
