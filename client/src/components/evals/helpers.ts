import { EvalCase, EvalIteration, EvalSuite, SuiteAggregate } from "./types";

export function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function withinSuiteWindow(it: EvalIteration, suite: EvalSuite): boolean {
  const started = suite.startedAt ?? 0;
  const finished = suite.finishedAt ?? Number.MAX_SAFE_INTEGER;
  return it.startedAt >= started && it.startedAt <= finished;
}

export function aggregateSuite(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
): SuiteAggregate {
  const filtered = iterations.filter((it) => withinSuiteWindow(it, suite));
  const totals = filtered.reduce(
    (acc, it) => {
      if (it.status === "running" || it.result === "pending") {
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
  for (const it of filtered) {
    const id = it.testCaseId;
    if (!id) continue;
    if (!byCaseMap.has(id)) {
      const c = cases.find((x) => x._id === id);
      byCaseMap.set(id, {
        testCaseId: id,
        title: c?.title || "Untitled",
        provider: c?.provider || "",
        model: c?.model || "",
        runs: c?.runs || 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        tokens: 0,
      });
    }
    const entry = byCaseMap.get(id)!;
    if (it.status === "running" || it.result === "pending") {
      // do not count pending/running
    } else if (it.result === "passed") entry.passed += 1;
    else if (it.result === "failed") entry.failed += 1;
    else if (it.result === "cancelled") entry.cancelled += 1;
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: filtered,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}