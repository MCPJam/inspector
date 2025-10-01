import { EvalCase, EvalIteration, EvalSuite, SuiteAggregate } from "./types";

export function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function aggregateSuite(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
): SuiteAggregate {
  // Backend already filters iterations by suite, so we use them directly
  const totals = iterations.reduce(
    (acc, it) => {
      if (
        it.status === "pending" ||
        it.status === "running" ||
        it.result === "pending"
      ) {
        // skip counting while in-flight
      } else if (it.result === "passed") acc.passed += 1;
      else if (it.result === "failed") acc.failed += 1;
      else if (it.result === "cancelled") acc.cancelled += 1;
      acc.tokens += it.tokensUsed || 0;
      return acc;
    },
    { passed: 0, failed: 0, cancelled: 0, tokens: 0 },
  );

  const byCaseMap = new Map<string, SuiteAggregate["byCase"][number]>();
  for (const it of iterations) {
    const id = it.testCaseId;
    if (!id) continue;
    if (!byCaseMap.has(id)) {
      const c = cases.find((x) => x._id === id);
      // Count total iterations for this test case
      const totalRuns = iterations.filter(
        (iter) => iter.testCaseId === id,
      ).length;
      byCaseMap.set(id, {
        testCaseId: id,
        title: c?.title || "Untitled",
        provider: c?.provider || "",
        model: c?.model || "",
        runs: totalRuns,
        passed: 0,
        failed: 0,
        cancelled: 0,
        tokens: 0,
      });
    }
    const entry = byCaseMap.get(id)!;
    if (
      it.status === "pending" ||
      it.status === "running" ||
      it.result === "pending"
    ) {
      // do not count pending/running
    } else if (it.result === "passed") entry.passed += 1;
    else if (it.result === "failed") entry.failed += 1;
    else if (it.result === "cancelled") entry.cancelled += 1;
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: iterations,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}
