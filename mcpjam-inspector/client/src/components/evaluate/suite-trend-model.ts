import { isSubsetRerunRun } from "../evals/helpers";
import { isActiveRun } from "../evals/run-metrics";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../evals/types";

/** Bars drawn on a suite card; the average reads every measured run loaded. */
export const SUITE_TREND_BAR_COUNT = 5;

/** A rise or fall smaller than this, in points, reads as Steady. */
const TREND_MIN_POINTS = 10;

export type SuiteTrendBar = {
  runId: string;
  runNumber: number;
  /** 0–100. */
  rate: number;
  passed: boolean;
};

export type SuiteTrendWord =
  | { kind: "flaky"; passed: number; total: number }
  | { kind: "up" | "down"; points: number; runs: number }
  | { kind: "steady"; runs: number };

export type SuiteTrend = {
  /** Mean pass rate (0–100) of the measured runs, or null with none. */
  average: number | null;
  /** How many runs the average covers. */
  averagedRuns: number;
  /** Oldest first, at most SUITE_TREND_BAR_COUNT. */
  bars: SuiteTrendBar[];
  /** Null until two runs can be compared. */
  word: SuiteTrendWord | null;
};

/**
 * A run counts toward the trend when it measured the whole suite: finished,
 * not a rerun of failed cases only (its rate is biased by its selection), not
 * inconclusive, and with a summary that graded something. The same rule as
 * `getTestSuitesOverview`'s `passRateTrend`, applied to `recentRuns` so each
 * bar keeps its run number.
 */
function isMeasuredRun(run: EvalSuiteRun): boolean {
  return (
    !isActiveRun(run) &&
    !isSubsetRerunRun(run) &&
    run.result !== "inconclusive" &&
    Boolean(run.summary?.total) &&
    Number.isFinite(run.summary?.passRate)
  );
}

export function runPassed(run: EvalSuiteRun): boolean {
  if (run.result === "passed") return true;
  if (run.result) return false;
  // Legacy runs carry no verdict: compare the rate with the run's own bar.
  const minimum = run.passCriteria?.minimumPassRate ?? 100;
  return (run.summary?.passRate ?? 0) * 100 >= minimum;
}

export function trendWord(bars: SuiteTrendBar[]): SuiteTrendWord | null {
  if (bars.length < 2) return null;
  let flips = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].passed !== bars[index - 1].passed) flips += 1;
  }
  if (flips >= 2) {
    return {
      kind: "flaky",
      passed: bars.filter((bar) => bar.passed).length,
      total: bars.length,
    };
  }
  const delta = Math.round(bars[bars.length - 1].rate - bars[0].rate);
  if (Math.abs(delta) >= TREND_MIN_POINTS) {
    return {
      kind: delta > 0 ? "up" : "down",
      points: Math.abs(delta),
      runs: bars.length,
    };
  }
  return { kind: "steady", runs: bars.length };
}

export function buildSuiteTrend(entry: EvalSuiteOverviewEntry): SuiteTrend {
  // `recentRuns` is newest first.
  const measured = (entry.recentRuns ?? []).filter(isMeasuredRun);
  const rates = measured.map((run) => (run.summary?.passRate ?? 0) * 100);
  const bars = measured
    .slice(0, SUITE_TREND_BAR_COUNT)
    .reverse()
    .map((run) => ({
      runId: run._id,
      runNumber: run.runNumber,
      rate: (run.summary?.passRate ?? 0) * 100,
      passed: runPassed(run),
    }));
  return {
    average: rates.length
      ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length
      : null,
    averagedRuns: rates.length,
    bars,
    word: trendWord(bars),
  };
}

export type LatestRunLabel = {
  runNumber: number;
  verdict: string;
  tone: "success" | "destructive" | "muted";
};

/** "Run #6 · Failed 67%": the latest run's number, verdict and rate. */
export function latestRunLabel(
  run: EvalSuiteRun | null | undefined,
): LatestRunLabel | null {
  if (!run) return null;
  if (isActiveRun(run)) {
    return { runNumber: run.runNumber, verdict: "Running", tone: "muted" };
  }
  const rate = run.summary?.total
    ? ` ${Math.round((run.summary.passRate ?? 0) * 100)}%`
    : "";
  if (run.result === "inconclusive") {
    return { runNumber: run.runNumber, verdict: "Inconclusive", tone: "muted" };
  }
  if (run.status === "cancelled" || run.result === "cancelled") {
    return { runNumber: run.runNumber, verdict: "Cancelled", tone: "muted" };
  }
  if (!run.summary?.total) {
    return {
      runNumber: run.runNumber,
      verdict: run.status === "completed" ? "No results" : "Failed",
      tone: run.status === "completed" ? "muted" : "destructive",
    };
  }
  return runPassed(run)
    ? { runNumber: run.runNumber, verdict: `Passed${rate}`, tone: "success" }
    : {
        runNumber: run.runNumber,
        verdict: `Failed${rate}`,
        tone: "destructive",
      };
}
