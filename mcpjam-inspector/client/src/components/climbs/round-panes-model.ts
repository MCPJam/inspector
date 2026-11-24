/**
 * Which run each transcript pane shows. A round's candidate runs in its own
 * group. The best so far is measured again in that round when its numbers were
 * old; if not, it is the last kept round's candidate, or the baseline. All of
 * it is read from the run groups the backend registered, never guessed from names.
 */
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import type { RunGroup } from "./climb-queries";
import type { Climb } from "./climb-types";
import { keptRounds } from "./round-model";

export type PanePlan = {
  baseline?: RunGroup;
  best?: RunGroup;
  candidate?: RunGroup;
  /** What the best so far is made of at this round: "Baseline", "Baseline + round 1". */
  bestIsBaseline: boolean;
  runIds: string[];
};

const unit = (groups: RunGroup[], key: string, role?: string) =>
  groups.filter((group) => group.unitKey === key && (!role || group.role === role)).at(-1);

export function planPanes(climb: Climb, roundNumber: number, groups: RunGroup[]): PanePlan {
  const baseline = groups.filter((group) => group.unitKey.startsWith("baseline:")).at(-1);
  const candidate = unit(groups, `round:${roundNumber}`, "candidate");
  const earlierKept = keptRounds(climb).filter((round) => round.number < roundNumber).at(-1);
  const best =
    unit(groups, `round:${roundNumber}`, "best") ??
    (earlierKept ? unit(groups, `round:${earlierKept.number}`, "candidate") : undefined) ??
    baseline;
  const used = [baseline, best, candidate].filter((group): group is RunGroup => group !== undefined);
  return {
    baseline,
    best,
    candidate,
    bestIsBaseline: best === baseline,
    runIds: [...new Set(used.flatMap((group) => group.launchedRunIds))],
  };
}

/** The run of a group in one environment, read from the run's own record. */
export function runIn(
  group: RunGroup | undefined,
  environmentId: string,
  runsById: ReadonlyMap<string, EvalSuiteRun>,
): string | undefined {
  return group?.launchedRunIds.find(
    (runId) => runsById.get(runId)?.configSnapshot.environmentRef?.environmentId === environmentId,
  );
}

/** One iteration of a case in a run: the lowest numbered one, so the panes compare like with like. */
export function iterationOf(
  iterations: readonly EvalIteration[] | undefined,
  caseKey: string,
): EvalIteration | undefined {
  return (iterations ?? [])
    .filter((iteration) => iteration.testCaseId === caseKey || iteration.testCaseSnapshot?.caseKey === caseKey)
    .sort((a, b) => a.iterationNumber - b.iterationNumber)[0];
}
