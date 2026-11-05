import { isSubsetRerunRun } from "../../evals/helpers";
import { isActiveRun } from "../../evals/run-metrics";
import { toPercent } from "../../evals/suite-overview-presentation";
import type { EvalSuiteRun } from "../../evals/types";

/** The fields of a `recentRuns` entry the slice reads. */
export type SuiteSliceRun = Pick<
  EvalSuiteRun,
  | "_id"
  | "runNumber"
  | "status"
  | "result"
  | "summary"
  | "rerunScope"
  | "createdAt"
  | "completedAt"
>;

/** Runs a suite card draws as bars (C14). */
export const SUITE_SLICE_RUNS = 5;

export interface SuiteSlicePoint {
  runId: string;
  runNumber: number;
  /** Pass rate, 0–100. */
  rate: number;
  passed: boolean;
  completedAt: number;
}

export type SuiteTrend =
  | { kind: "single" }
  | { kind: "flaky"; passed: number; runs: number }
  | { kind: "steady"; runs: number }
  | { kind: "up" | "down"; points: number; runs: number };

export interface SuiteRunSlice {
  /** Oldest first, at most {@link SUITE_SLICE_RUNS}. */
  points: SuiteSlicePoint[];
  /** Mean pass rate over `points`, 0–100; null with no finished run. */
  average: number | null;
  latest: SuiteSlicePoint | null;
  trend: SuiteTrend | null;
}

/** Verdict flips across the slice that make it read as Flaky. */
const FLAKY_FLIPS = 3;
/** A change smaller than this many points reads as Steady. */
const STEADY_POINTS = 3;

/**
 * The suite card's recent runs, from `getTestSuitesOverview`'s `recentRuns`
 * (newest first). Leaves out what the overview leaves out of its own trend:
 * subset reruns, inconclusive runs, and runs still in flight.
 */
export function buildSuiteRunSlice(entry: {
  recentRuns: readonly SuiteSliceRun[];
}): SuiteRunSlice {
  const points = entry.recentRuns
    .flatMap((run) => toPoint(run) ?? [])
    .slice(0, SUITE_SLICE_RUNS)
    .reverse();
  const average = points.length
    ? points.reduce((sum, point) => sum + point.rate, 0) / points.length
    : null;
  return {
    points,
    average,
    latest: points.at(-1) ?? null,
    trend: points.length ? suiteTrend(points) : null,
  };
}

export function suiteTrend(points: readonly SuiteSlicePoint[]): SuiteTrend {
  if (points.length < 2) return { kind: "single" };
  const runs = points.length;
  const flips = points.filter(
    (point, i) => i > 0 && point.passed !== points[i - 1].passed,
  ).length;
  if (flips >= FLAKY_FLIPS) {
    const passed = points.filter((point) => point.passed).length;
    return { kind: "flaky", passed, runs };
  }
  const delta = Math.round(points[runs - 1].rate - points[0].rate);
  if (Math.abs(delta) < STEADY_POINTS) return { kind: "steady", runs };
  return { kind: delta > 0 ? "up" : "down", points: Math.abs(delta), runs };
}

function toPoint(run: SuiteSliceRun): SuiteSlicePoint | null {
  const summary = run.summary;
  if (
    !summary ||
    isActiveRun(run) ||
    isSubsetRerunRun(run) ||
    run.result === "inconclusive"
  ) {
    return null;
  }
  return {
    runId: run._id,
    runNumber: run.runNumber,
    rate: toPercent(summary.passRate),
    passed: run.result === "passed",
    completedAt: run.completedAt ?? run.createdAt,
  };
}
