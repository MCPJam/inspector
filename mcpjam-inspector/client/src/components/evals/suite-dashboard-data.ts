import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";

export type SuiteDashboardMatrixMetric =
  | "pass-rate"
  | "latency"
  | "tokens"
  | "validators";

export const SUITE_DASHBOARD_MATRIX_METRICS = [
  "pass-rate",
  "latency",
  "tokens",
  "validators",
] as const satisfies ReadonlyArray<SuiteDashboardMatrixMetric>;

export interface SuiteDashboardMatrixFoundation {
  latestCompletedRun: EvalSuiteRun | null;
  latestRunIterations: EvalIteration[];
  caseIds: string[];
  modelKeys: string[];
  availableMetrics: SuiteDashboardMatrixMetric[];
}

export function buildSuiteDashboardMatrixFoundation({
  cases,
  allIterations,
  runs,
}: {
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
}): SuiteDashboardMatrixFoundation {
  const latestCompletedRun = getLatestCompletedRun(runs);
  const latestRunIterations = latestCompletedRun
    ? allIterations.filter((iteration) => iteration.suiteRunId === latestCompletedRun._id)
    : [];
  const sourceIterations =
    latestRunIterations.length > 0 ? latestRunIterations : allIterations;

  const availableMetrics: SuiteDashboardMatrixMetric[] = [];
  if (sourceIterations.length > 0) {
    availableMetrics.push("pass-rate");
  }
  if (sourceIterations.some(hasDurationMs)) {
    availableMetrics.push("latency");
  }
  if (sourceIterations.some((iteration) => (iteration.tokensUsed ?? 0) > 0)) {
    availableMetrics.push("tokens");
  }
  if (sourceIterations.some(hasValidatorSignal)) {
    availableMetrics.push("validators");
  }

  return {
    latestCompletedRun,
    latestRunIterations,
    caseIds: collectCaseIds(cases, sourceIterations),
    modelKeys: collectModelKeys(cases, sourceIterations),
    availableMetrics,
  };
}

function getLatestCompletedRun(runs: EvalSuiteRun[]): EvalSuiteRun | null {
  const completedRuns = runs.filter((run) => run.status === "completed");
  if (completedRuns.length === 0) {
    return null;
  }

  return completedRuns.sort((a, b) => {
    const aTime = a.completedAt ?? a.createdAt ?? 0;
    const bTime = b.completedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  })[0];
}

function collectCaseIds(
  cases: EvalCase[],
  iterations: EvalIteration[],
): string[] {
  const ids = new Set<string>();
  for (const testCase of cases) {
    ids.add(testCase._id);
  }
  for (const iteration of iterations) {
    if (iteration.testCaseId) {
      ids.add(iteration.testCaseId);
    }
  }
  return [...ids];
}

function collectModelKeys(
  cases: EvalCase[],
  iterations: EvalIteration[],
): string[] {
  const keys = new Set<string>();
  for (const testCase of cases) {
    for (const model of testCase.models ?? []) {
      keys.add(`${model.provider}/${model.model}`);
    }
  }
  for (const iteration of iterations) {
    const snapshot = iteration.testCaseSnapshot;
    if (snapshot?.provider && snapshot.model) {
      keys.add(`${snapshot.provider}/${snapshot.model}`);
    }
  }
  return [...keys];
}

function hasDurationMs(iteration: EvalIteration): boolean {
  if (typeof iteration.startedAt !== "number") {
    return false;
  }
  const finishedAt = iteration.updatedAt ?? iteration.startedAt;
  return finishedAt > iteration.startedAt;
}

function hasValidatorSignal(iteration: EvalIteration): boolean {
  const metadata = iteration.metadata;
  if (metadata) {
    for (const key of [
      "missingCount",
      "unexpectedCount",
      "argumentMismatchCount",
      "mismatchCount",
    ]) {
      const value = metadata[key];
      if (typeof value === "number" && value > 0) {
        return true;
      }
      if (typeof value === "string" && Number(value) > 0) {
        return true;
      }
    }
  }

  return (
    (iteration.testCaseSnapshot?.expectedToolCalls.length ?? 0) > 0 ||
    iteration.actualToolCalls.length > 0
  );
}
