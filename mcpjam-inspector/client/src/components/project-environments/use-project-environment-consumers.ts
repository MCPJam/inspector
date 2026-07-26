import { useMemo } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * ADVISORY count of consumers referencing an environment, for the
 * archive-confirm dialog. No reverse index exists backend-side, so this is a
 * client scan of the suites the viewer can already see; journeys are not
 * scanned (their list query is persona-keyed). The dialog copy must say the
 * count "may be incomplete" — archiving while referenced is allowed by
 * design (consumers fail fast at their next launch).
 */
export function useProjectEnvironmentConsumers(
  projectId: string | null,
  environmentId: string | null
): { suiteCount: number | null } {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enableQuery =
    isAuthenticated &&
    isUserReady &&
    shouldQueryProjectId(projectId) &&
    !!environmentId;

  const overview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableQuery ? ({ projectId } as any) : "skip"
  ) as Array<{ suite?: { environmentIds?: string[] } }> | undefined;

  return useMemo(() => {
    if (!environmentId || overview === undefined) {
      return { suiteCount: null };
    }
    const suiteCount = overview.filter((entry) =>
      (entry.suite?.environmentIds ?? []).includes(environmentId)
    ).length;
    return { suiteCount };
  }, [overview, environmentId]);
}
