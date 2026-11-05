/**
 * Pure model behind the Test run page: one case inside one run.
 *
 * The page reads only this case's iterations (`listTestRunIterations`, E5),
 * so the matrix model below sees a single case. Targets are that run's
 * models; the picked one is part of the address (`?target=`, DD2).
 */
import {
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  type EvalRunDecisionDiagnostic,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { computeIterationResult } from "../../evals/pass-criteria";
import type { EvalIteration } from "../../evals/types";
import { defaultSelectedTrialStage } from "../stage-trial-model";
import type { RunResultsMatrixData } from "../run-results-matrix-model";

export type TestRunTarget = RunResultsMatrixData["targets"][number];

/** Targets that ran this case, so a model the case never reached gets no tab. */
export function caseTargets(
  matrix: RunResultsMatrixData,
  caseKey: string,
): TestRunTarget[] {
  return matrix.targets.filter(
    (target) => (target.cells.get(caseKey) ?? []).length > 0,
  );
}

/** The target the address names, else the first one; an unknown name falls back too. */
export function pickTarget(
  targets: readonly TestRunTarget[],
  targetKey: string | undefined,
): TestRunTarget | null {
  return (
    targets.find((target) => target.targetKey === targetKey) ??
    targets[0] ??
    null
  );
}

/** The iteration the scorecard shows: the first that failed, else the first. */
export function representativeIteration(
  items: readonly EvalIteration[],
): EvalIteration | null {
  return (
    items.find((item) =>
      ["failed", "timed_out"].includes(computeIterationResult(item)),
    ) ??
    items[0] ??
    null
  );
}

export interface TestRunFinding {
  /** The stage the iterations broke at, or the chain's category when none. */
  key: string;
  sentence: string;
  /** What the decision chain says to do next, from the first iteration. */
  nextAction: string;
  /** The iteration "Open iteration" leads to. */
  iterationId: string;
  count: number;
}

/**
 * One finding per place this case broke: "3 of 8 iterations broke at
 * Selection: …". Built from the run's decision diagnostics, which list
 * every non-passing iteration with its chain.
 */
export function buildTestRunFindings(
  diagnostics: readonly EvalRunDecisionDiagnostic[],
  caseId: string,
  totalIterations: number,
): TestRunFinding[] {
  const groups = new Map<string, EvalRunDecisionDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.testCaseId !== caseId) continue;
    const key = findingKey(diagnostic);
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  return [...groups]
    .map(([key, items]) => {
      const first = items[0];
      const where = findingWhere(first);
      const total = Math.max(totalIterations, items.length);
      return {
        key,
        sentence: `${items.length} of ${total} ${
          total === 1 ? "iteration" : "iterations"
        } ${where}`,
        nextAction: first.nextAction,
        iterationId: first.iterationId,
        count: items.length,
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function brokenStage(
  diagnostic: EvalRunDecisionDiagnostic,
): UserValueStage | null {
  return defaultSelectedTrialStage(diagnostic.chain);
}

function findingKey(diagnostic: EvalRunDecisionDiagnostic): string {
  const stage = brokenStage(diagnostic);
  if (stage) return stage;
  return diagnostic.chain.status === "verified"
    ? (diagnostic.chain.failureCategory ?? "unexplained")
    : "unverified";
}

function findingWhere(diagnostic: EvalRunDecisionDiagnostic): string {
  const stage = brokenStage(diagnostic);
  if (!stage || diagnostic.chain.status !== "verified") {
    return diagnostic.observed?.failure
      ? `failed: ${diagnostic.observed.failure}`
      : "failed before any stage was measured.";
  }
  const row = diagnostic.chain.stages.find((item) => item.stage === stage);
  const reason = row?.reason ? STAGE_REASON_LABELS[row.reason] : null;
  const label = USER_VALUE_STAGE_LABELS[stage];
  return reason ? `broke at ${label}: ${reason}.` : `broke at ${label}.`;
}
