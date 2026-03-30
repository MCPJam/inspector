import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";

/**
 * Latest failed iteration suitable as trace-repair source: failed playground run,
 * trace blob present, suite run has stored replay config.
 */
export function pickTraceRepairCaseSourceIteration(
  testCaseId: string,
  iterations: EvalIteration[],
  runs: EvalSuiteRun[],
): EvalIteration | null {
  const runById = new Map(runs.map((r) => [r._id, r]));
  const candidates = iterations.filter((it) => {
    if (it.testCaseId !== testCaseId || it.result !== "failed") {
      return false;
    }
    if (!it.suiteRunId || !it.blob) {
      return false;
    }
    const run = runById.get(it.suiteRunId);
    return run?.hasServerReplayConfig === true;
  });
  candidates.sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  );
  return candidates[0] ?? null;
}
