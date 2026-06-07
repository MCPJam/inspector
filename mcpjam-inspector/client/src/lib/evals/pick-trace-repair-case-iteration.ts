import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";

/**
 * Latest failed iteration suitable as trace-repair source: failed playground
 * run, trace present (via either the legacy `blob` field or the unified
 * `chatSessionId` pointer added in PR-4 of the eval→chatSessions
 * unification — `getTestIterationBlob` reads from whichever source is
 * present), suite run has stored replay config.
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
    if (!it.suiteRunId) return false;
    // PR-4 R6: accept either a legacy blob OR a chatSessions pointer.
    // Pre-PR-1 iterations only have `blob`; post-flag-flip iterations
    // may have only `chatSessionId` (when the fanout succeeds and the
    // legacy blob path is skipped). Mid-rollout iterations can have
    // both — either is a valid trace source for repair.
    if (!it.blob && !it.chatSessionId) return false;
    const run = runById.get(it.suiteRunId);
    return run?.hasServerReplayConfig === true;
  });
  candidates.sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  );
  return candidates[0] ?? null;
}
