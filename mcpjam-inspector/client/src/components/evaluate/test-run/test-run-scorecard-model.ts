/**
 * Every check of one test case, counted across its iterations.
 *
 * Each iteration is joined exactly as its own scorecard joins it
 * (`authoredForTrial` against the frozen snapshot, then `joinTrialResults`),
 * so a row here is the sum of the rows the Iteration page shows. A row the
 * iteration did not measure is left out of its denominator rather than
 * counted as a miss.
 */
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { computeIterationResult } from "../../evals/pass-criteria";
import {
  buildCaseScorecard,
  withRunnerChecks,
} from "../case-scorecard/case-scorecard-model";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { joinTrialResults } from "../case-scorecard/trial-results";
import { withoutInapplicableRunnerChecks } from "../case-scorecard/trial-scorecard";

export type TestRunScorecardRow = {
  key: string;
  label: string;
  /** "Built-in" for a runner check, "Advisory" for one that only warns. */
  note: "Built-in" | "Advisory" | null;
  passed: number;
  /** Iterations that measured this row: passed, failed or errored. */
  measured: number;
  /** The first iteration this row failed, to open from the row. */
  firstFailedIterationId: string | null;
};

export type TestRunScorecardGroup = {
  stage: UserValueStage;
  label: string;
  rows: TestRunScorecardRow[];
};

export type TestRunScorecard = {
  groups: TestRunScorecardGroup[];
  iterationCount: number;
  /** Iterations that timed out, so none of their checks were measured. */
  timedOut: number;
};

/** A run row that carries its launch snapshot (the frozen judge settings). */
function hasRunSnapshot(run: EvalSuiteRunListItem): run is EvalSuiteRun {
  return "tests" in (run.configSnapshot ?? {});
}

const MEASURED_STATES = new Set(["passed", "failed", "error", "uncertain"]);

export function buildTestRunScorecard({
  iterations,
  runFor,
  chainFor,
}: {
  iterations: readonly EvalIteration[];
  /** The suite run an iteration belongs to, for its frozen judge settings. */
  runFor: (iteration: EvalIteration) => EvalSuiteRunListItem | null;
  chainFor?: (iteration: EvalIteration) => EvalRunDecisionChain | undefined;
}): TestRunScorecard {
  const groups = new Map<UserValueStage, TestRunScorecardGroup>();
  const rows = new Map<string, TestRunScorecardRow>();
  let timedOut = 0;
  for (const iteration of iterations) {
    if (computeIterationResult(iteration) === "timed_out") timedOut += 1;
    const run = runFor(iteration);
    const authored = authoredForTrial({
      trial: { kind: "persisted", iteration, source: "route" },
      draft: { steps: [], toolsChoice: "unset" },
      run: run && hasRunSnapshot(run) ? run : null,
      forceSnapshot: true,
    }).authored;
    const chain = chainFor?.(iteration);
    const chainStages =
      chain?.status === "verified"
        ? chain.stages
            .filter((row) => row.state !== "notApplicable")
            .map((row) => row.stage)
        : [];
    const joined = withoutInapplicableRunnerChecks(
      joinTrialResults(
        withRunnerChecks(buildCaseScorecard(authored).groups, chainStages),
        { iteration, steps: authored.steps, chain },
      ),
    );
    for (const group of joined) {
      let target = groups.get(group.stage);
      if (!target) {
        target = { stage: group.stage, label: group.label, rows: [] };
        groups.set(group.stage, target);
      }
      for (const row of group.rows) {
        const key = `${group.stage}:${row.key}`;
        let total = rows.get(key);
        if (!total) {
          total = {
            key,
            label: row.label,
            note:
              row.provenance === "builtin"
                ? "Built-in"
                : row.role === "advisory"
                  ? "Advisory"
                  : null,
            passed: 0,
            measured: 0,
            firstFailedIterationId: null,
          };
          rows.set(key, total);
          target.rows.push(total);
        }
        const state = row.result.state;
        if (!MEASURED_STATES.has(state)) continue;
        total.measured += 1;
        if (state === "passed") total.passed += 1;
        else if (total.firstFailedIterationId === null) {
          total.firstFailedIterationId = iteration._id;
        }
      }
    }
  }
  return {
    // Chain order, whichever iteration first reached a stage.
    groups: USER_VALUE_STAGES.flatMap((stage) => {
      const group = groups.get(stage);
      return group && group.rows.length > 0 ? [group] : [];
    }),
    iterationCount: iterations.length,
    timedOut,
  };
}
