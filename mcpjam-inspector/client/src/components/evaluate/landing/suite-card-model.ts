/**
 * A suite card's health, from the overview's recent runs alone: which runs
 * count, their average, the last five as bars, and the trend over those bars.
 */
import { isSubsetRerunRun } from "../../evals/helpers";
import { isActiveRun } from "../../evals/run-metrics";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../../evals/types";
import { latestActivityAt } from "../suites-overview";

export interface SuiteCardPoint {
  runId: string;
  runNumber: number;
  createdAt: number;
  passed: number;
  total: number;
  /** 100 * passed / total, unrounded. */
  rate: number;
  verdict: "passed" | "failed";
}

export type SuiteCardTrend =
  | { kind: "one" }
  | { kind: "flaky"; passed: number; of: number }
  | { kind: "steady"; of: number }
  | { kind: "up" | "down"; points: number; of: number };

export interface SuiteCardHealth {
  /** Counted runs, oldest → newest, at most 10 (the overview's window). */
  counted: SuiteCardPoint[];
  /** The last 5 of `counted`, oldest → newest: the bars. */
  points: SuiteCardPoint[];
  /** Mean of counted rates; null when none. */
  average: number | null;
  /** null when `points` is empty. */
  trend: SuiteCardTrend | null;
}

const BAR_COUNT = 5;
const FLAKY_FLIPS = 3;
const STEADY_POINTS = 3;
const UNMEASURED_RESULTS: ReadonlySet<string> = new Set([
  "inconclusive",
  "cancelled",
  "timed_out",
]);

/** Mirrors the backend's trend filter: a run whose rate says something about the suite. */
function isCounted(run: EvalSuiteRun): boolean {
  return (
    !isSubsetRerunRun(run) &&
    !isActiveRun(run) &&
    !(run.result && UNMEASURED_RESULTS.has(run.result)) &&
    (run.summary?.total ?? 0) > 0
  );
}

/** A run with no stored verdict passed when nothing failed. */
export function runVerdict(run: EvalSuiteRun): "passed" | "failed" {
  if (run.result === "passed") return "passed";
  if (run.result === undefined && run.summary?.failed === 0) return "passed";
  return "failed";
}

function toPoint(run: EvalSuiteRun): SuiteCardPoint {
  const passed = run.summary?.passed ?? 0;
  const total = run.summary?.total ?? 0;
  return {
    runId: run._id,
    runNumber: run.runNumber,
    createdAt: run.createdAt,
    passed,
    total,
    rate: (100 * passed) / total,
    verdict: runVerdict(run),
  };
}

function trendOf(points: readonly SuiteCardPoint[]): SuiteCardTrend | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { kind: "one" };
  const of = points.length;
  const flips = points.filter(
    (point, index) => index > 0 && point.verdict !== points[index - 1].verdict,
  ).length;
  if (flips >= FLAKY_FLIPS) {
    const passed = points.filter((point) => point.verdict === "passed").length;
    return { kind: "flaky", passed, of };
  }
  const delta = Math.round(points[of - 1].rate - points[0].rate);
  if (Math.abs(delta) < STEADY_POINTS) return { kind: "steady", of };
  return { kind: delta > 0 ? "up" : "down", points: Math.abs(delta), of };
}

export function buildSuiteCardHealth(
  entry: EvalSuiteOverviewEntry,
): SuiteCardHealth {
  const counted = entry.recentRuns
    .filter(isCounted)
    .map(toPoint)
    .sort((a, b) => a.createdAt - b.createdAt || a.runNumber - b.runNumber);
  const points = counted.slice(-BAR_COUNT);
  const average = counted.length
    ? counted.reduce((sum, point) => sum + point.rate, 0) / counted.length
    : null;
  return { counted, points, average, trend: trendOf(points) };
}

export type SuiteCardSort = "recent" | "name" | "passRate";

export const SUITE_CARD_SORTS: readonly {
  value: SuiteCardSort;
  label: string;
}[] = [
  { value: "recent", label: "Last run" },
  { value: "name", label: "Name" },
  { value: "passRate", label: "Pass rate (lowest first)" },
];

export function suiteDisplayName(entry: EvalSuiteOverviewEntry): string {
  return entry.suite.name.trim() || "Untitled suite";
}

type SuiteCardRow = { entry: EvalSuiteOverviewEntry; health: SuiteCardHealth };

export function sortSuiteCards<T extends SuiteCardRow>(
  rows: readonly T[],
  sort: SuiteCardSort,
): T[] {
  const sorted = [...rows];
  if (sort === "name") {
    return sorted.sort((a, b) =>
      suiteDisplayName(a.entry).localeCompare(suiteDisplayName(b.entry)),
    );
  }
  if (sort === "passRate") {
    return sorted.sort(
      (a, b) => (a.health.average ?? Infinity) - (b.health.average ?? Infinity),
    );
  }
  return sorted.sort(
    (a, b) => latestActivityAt(b.entry) - latestActivityAt(a.entry),
  );
}

/** Keeps suites whose display name contains the trimmed query, case-insensitive. */
export function searchSuiteCards<T extends SuiteCardRow>(
  rows: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    suiteDisplayName(row.entry).toLowerCase().includes(needle),
  );
}

export type LatestRunState =
  | { kind: "none" }
  | { kind: "verdict"; verdict: "passed" | "failed"; rate: number }
  | { kind: "other"; label: string };

const OTHER_RESULT_LABELS: Record<string, string> = {
  inconclusive: "Inconclusive",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

/** What the right column says about the backend's latest non-subset run. */
export function latestRunState(run: EvalSuiteRun | null): LatestRunState {
  if (!run) return { kind: "none" };
  if (isActiveRun(run)) return { kind: "other", label: "Running" };
  const other =
    (run.result && OTHER_RESULT_LABELS[run.result]) ||
    OTHER_RESULT_LABELS[run.status];
  if (other) return { kind: "other", label: other };
  const summary = run.summary;
  const rate =
    summary && summary.total > 0
      ? Math.round((100 * summary.passed) / summary.total)
      : 0;
  return { kind: "verdict", verdict: runVerdict(run), rate };
}

/**
 * The run ids a Cancel stops: every active run of the latest run's launch, or
 * the latest run alone when it has no group.
 */
export function activeLaunchRunIds(entry: EvalSuiteOverviewEntry): string[] {
  const latest = entry.latestRun;
  if (!latest) return [];
  if (!latest.runGroupId) return [latest._id];
  const ids = entry.recentRuns
    .filter((run) => run.runGroupId === latest.runGroupId && isActiveRun(run))
    .map((run) => run._id);
  return ids.includes(latest._id) ? ids : [latest._id, ...ids];
}
