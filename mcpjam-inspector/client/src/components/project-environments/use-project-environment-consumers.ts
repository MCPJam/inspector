import { useMemo } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * ADVISORY counts of consumers referencing an environment, for the
 * archive-confirm dialog. No reverse index exists backend-side, so this is a
 * client scan of the suites AND journeys the viewer can already see. Each count
 * is independent: `null` means that source is still loading (or unscannable),
 * a number is a settled count. The dialog copy must say the counts "may be
 * incomplete" — archiving while referenced is allowed by design (consumers fail
 * fast at their next launch).
 */
export function useProjectEnvironmentConsumers(
  projectId: string | null,
  environmentId: string | null
): {
  suiteCount: number | null;
  journeyCount: number | null;
  /**
   * Published chatboxes backed by this environment (0 or 1 — backend-enforced
   * one-per-environment). Unlike the advisory suite/journey scans this one is
   * exact when settled: the chatbox list carries `environmentId` per row.
   */
  chatboxCount: number | null;
} {
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

  const journeys = useQuery(
    "journeys:listJourneysByProject" as any,
    enableQuery ? ({ projectId } as any) : "skip"
  ) as Array<{ environmentIds?: string[] | null }> | undefined;

  const chatboxes = useQuery(
    "chatboxes:listChatboxes" as any,
    enableQuery ? ({ projectId } as any) : "skip"
  ) as Array<{ environmentId?: string | null }> | undefined;

  return useMemo(() => {
    if (!environmentId) {
      return { suiteCount: null, journeyCount: null, chatboxCount: null };
    }
    const suiteCount =
      overview === undefined
        ? null
        : overview.filter((entry) =>
            (entry.suite?.environmentIds ?? []).includes(environmentId)
          ).length;
    const journeyCount =
      journeys === undefined
        ? null
        : journeys.filter((journey) =>
            (journey.environmentIds ?? []).includes(environmentId)
          ).length;
    const chatboxCount =
      chatboxes === undefined
        ? null
        : chatboxes.filter((chatbox) => chatbox.environmentId === environmentId)
            .length;
    return { suiteCount, journeyCount, chatboxCount };
  }, [overview, journeys, chatboxes, environmentId]);
}
