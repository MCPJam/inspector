import {
  compareRunsBySequence,
  runClientIdentity,
} from "@/components/evals/helpers";
import type { EvalSuiteRunListItem } from "@/components/evals/types";
import { launchRuns } from "../run-results-matrix-model";

/** Model and client of the newest launch, as the history's first row shows them. */
export function newestLaunchPills(
  runs: readonly EvalSuiteRunListItem[],
  hostNamesById: ReadonlyMap<string, string | null>,
): { models: (string | null)[]; clients: string[] } {
  const newest = [...runs].sort((a, b) => compareRunsBySequence(b, a))[0];
  if (!newest) return { models: [], clients: [] };
  const members = launchRuns(newest, runs);
  return {
    models: [...new Set(members.map((run) => run.effectiveModelId ?? null))],
    clients: [
      ...new Set(
        members.map((run) => runClientIdentity(run, hostNamesById).name),
      ),
    ],
  };
}
