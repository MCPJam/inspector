import type { EvalSuite, EvalSuiteRun } from "@/components/evals/types";

/**
 * Latest completed playground run with at least one failed test (summary).
 * Matches server-side checks closely enough for button eligibility; mutation still validates.
 */
export function pickTraceRepairSourceRun(
  suite: Pick<EvalSuite, "source">,
  runs: EvalSuiteRun[],
): EvalSuiteRun | null {
  if (suite.source === "sdk") {
    return null;
  }
  const sorted = [...runs].sort((a, b) => {
    const tb = b.completedAt ?? b.createdAt ?? 0;
    const ta = a.completedAt ?? a.createdAt ?? 0;
    return tb - ta;
  });
  for (const run of sorted) {
    if (run.status !== "completed") {
      continue;
    }
    if (run.source === "sdk") {
      continue;
    }
    const failed = run.summary?.failed ?? 0;
    if (failed < 1) {
      continue;
    }
    return run;
  }
  return null;
}

export function isTraceRepairSuiteEligible(
  suite: Pick<EvalSuite, "source">,
  runs: EvalSuiteRun[],
): boolean {
  return pickTraceRepairSourceRun(suite, runs) != null;
}
