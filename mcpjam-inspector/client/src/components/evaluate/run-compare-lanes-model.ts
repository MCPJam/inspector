/**
 * The Compare runs table, as data.
 *
 * One LANE per thing that can be trended: a client × model pairing, keyed by
 * the run's environment where it has one. Every run in the suite appears,
 * newest first, and each row's deltas are scoped to its own lane — comparing a
 * Claude/Sonnet run against the Cursor/GPT run that happened to precede it
 * chronologically is how a fan-out launch invents regressions.
 *
 * Deliberately plain, and deliberately quiet: red always means worse, and a
 * row that has nothing honest to compare against shows nothing rather than a
 * zero. See {@link RunCompareRow.baselineRunId} for what "honest" costs.
 */
import { compactModelIdTail } from "@/lib/environment-label";
import {
  compareRunsBySequence,
  runClientIdentity,
  runContextKey,
} from "../evals/helpers";
import {
  buildSuiteMetricStripDataFromMetrics,
  formatCompactNumber,
  formatDurationMs,
} from "../evals/metric-strip-data";
import type { RunMetrics, RunMetricsByRun } from "../evals/run-metrics";
import type { EvalSuite, EvalSuiteRun } from "../evals/types";
import { launchRuns } from "./run-results-matrix-model";
import {
  deltaOf,
  pairingKey,
  type HeroStatDelta,
} from "./run-verdict-hero-deltas";

/**
 * What the row's pill says. A RESULT, not a gate verdict: this table reports
 * what each run did, it does not re-decide whether the suite ships.
 */
export type RunCompareStatus =
  | "running"
  | "passed"
  | "failed"
  | "inconclusive"
  | "completed"
  | "cancelled"
  | "timed_out";

/** One metric, already formatted, beside its lane-scoped movement. */
export type RunCompareCell = {
  value: string | null;
  delta: HeroStatDelta | null;
};

export type RunCompareRow = {
  runId: string;
  run: EvalSuiteRun;
  /** `"#12"`. */
  label: string;
  createdAt: number;
  modelTail: string | null;
  isCurrentRun: boolean;
  /** A sibling of the current run in the same fan-out launch. */
  inCurrentLaunch: boolean;
  /** The run reached a terminal state. `grading` has NOT. */
  settled: boolean;
  /** Settled AND every trial is on the page — the bar for derived metrics. */
  complete: boolean;
  status: RunCompareStatus;
  pass: RunCompareCell;
  /** `"7/8"`, from whichever source the pass percentage came from. */
  passDetail: string | null;
  p50: RunCompareCell;
  p95: RunCompareCell;
  tokens: RunCompareCell;
  /** The row every delta on this row is measured against, or null. */
  baselineRunId: string | null;
};

export type RunCompareLane = {
  key: string;
  /** The lane's newest run — feed it to `RunContextChip` for the visible label. */
  run: EvalSuiteRun;
  /** Screen-reader label only; the visible one is the chip. */
  label: string;
  /** Newest first. */
  rows: RunCompareRow[];
  currentRow: RunCompareRow | null;
  /**
   * Whether this lane's current run cleared the suite's pass threshold, or
   * null when there is no threshold, no current run, or nothing settled to
   * judge — which is why the strip counts settled lanes and not all of them.
   */
  meetsThreshold: boolean | null;
};

export type RunCompareHeader = {
  threshold: number | null;
  currentRunNumber: number;
  lanesMeeting: number;
  lanesSettled: number;
  lanesRunning: number;
};

/** Rows shown before a lane needs "See N more". */
export const RUN_COMPARE_LANE_PREVIEW_ROWS = 5;

/**
 * The suite's pass bar as a FRACTION.
 *
 * v2 stores a fraction; the legacy policy stores a percent, and reading one as
 * the other moves every bar by a factor of a hundred. There is no
 * `suite.settings.passThreshold`.
 */
export function resolveSuitePassThreshold(
  suite: Pick<EvalSuite, "verdictPolicyDefaults" | "defaultPassCriteria">,
): number | null {
  const v2 = suite.verdictPolicyDefaults?.passThreshold;
  if (typeof v2 === "number") return v2;
  const legacy = suite.defaultPassCriteria?.minimumPassRate;
  return typeof legacy === "number" ? legacy / 100 : null;
}

/**
 * What makes two runs comparable.
 *
 * An environment already pins a client AND a model, so an environment-backed
 * run keys on the environment alone — that is the "lanes are client × model,
 * keyed by the environment under the hood" decision, and it keeps rev 1 and
 * rev 2 of the same environment in one trend instead of splitting the lane
 * every time someone edits it.
 *
 * A legacy or host-backed run has no such pin, so it falls back to
 * `pairingKey` (client::model) and still splits by model.
 */
export function runCompareLaneKey(run: EvalSuiteRun): string {
  return run.configSnapshot?.environmentRef
    ? runContextKey(run)
    : pairingKey(run);
}

function runModelId(run: EvalSuiteRun): string | null {
  return run.effectiveModelId ?? run.client?.modelId ?? null;
}

function runModelTail(run: EvalSuiteRun): string | null {
  const modelId = runModelId(run);
  return modelId ? compactModelIdTail(modelId) : null;
}

function laneLabel(
  run: EvalSuiteRun,
  hostNamesById: ReadonlyMap<string, string | null> | undefined,
): string {
  const name = runClientIdentity(run, hostNamesById).name;
  const tail = runModelTail(run);
  return tail ? `${name} · ${tail}` : name;
}

function runLabel(run: EvalSuiteRun): string {
  return run.runNumber != null ? `#${run.runNumber}` : run._id.slice(0, 8);
}

/** `grading` is still happening — treating it as settled reports a verdict that does not exist. */
function isSettled(run: EvalSuiteRun): boolean {
  return !["pending", "running", "grading"].includes(run.status);
}

function runCompareStatus(run: EvalSuiteRun): RunCompareStatus {
  if (!isSettled(run)) return "running";
  const result = run.result;
  if (result === "passed" || result === "failed" || result === "inconclusive")
    return result;
  if (result === "timed_out" || run.status === "timed_out") return "timed_out";
  if (result === "cancelled" || run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  // Settled, terminal, and carrying no verdict at all — `result` is `null` on
  // every run that predates the field. Reporting those as "Cancelled" is a
  // false statement about runs that finished fine, and they are precisely the
  // history a trend table exists to show.
  return "completed";
}

/**
 * The platform reached a pass/fail answer for this run.
 *
 * A DENY-list, not an allow-list of `passed`/`failed`, and that is the whole
 * point: `result` is absent on every run older than the field, so allow-listing
 * the two decided values would drop all of that history out of `lanesMeeting`
 * while `lanesSettled` still counted it — a lane that cleared the bar reported
 * as one that did not.
 *
 * What it excludes:
 *   - `inconclusive` — the backend declined to decide. Its counts are the
 *     evidence it judged insufficient, and a threshold is a pass/fail
 *     question, so scoring it either way is exactly what `inconclusive` exists
 *     to prevent.
 *   - `cancelled` / `timed_out` — the summary is partial. Work a run never
 *     finished can neither clear a bar nor miss it.
 */
function isDecided(run: EvalSuiteRun): boolean {
  if (!isSettled(run)) return false;
  const status = runCompareStatus(run);
  return (
    status !== "inconclusive" &&
    status !== "cancelled" &&
    status !== "timed_out"
  );
}

/** `0`–`100`, rounded once so the cell and its delta cannot disagree. */
function wholePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

type RowMeasurements = {
  passPercent: number | null;
  passDetail: string | null;
  latencyP50: number | null;
  latencyP95: number | null;
  totalTokens: number | null;
  /** Settled, with every trial on the page. */
  complete: boolean;
  /**
   * The derived metrics are trustworthy. Strictly narrower than `complete`: an
   * `inconclusive` run is structurally complete and still has no metrics,
   * because its counts are exactly the evidence the backend distrusted.
   */
  hasMetrics: boolean;
};

function measureRun(
  run: EvalSuiteRun,
  runMetrics: RunMetrics | undefined,
): RowMeasurements {
  const settled = isSettled(run);
  const trialCount = runMetrics?.iterationCount ?? 0;
  // A run in flight has partial totals, and a run whose trials are not all
  // measured has partial evidence. Neither may be presented as final.
  const complete =
    settled &&
    trialCount > 0 &&
    (!run.summary || trialCount === run.summary.total);
  // The strip builder withholds an `inconclusive` run: its counts are exactly
  // the evidence the backend judged insufficient.
  const metrics =
    complete && runMetrics
      ? (buildSuiteMetricStripDataFromMetrics(
          [run],
          new Map([[run._id, runMetrics]]),
        )?.latest ?? null)
      : null;

  // The stamped summary is authoritative the moment the run settles — it does
  // not wait on loaded trials the way the derived metrics do.
  const summary = settled ? run.summary : undefined;
  const fromSummary = summary && summary.total > 0;

  return {
    passPercent: fromSummary
      ? wholePercent((summary.passed / summary.total) * 100)
      : metrics
        ? wholePercent(metrics.passRate)
        : null,
    passDetail: fromSummary
      ? `${summary.passed}/${summary.total}`
      : metrics
        ? `${metrics.passed}/${metrics.total}`
        : null,
    latencyP50: metrics?.latencyP50 ?? null,
    latencyP95: metrics?.latencyP95 ?? null,
    totalTokens: complete ? (runMetrics?.tokensTotal ?? 0) : null,
    complete,
    hasMetrics: metrics != null,
  };
}

export function buildRunCompareLanes({
  currentRun,
  runs,
  metricsByRun,
  hostNamesById,
  passThreshold,
}: {
  currentRun: EvalSuiteRun;
  runs: readonly EvalSuiteRun[];
  /** One metrics object per run — see `evals/run-metrics.ts`. */
  metricsByRun: RunMetricsByRun;
  hostNamesById?: ReadonlyMap<string, string | null>;
  passThreshold: number | null;
}): { header: RunCompareHeader; lanes: RunCompareLane[] } {
  const all = runs.some((run) => run._id === currentRun._id)
    ? [...runs]
    : [...runs, currentRun];
  const currentLaunchIds = new Set(
    launchRuns(currentRun, all).map((run) => run._id),
  );

  const grouped = new Map<string, EvalSuiteRun[]>();
  for (const run of all) {
    const key = runCompareLaneKey(run);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(run);
    else grouped.set(key, [run]);
  }

  const lanes: RunCompareLane[] = [];
  for (const [key, laneRuns] of grouped) {
    const ordered = [...laneRuns].sort(
      (a, b) => compareRunsBySequence(b, a) || a._id.localeCompare(b._id),
    );
    const measured = ordered.map((run) => ({
      run,
      measurements: measureRun(run, metricsByRun.get(run._id)),
    }));

    const rows: RunCompareRow[] = measured.map((entry, index) => {
      const { run, measurements } = entry;
      // The first OLDER row with trustworthy metrics that is not a sibling of
      // this one. A fan-out launch writes N runs at once; a sibling is a
      // parallel arm, not a previous data point, so comparing against one
      // reports a model difference as a regression over time.
      //
      // `runs` is capped upstream (100), so the oldest visible row in a long
      // lane can legitimately show `—` even though older runs exist. Widening
      // that needs a new query, not a wider scan here.
      const baseline = measurements.hasMetrics
        ? (measured
            .slice(index + 1)
            .find(
              (candidate) =>
                candidate.measurements.hasMetrics &&
                (candidate.run.runGroupId == null ||
                  candidate.run.runGroupId !== run.runGroupId),
            ) ?? null)
        : null;
      const base = baseline?.measurements ?? null;

      return {
        runId: run._id,
        run,
        label: runLabel(run),
        createdAt: run.createdAt,
        modelTail: runModelTail(run),
        isCurrentRun: run._id === currentRun._id,
        inCurrentLaunch: currentLaunchIds.has(run._id),
        settled: isSettled(run),
        complete: measurements.complete,
        status: runCompareStatus(run),
        pass: {
          value:
            measurements.passPercent != null
              ? `${measurements.passPercent}%`
              : null,
          delta: deltaOf(
            measurements.passPercent,
            base?.passPercent ?? null,
            (points) => `${points}%`,
            false,
          ),
        },
        passDetail: measurements.passDetail,
        p50: {
          value:
            measurements.latencyP50 != null
              ? formatDurationMs(measurements.latencyP50)
              : null,
          delta: deltaOf(
            measurements.latencyP50,
            base?.latencyP50 ?? null,
            formatDurationMs,
            true,
          ),
        },
        p95: {
          value:
            measurements.latencyP95 != null
              ? formatDurationMs(measurements.latencyP95)
              : null,
          delta: deltaOf(
            measurements.latencyP95,
            base?.latencyP95 ?? null,
            formatDurationMs,
            true,
          ),
        },
        tokens: {
          value:
            measurements.totalTokens != null
              ? formatCompactNumber(measurements.totalTokens)
              : null,
          delta: deltaOf(
            measurements.totalTokens,
            base?.totalTokens ?? null,
            formatCompactNumber,
            true,
          ),
        },
        baselineRunId: baseline?.run._id ?? null,
      };
    });

    const inLaunch = rows.filter((row) => row.inCurrentLaunch);
    const currentRow =
      inLaunch.find((row) => row.isCurrentRun) ?? inLaunch[0] ?? null;
    // `lanesSettled` stays on settlement (below); only the pass/fail JUDGEMENT
    // needs a decided run.
    const summary =
      currentRow && isDecided(currentRow.run)
        ? currentRow.run.summary
        : undefined;

    lanes.push({
      key,
      run: rows[0].run,
      label: laneLabel(rows[0].run, hostNamesById),
      rows,
      currentRow,
      // The EXACT fraction, never the rounded percent on screen: a suite whose
      // bar is 0.9 must not pass on 89.6% because the cell rounds to 90%.
      meetsThreshold:
        passThreshold != null && summary && summary.total > 0
          ? summary.passed / summary.total >= passThreshold
          : null,
    });
  }

  // Lanes this launch touched come first, in run order, so the runs the reader
  // arrived to look at are at the top; everything else is history, newest
  // lane first.
  lanes.sort((a, b) => {
    if (a.currentRow && b.currentRow)
      return (
        compareRunsBySequence(a.currentRow.run, b.currentRow.run) ||
        a.key.localeCompare(b.key)
      );
    if (a.currentRow) return -1;
    if (b.currentRow) return 1;
    return (
      b.rows[0].createdAt - a.rows[0].createdAt || a.key.localeCompare(b.key)
    );
  });

  return {
    header: {
      threshold: passThreshold,
      currentRunNumber: currentRun.runNumber,
      lanesMeeting: lanes.filter((lane) => lane.meetsThreshold === true).length,
      lanesSettled: lanes.filter((lane) => lane.currentRow?.settled).length,
      lanesRunning: lanes.filter(
        (lane) => lane.currentRow != null && !lane.currentRow.settled,
      ).length,
    },
    lanes,
  };
}
