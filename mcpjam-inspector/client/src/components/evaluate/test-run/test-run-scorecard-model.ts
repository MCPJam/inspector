import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { ScorerUiRole } from "@/shared/predicate-kinds";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { computeIterationResult } from "../../evals/pass-criteria";
import {
  buildCaseScorecard,
  withRunnerChecks,
} from "../case-scorecard/case-scorecard-model";
import {
  joinTrialResults,
  rubricCheckTrialRows,
  type JoinedScorecardGroup,
} from "../case-scorecard/trial-results";
import {
  withRubricCheckRows,
  withoutInapplicableRunnerChecks,
} from "../case-scorecard/trial-scorecard";
import { authoredForTrial } from "../case-scorecard/trial-authored";

export type TestRunScorecardRow = {
  key: string;
  label: string;
  role: ScorerUiRole;
  builtin: boolean;
  passed: number;
  failed: number;
  firstFailedIterationId: string | null;
};

export type TestRunScorecard = {
  /** Chain order. */
  stages: {
    stage: UserValueStage;
    label: string;
    rows: TestRunScorecardRow[];
  }[];
  /** Iterations counted. */
  total: number;
  timedOut: number;
};

/**
 * The scorecard groups one recorded iteration shows in its Scorecard tab,
 * composed from the same pieces over what the iteration itself recorded (no
 * per-iteration report read), so a test run of many iterations costs nothing
 * beyond the rows it already has.
 */
export function iterationScorecardGroups(input: {
  iteration: EvalIteration;
  run: Pick<EvalSuiteRun, "configSnapshot">;
  chain: EvalRunDecisionChain | null;
}): JoinedScorecardGroup[] {
  const { iteration, run, chain } = input;
  const { authored } = authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run,
    forceSnapshot: true,
  });
  const card = buildCaseScorecard(authored);
  const chainStages =
    chain?.status === "verified"
      ? chain.stages
          .filter((row) => row.state !== "notApplicable")
          .map((row) => row.stage)
      : [];
  return withRubricCheckRows(
    withoutInapplicableRunnerChecks(
      joinTrialResults(withRunnerChecks(card.groups, chainStages), {
        iteration,
        steps: authored.steps,
        chain,
      }),
    ),
    rubricCheckTrialRows(iteration),
  );
}

/**
 * Every assertion across the test run's iterations, one row per assertion:
 * the same assertion recorded by two iterations is one row with two results.
 * Only recorded passes and failures count; a row nobody measured says so.
 */
export function buildTestRunScorecard(
  perIteration: readonly {
    iteration: EvalIteration;
    groups: JoinedScorecardGroup[];
  }[],
): TestRunScorecard {
  const stages = new Map<
    UserValueStage,
    { label: string; rows: Map<string, TestRunScorecardRow> }
  >();
  let timedOut = 0;
  for (const { iteration, groups } of perIteration) {
    if (computeIterationResult(iteration) === "timed_out") timedOut += 1;
    for (const group of groups) {
      const stage = stages.get(group.stage) ?? {
        label: group.label,
        rows: new Map<string, TestRunScorecardRow>(),
      };
      stages.set(group.stage, stage);
      for (const row of group.rows) {
        const key = `${group.stage}|${row.provenance}|${row.label}`;
        const total = stage.rows.get(key) ?? {
          key,
          label: row.label,
          role: row.role,
          builtin: row.provenance === "builtin",
          passed: 0,
          failed: 0,
          firstFailedIterationId: null,
        };
        stage.rows.set(key, total);
        if (row.result.state === "passed") total.passed += 1;
        if (row.result.state === "failed") {
          total.failed += 1;
          total.firstFailedIterationId ??= iteration._id;
        }
      }
    }
  }
  return {
    stages: USER_VALUE_STAGES.flatMap((stage) => {
      const found = stages.get(stage);
      return found
        ? [{ stage, label: found.label, rows: [...found.rows.values()] }]
        : [];
    }),
    total: perIteration.length,
    timedOut,
  };
}
