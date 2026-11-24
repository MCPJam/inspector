import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useRunsIterations } from "../evals/use-runs-iterations";
import { runGroupsQuery, type RunGroup } from "./climb-queries";
import type { Climb } from "./climb-types";
import type { PaneData } from "./pane-card";
import { iterationOf, planPanes, runIn } from "./round-panes-model";

export type PaneMode = "version" | "environment";

/**
 * The transcripts to compare for one case of one round: by version (baseline,
 * best so far, this change) in one environment, or this change in each
 * environment. Runs and iterations come from the backend as the person.
 */
export function useRoundPanes(input: {
  climbId: string;
  climb: Climb;
  roundNumber: number;
  caseKey: string | undefined;
  environmentId: string | undefined;
  mode: PaneMode;
  labels: Record<string, string>;
  bestSub: string;
}): { panes: PaneData[]; caseTitles: Record<string, string>; loading: boolean } {
  const { climbId, climb, roundNumber, caseKey, environmentId, mode, labels, bestSub } = input;
  const groups = useQuery(runGroupsQuery, { climbId }) as RunGroup[] | undefined;
  const plan = useMemo(() => planPanes(climb, roundNumber, groups ?? []), [climb, roundNumber, groups]);
  const { byRun, runsById, isLoading } = useRunsIterations(plan.runIds, plan.runIds.length > 0);
  const loading = groups === undefined || isLoading;

  return useMemo(() => {
    const caseTitles: Record<string, string> = {};
    for (const iterations of byRun.values()) {
      for (const iteration of iterations) {
        const key = iteration.testCaseId ?? iteration.testCaseSnapshot?.caseKey;
        if (key && iteration.testCaseSnapshot?.title) caseTitles[key] = iteration.testCaseSnapshot.title;
      }
    }
    const show = (runId: string | undefined) => (runId && caseKey ? iterationOf(byRun.get(runId), caseKey) : undefined);
    if (mode === "environment") {
      const panes = climb.environmentIds.map((id): PaneData => ({
        title: labels[id] ?? "Environment",
        sub: "This change",
        iteration: show(runIn(plan.candidate, id, runsById)),
        loading,
      }));
      return { panes, caseTitles, loading };
    }
    const env = environmentId ?? climb.environmentIds[0] ?? "";
    const panes: PaneData[] = [
      { letter: "A", title: "Baseline", sub: labels[env] ?? "Environment", iteration: show(runIn(plan.baseline, env, runsById)), loading },
      ...(plan.bestIsBaseline
        ? []
        : [{ letter: "B", title: "Best so far", sub: bestSub, iteration: show(runIn(plan.best, env, runsById)), loading }]),
      { letter: plan.bestIsBaseline ? "B" : "C", title: "This change", sub: labels[env] ?? "Environment", iteration: show(runIn(plan.candidate, env, runsById)), loading },
    ];
    return { panes, caseTitles, loading };
  }, [byRun, runsById, plan, climb.environmentIds, mode, caseKey, environmentId, labels, bestSub, loading]);
}
