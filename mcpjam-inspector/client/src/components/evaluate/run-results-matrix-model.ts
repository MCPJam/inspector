import { compactModelIdTail } from "@/lib/environment-label";
import { computeIterationResult } from "../evals/pass-criteria";
import { iterationLatencyP95, sumIterationCost } from "../evals/helpers";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";

export function launchRuns(run: EvalSuiteRun, runs: readonly EvalSuiteRun[]) {
  return [
    run,
    ...runs.filter(
      (candidate) =>
        candidate._id !== run._id &&
        candidate.suiteId === run.suiteId &&
        Boolean(run.runGroupId) &&
        candidate.runGroupId === run.runGroupId,
    ),
  ].sort(
    (a, b) =>
      (a.runNumber ?? 0) - (b.runNumber ?? 0) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      a._id.localeCompare(b._id),
  );
}

export function resultCounts(iterations: readonly EvalIteration[]) {
  const counts = { passed: 0, failed: 0, pending: 0, cancelled: 0 };
  for (const iteration of iterations) {
    const result = computeIterationResult(iteration);
    if (result === "passed") counts.passed++;
    else if (result === "failed" || result === "timed_out") counts.failed++;
    else if (result === "cancelled") counts.cancelled++;
    else counts.pending++;
  }
  return counts;
}

export function matrixCaseKey(iteration: EvalIteration): string {
  return (
    iteration.testCaseId ??
    iteration.testCaseSnapshot?.caseKey ??
    `title:${iteration.testCaseSnapshot?.title ?? iteration._id}`
  );
}

export function buildRunResultsMatrix({
  run,
  runs,
  iterations,
  hostNamesById,
}: {
  run: EvalSuiteRun;
  runs: readonly EvalSuiteRun[];
  iterations: readonly EvalIteration[];
  hostNamesById: ReadonlyMap<string, string | null>;
}) {
  const scopedRuns = launchRuns(run, runs);
  const cases = new Map<
    string,
    { key: string; title: string; testCaseId?: string }
  >();
  const targets = scopedRuns.flatMap((targetRun) => {
    const targetIterations = iterations.filter(
      (iteration) => iteration.suiteRunId === targetRun._id,
    );
    const models = new Map<string, EvalIteration[]>();
    for (const iteration of targetIterations) {
      const model =
        targetRun.effectiveModelId ??
        iteration.testCaseSnapshot?.model ??
        "Client default";
      const bucket = models.get(model) ?? [];
      bucket.push(iteration);
      models.set(model, bucket);
      const key = matrixCaseKey(iteration);
      cases.set(key, {
        key,
        title: iteration.testCaseSnapshot?.title ?? "Untitled case",
        testCaseId: iteration.testCaseId,
      });
    }
    // A queued run already knows its cases from the launch snapshot, even
    // before the recorder has created its iteration rows.
    for (const test of targetRun.configSnapshot?.tests ?? []) {
      const recorded = targetIterations.find(
        (item) => item.testCaseSnapshot?.title === test.title,
      );
      const key =
        test.testCaseId ??
        (recorded ? matrixCaseKey(recorded) : `title:${test.title}`);
      if (!cases.has(key))
        cases.set(key, { key, title: test.title, testCaseId: test.testCaseId });
      const model =
        targetRun.effectiveModelId ?? test.model ?? "Client default";
      if (!models.has(model)) models.set(model, []);
    }
    if (!models.size)
      models.set(targetRun.effectiveModelId ?? "Client default", []);
    return [...models].map(([model, items]) => ({
      key: JSON.stringify([targetRun._id, model]),
      run: targetRun,
      client: targetRun.namedHostId
        ? hostNamesById.get(targetRun.namedHostId) ??
          `Client …${targetRun.namedHostId.slice(-6)}`
        : "Suite client",
      modelId: model,
      model: compactModelIdTail(model),
      iterations: items,
      counts: resultCounts(items),
      p95Ms: iterationLatencyP95(items),
      cost: sumIterationCost(items),
      cells: new Map(
        [...cases.keys()].map((key) => [
          key,
          items.filter((item) => matrixCaseKey(item) === key),
        ]),
      ),
    }));
  });
  const rows = [...cases.values()].sort((a, b) => {
    const failures = (key: string) =>
      targets.reduce(
        (sum, target) => sum + resultCounts(target.cells.get(key) ?? []).failed,
        0,
      );
    return failures(b.key) - failures(a.key) || a.title.localeCompare(b.title);
  });
  return { targets, rows };
}
export type RunResultsMatrixData = ReturnType<typeof buildRunResultsMatrix>;
