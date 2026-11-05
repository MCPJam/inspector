import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useProjectServers } from "@/hooks/useViews";
import { useAppRouteContext } from "@/lib/app-route-context";
import type { EvalSuiteOverviewEntry } from "../../evals/types";
import { useEvalHandlers } from "../../evals/use-eval-handlers";
import { useEvalMutations } from "../../evals/use-eval-mutations";
import { toEmptyHeroServers } from "../evals-empty-hero";
import { useExcalidrawQuickstart } from "../use-excalidraw-quickstart";
import { useQuotaGuardedRerun } from "../use-quota-guarded-rerun";

/**
 * What the landing can do, from the same hooks today's Evaluate tab uses:
 * start a suite run behind the iteration quota, delete runs, and the empty
 * state's sample suite and server cards.
 */
export function useEvaluateLandingActions(
  projectId: string | null,
  suites: readonly EvalSuiteOverviewEntry[],
) {
  const { ensureServersReady, handleConnect } = useAppRouteContext();
  const { isAuthenticated } = useConvexAuth();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const {
    organizationId,
    connectedServerNames,
    canDeleteArtifact,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({ isAuthenticated, projectId, isDirectGuest });
  const { servers: projectServers = [], isLoading: serversLoading } =
    useProjectServers({ isAuthenticated, projectId });
  const mutations = useEvalMutations({ isDirectGuest });
  const latestRunBySuiteId = useMemo(
    () =>
      new Map(
        suites.map((entry) => [entry.suite._id, entry.latestRun ?? null]),
      ),
    [suites],
  );
  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry: null,
    selectedSuiteId: null,
    selectedTestId: null,
    projectId,
    organizationId,
    connectedServerNames,
    ensureServersReady,
    latestRunBySuiteId,
    evalsNavigationContext: "evaluate",
    projectServers,
    isDirectGuest,
    availableModels,
  });
  const run = useQuotaGuardedRerun({ organizationId, handlers });
  const quickstart = useExcalidrawQuickstart({
    projectId,
    handleConnect,
    suites,
    connectedServerNames,
    mutations,
  });
  const heroServers = useMemo(
    () => toEmptyHeroServers(projectServers),
    [projectServers],
  );

  return {
    run,
    rerunningSuiteId: handlers.rerunningSuiteId,
    deleteRun: canDeleteRuns ? handlers.directDeleteRun : undefined,
    canDeleteArtifact,
    quickstart,
    heroServers,
    serversLoading,
  };
}
