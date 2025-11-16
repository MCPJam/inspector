import { EvalCase, EvalIteration, EvalSuite, SuiteAggregate } from "./types";
import { computeIterationResult } from "./pass-criteria";

export function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatRunId(runId: string): string {
  // Format Convex ID for display (e.g., "j1234567890abcdef" -> "j1234567")
  return runId.substring(0, 8);
}

/**
 * Compute summary statistics for a list of iterations
 */
export function computeIterationSummary(items: EvalIteration[]) {
  const summary = {
    runs: items.length,
    passed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    tokens: 0,
    avgDuration: null as number | null,
  };

  let totalDuration = 0;
  let durationCount = 0;

  items.forEach((iteration) => {
    if (iteration.result === "passed") summary.passed += 1;
    else if (iteration.result === "failed") summary.failed += 1;
    else if (iteration.result === "cancelled") summary.cancelled += 1;
    else summary.pending += 1;

    summary.tokens += iteration.tokensUsed || 0;

    const startedAt = iteration.startedAt ?? iteration.createdAt;
    const completedAt = iteration.updatedAt ?? iteration.createdAt;
    if (startedAt && completedAt) {
      const duration = Math.max(completedAt - startedAt, 0);
      totalDuration += duration;
      durationCount += 1;
    }
  });

  if (durationCount > 0) {
    summary.avgDuration = totalDuration / durationCount;
  }

  return summary;
}

/**
 * Get the template key for a test case or config test
 * Falls back to a unique identifier if no explicit template key exists
 */
export function getTemplateKey(test: {
  testTemplateKey?: string;
  title?: string;
  query?: string;
  _id?: string;
}): string {
  if (test.testTemplateKey) return test.testTemplateKey;
  if (test._id) return `fallback:${test._id}`;
  return `fallback:${test.title}-${test.query}`;
}

export function aggregateSuite(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
): SuiteAggregate {
  // Backend already filters iterations by suite, so we use them directly
  const totals = iterations.reduce(
    (acc, it) => {
      const result = computeIterationResult(it);
      if (result === "pending") {
        acc.pending += 1;
      } else if (result === "passed") {
        acc.passed += 1;
      } else if (result === "failed") {
        acc.failed += 1;
      } else if (result === "cancelled") {
        acc.cancelled += 1;
      }
      acc.tokens += it.tokensUsed || 0;
      return acc;
    },
    { passed: 0, failed: 0, cancelled: 0, pending: 0, tokens: 0 },
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
    const result = computeIterationResult(it);
    if (result === "pending") {
      // do not count pending/running
    } else if (result === "passed") {
      entry.passed += 1;
    } else if (result === "failed") {
      entry.failed += 1;
    } else if (result === "cancelled") {
      entry.cancelled += 1;
    }
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: iterations,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}
