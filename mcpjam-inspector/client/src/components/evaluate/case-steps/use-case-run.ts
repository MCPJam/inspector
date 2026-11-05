/**
 * Run one test case from the editor: a suite run narrowed to the case, the
 * same launch Evaluate's case page uses (`useEvalHandlers().handleRerun` with
 * `caseIds`). The editor stays open (O4); the launch toast gains an Open test
 * run action that leads to the new test run.
 */

import { useCallback, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import type { EvalRoute } from "@/lib/eval-route-types";
import { getEvalIterationQuotaDisabledReason } from "@/lib/eval-iteration-quota";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useProjectServers } from "@/hooks/useProjects";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import { usePlanLimitDialogStore } from "@/stores/plan-limit-dialog-store";
import { useEvalHandlers } from "@/components/evals/use-eval-handlers";
import { useEvalMutations } from "@/components/evals/use-eval-mutations";
import type { EvalSuite } from "@/components/evals/types";

/** The test run a case launch created, for the toast's Open action. */
export function testRunRouteFor(
  suiteId: string,
  caseId: string,
  runIds: readonly string[],
): EvalRoute | null {
  const runId = runIds[0];
  return runId ? { type: "test-run", suiteId, runId, caseId } : null;
}

export function useCaseRun({
  suite,
  caseId,
  projectId,
  ensureServersReady,
  onOpenTestRun,
}: {
  suite: EvalSuite | null | undefined;
  caseId: string | null;
  projectId: string | null;
  ensureServersReady?: (
    serverNames: string[],
    options?: { allowInteractiveOAuthFlow?: boolean },
  ) => Promise<EnsureServersReadyResult>;
  onOpenTestRun: (route: EvalRoute) => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const { organizationId, connectedServerNames, availableModels } =
    useEvalTabContext({ isAuthenticated, projectId, isDirectGuest });
  const { quota } = useEvalIterationQuota({
    organizationId,
    enabled: Boolean(organizationId),
  });
  const disabledReason = useMemo(
    () => getEvalIterationQuotaDisabledReason(quota),
    [quota],
  );
  const { servers: projectServers } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const mutations = useEvalMutations({ isDirectGuest });
  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: null,
    selectedSuiteId: suite?._id ?? null,
    selectedTestId: caseId,
    projectId,
    organizationId,
    connectedServerNames,
    ensureServersReady,
    evalsNavigationContext: "evaluate",
    projectServers,
    isDirectGuest,
    availableModels,
  });
  const [isStarting, setIsStarting] = useState(false);

  const run = useCallback(
    async (options: { skipJudge?: boolean } = {}) => {
      if (!suite || !caseId || isStarting) return;
      if (disabledReason) {
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
        } else {
          toast.error(disabledReason);
        }
        return;
      }
      setIsStarting(true);
      try {
        const launch = await handlers.handleRerun(suite, {
          caseIds: [caseId],
          skipJudge: options.skipJudge,
        });
        const route = launch
          ? testRunRouteFor(suite._id, caseId, launch.runIds)
          : null;
        if (launch && route) {
          toast.success("Test run started.", {
            id: launch.toastId,
            action: {
              label: "Open test run",
              onClick: () => onOpenTestRun(route),
            },
          });
        }
      } finally {
        setIsStarting(false);
      }
    },
    [
      suite,
      caseId,
      isStarting,
      disabledReason,
      organizationId,
      quota,
      handlers,
      onOpenTestRun,
    ],
  );

  return {
    run,
    isStarting: isStarting || handlers.rerunningSuiteId === suite?._id,
    disabledReason,
  };
}
