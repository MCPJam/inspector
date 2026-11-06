/**
 * What the Suite run page derives from the suite's runs: the baseline it
 * compares with, the runs Compare can pick, and the Compare tease.
 */
import { compareRunsBySequence, isSubsetRerunRun } from "../../evals/helpers";
import type { EvalSuiteRunListItem } from "../../evals/types";
import { sameRunTarget } from "@/lib/eval-target-key";
import {
  describeRunChanges,
  type RunChangeSummary,
} from "../evaluate-run-diff-model";

/**
 * The completed run before `selected` on the same host and target, outside
 * its own launch and never a subset rerun (it measured only what failed).
 * The Evaluate rule SuiteIterationsView applies inline; phase 4 deletes that
 * copy with the legacy layout.
 */
export function previousRunForRunPage<TRun extends EvalSuiteRunListItem>(
  selected: EvalSuiteRunListItem | null,
  runs: readonly TRun[],
): TRun | null {
  if (!selected || selected.status !== "completed") return null;
  return (
    runs
      .filter(
        (run) =>
          run._id !== selected._id &&
          run.status === "completed" &&
          !isSubsetRerunRun(run) &&
          run.namedHostId === selected.namedHostId &&
          sameRunTarget(run, selected) &&
          (!selected.runGroupId || run.runGroupId !== selected.runGroupId) &&
          compareRunsBySequence(run, selected) < 0,
      )
      .sort((a, b) => compareRunsBySequence(b, a))[0] ?? null
  );
}

/** Runs Compare can pick: other launches that decided something. */
export function compareCandidates<TRun extends EvalSuiteRunListItem>(
  selected: EvalSuiteRunListItem,
  runs: readonly TRun[],
): TRun[] {
  return runs.filter(
    (candidate) =>
      candidate._id !== selected._id &&
      (!selected.runGroupId || candidate.runGroupId !== selected.runGroupId) &&
      candidate.result !== "inconclusive",
  );
}

/** "vs run #3 · 2 newly failing", or null when there is no comparison. */
export function compareTease(summary: RunChangeSummary | null): string | null {
  if (!summary) return null;
  const changes =
    describeRunChanges(summary).join(" · ") || "no case changed state";
  return `vs run #${summary.baseRunNumber} · ${changes}`;
}
