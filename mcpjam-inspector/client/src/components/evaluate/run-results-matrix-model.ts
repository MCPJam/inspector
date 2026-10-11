import { compactModelIdTail } from "@/lib/environment-label";
import {
  computeIterationResult,
  computeMeasuredIterationResult,
} from "../evals/pass-criteria";
import {
  iterationLatencyP95,
  sumIterationCost,
  runClientIdentity,
  snapshotTestModels,
} from "../evals/helpers";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../evals/types";
import {
  iterationTargetKey,
  modelIdFromTargetKey,
  runIterationTargetKey,
  runTargetKey,
  targetKeyLabels,
} from "@/lib/eval-target-key";

export function launchRuns<TRun extends EvalSuiteRunListItem>(
  run: TRun,
  runs: readonly TRun[],
) {
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

/**
 * {@link resultCounts} over the rows a PASS RATE may count: a row OUR
 * infrastructure failed is left out (`computeMeasuredIterationResult`).
 * Labels (`cellResult`) keep reading every row.
 */
export function measuredResultCounts(iterations: readonly EvalIteration[]) {
  return resultCounts(
    iterations.filter(
      (iteration) =>
        computeMeasuredIterationResult(iteration) !== "infra_error",
    ),
  );
}

/** Match the overall result displayed for a case/client/model cell. */
export function cellResult(iterations: readonly EvalIteration[]) {
  if (!iterations.length) return null;
  const counts = resultCounts(iterations);
  if (counts.pending) return "pending";
  if (counts.failed) return "failed";
  if (counts.cancelled) return "cancelled";
  return "passed";
}

export function matrixCaseKey(iteration: EvalIteration): string {
  return (
    iteration.testCaseId ??
    iteration.testCaseSnapshot?.caseKey ??
    `title:${iteration.testCaseSnapshot?.title ?? iteration._id}`
  );
}

export function buildRunResultsMatrix<TRun extends EvalSuiteRunListItem>({
  run,
  runs,
  iterations,
  hostNamesById,
}: {
  run: TRun;
  runs: readonly TRun[];
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
      // Keyed by TARGET (`targetKey`, the bare model id for a default
      // selection), so two efforts of one model are two columns.
      const model =
        runIterationTargetKey(targetRun, iteration) ?? "Client default";
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
    // The launch snapshot knows every case the run intends to execute, so it
    // is the case list for a QUEUED run and still the case list for one in
    // flight — a case the recorder has not reached yet belongs on screen as an
    // empty cell, not missing until its first iteration lands.
    const snapshotTests =
      "tests" in (targetRun.configSnapshot ?? {})
        ? (targetRun as unknown as EvalSuiteRun).configSnapshot.tests
        : [];
    for (const test of snapshotTests) {
      // Key onto the recorded iteration when this case HAS started, so it does
      // not also render as a second, title-keyed row.
      const recorded = targetIterations.find(
        (item) => item.testCaseSnapshot?.title === test.title,
      );
      const key =
        test.testCaseId ??
        (recorded ? matrixCaseKey(recorded) : `title:${test.title}`);
      if (!cases.has(key))
        cases.set(key, { key, title: test.title, testCaseId: test.testCaseId });
    }
    // Models are NOT seeded the same way. Once a target has produced
    // iterations they are the truth about what it ran, and a snapshot model it
    // never used would mint a phantom empty column beside the real one.
    if (targetIterations.length === 0) {
      for (const test of snapshotTests) {
        const snapshotModels = snapshotTestModels(test).map(
          (entry) =>
            iterationTargetKey({ testCaseSnapshot: entry }) ?? entry.model,
        );
        for (const model of targetRun.effectiveModelId
          ? [runTargetKey(targetRun) ?? targetRun.effectiveModelId]
          : snapshotModels.length
            ? snapshotModels
            : ["Client default"]) {
          if (!models.has(model)) models.set(model, []);
        }
      }
    }
    if (!models.size)
      models.set(runTargetKey(targetRun) ?? "Client default", []);
    return [...models].map(([model, items]) => ({
      key: JSON.stringify([targetRun._id, model]),
      run: targetRun,
      client: runClientIdentity(targetRun, hostNamesById).name,
      /** The model id this target ran (the target key without its selection). */
      modelId: modelIdFromTargetKey(model),
      /** `comparisonKey` of the selection; the bare model id when default. */
      targetKey: model,
      // Relabelled below once every target is known (only what differs).
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
  const labels = targetKeyLabels(
    targets
      .map((target) => target.targetKey)
      .filter((key) => key !== "Client default"),
  );
  for (const target of targets) {
    target.model = labels.get(target.targetKey) ?? target.model;
  }
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
