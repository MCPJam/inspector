/**
 * Compact previous-run deltas for the hero's per-pairing measurement rows.
 *
 * Colour is progress vs regression, not "up = green". The arrow follows the
 * number; the tone follows whether that movement helped.
 */
import {
  compareRunsBySequence,
  iterationLatencyP50,
  iterationLatencyP95,
  runClientIdentity,
} from "../evals/helpers";
import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import type { HeroStats } from "./run-verdict-hero-model";
import { resultCounts } from "./run-results-matrix-model";

export type HeroDeltaTone = "progress" | "regression" | "same";
export type HeroDeltaDirection = "up" | "down" | "same";

export type HeroStatDelta = {
  label: string;
  direction: HeroDeltaDirection;
  tone: HeroDeltaTone;
};

export type HeroStatDeltas = {
  passed: HeroStatDelta | null;
  latency: HeroStatDelta | null;
  tokens: HeroStatDelta | null;
  toolCalls: HeroStatDelta | null;
};

/**
 * The measurements the hero reports for ONE client/model pairing.
 *
 * Latency, tokens, and tool calls used to be a single page-level strip. They
 * are per-pairing here because that is the only altitude at which they answer
 * anything: two clients on one page have two different latencies, and the
 * average of the two describes neither.
 */
export type HeroPairingStats = {
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  tokens: number | null;
  toolCalls: number | null;
};

export type HeroPairingStatDeltas = {
  latencyP50: HeroStatDelta | null;
  latencyP95: HeroStatDelta | null;
  tokens: HeroStatDelta | null;
  toolCalls: HeroStatDelta | null;
};

/** One client/model pairing's pass/fail counts, for the hero list above the insights. */
export type HeroPairingPass = {
  key: string;
  client: string;
  model: string;
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
  total: number;
  delta: HeroStatDelta | null;
  /**
   * Passed as a share of the iterations that DECIDED — pending and cancelled
   * rows are not failures, and counting them as such would report a defect the
   * run never observed. Null when nothing has decided yet.
   */
  passRate: number | null;
  /** Movement in percentage points against the same pairing's previous run. */
  passRateDelta: HeroStatDelta | null;
  stats: HeroPairingStats;
  statDeltas: HeroPairingStatDeltas;
};

export type HeroPairingSource = {
  key: string;
  run: EvalSuiteRun;
  client: string;
  modelId: string;
  model: string;
  iterations: readonly EvalIteration[];
};

export function formatHeroCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${
      thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)
    }k`;
  }
  return String(value);
}

function signed(delta: number, formattedAbs: string): string {
  if (delta === 0) return "=";
  return `${delta > 0 ? "+" : "−"}${formattedAbs}`;
}

function directionOf(delta: number): HeroDeltaDirection {
  if (delta === 0) return "same";
  return delta > 0 ? "up" : "down";
}

/** `invert` is true when a smaller number is progress (latency, tokens, tools). */
function toneOf(delta: number, invert: boolean): HeroDeltaTone {
  if (delta === 0) return "same";
  const improved = invert ? delta < 0 : delta > 0;
  return improved ? "progress" : "regression";
}

/**
 * One signed movement between two measurements, or null when either side is
 * missing — there is no honest delta against a baseline that does not exist.
 */
export function deltaOf(
  current: number | null,
  previous: number | null,
  formatAbs: (value: number) => string,
  invert: boolean,
): HeroStatDelta | null {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  return {
    label: signed(delta, formatAbs(Math.abs(delta))),
    direction: directionOf(delta),
    tone: toneOf(delta, invert),
  };
}

function passedCount(stats: HeroStats): number | null {
  if (stats.cases.kind === "cases") return stats.cases.passed;
  if (stats.cases.kind === "trials") return stats.cases.passed;
  if (stats.cases.kind === "unavailable") return stats.iterations.passed;
  return null;
}

/**
 * Compare two hero strips that already use the same population.
 *
 * Passed only compares when both sides share a count basis — mixing a
 * case-variant total with an iteration fallback would paint a false arrow.
 */
export function buildHeroStatDeltas(
  current: HeroStats,
  previous: HeroStats,
): HeroStatDeltas {
  const samePassedBasis =
    current.cases.kind === previous.cases.kind ||
    (current.cases.kind === "unavailable" &&
      previous.cases.kind === "unavailable");

  return {
    passed: samePassedBasis
      ? deltaOf(passedCount(current), passedCount(previous), String, false)
      : null,
    latency: deltaOf(
      current.latencyP50Ms,
      previous.latencyP50Ms,
      (ms) => formatRunCaseLatencyMs(ms).replace("—", ""),
      true,
    ),
    tokens: deltaOf(current.tokens, previous.tokens, formatHeroCount, true),
    toolCalls: deltaOf(
      current.toolCalls,
      previous.toolCalls,
      formatHeroCount,
      true,
    ),
  };
}

/**
 * The immediately earlier completed run of the same suite, host, and model.
 *
 * Used when the strip is one pairing. A combined report uses the previous
 * launch instead — see {@link previousLaunchRuns}.
 */
export function previousCompletedRunOf(
  current: EvalSuiteRun,
  suiteRuns: readonly EvalSuiteRun[],
): EvalSuiteRun | null {
  return (
    [...suiteRuns]
      .filter(
        (run) =>
          run._id !== current._id &&
          run.status === "completed" &&
          runClientIdentity(run).key === runClientIdentity(current).key &&
          run.effectiveModelId === current.effectiveModelId &&
          (!current.runGroupId || run.runGroupId !== current.runGroupId) &&
          compareRunsBySequence(run, current) < 0,
      )
      .sort((a, b) => compareRunsBySequence(b, a))[0] ?? null
  );
}

export function pairingKey(run: EvalSuiteRun, modelId?: string): string {
  return `${runClientIdentity(run).key}::${
    modelId ?? run.effectiveModelId ?? run.client?.modelId ?? ""
  }`;
}

/** Passed polarity: more is progress, fewer is regression. No fake zeros. */
export function buildPassedDelta(
  current: number,
  previous: number | null,
): HeroStatDelta | null {
  return deltaOf(current, previous, String, false);
}

/** Latency, tokens, and tool calls over one pairing's rows. Absent stays absent. */
export function pairingStatsOf(
  iterations: readonly EvalIteration[],
): HeroPairingStats {
  let tokens: number | null = null;
  let toolCalls: number | null = null;
  for (const iteration of iterations) {
    if (typeof iteration.tokensUsed === "number") {
      tokens = (tokens ?? 0) + iteration.tokensUsed;
    }
    if (Array.isArray(iteration.actualToolCalls)) {
      toolCalls = (toolCalls ?? 0) + iteration.actualToolCalls.length;
    }
  }
  // The latency helpers take a mutable array and filter to completed rows
  // themselves, so these percentiles describe the same population the rest of
  // the product reports.
  const latencyInput = [...iterations];
  return {
    latencyP50Ms: iterationLatencyP50(latencyInput),
    latencyP95Ms: iterationLatencyP95(latencyInput),
    tokens,
    toolCalls,
  };
}

/**
 * Passed over the rows that DECIDED.
 *
 * Pending and cancelled iterations have not failed, so they leave the
 * denominator rather than dragging the rate toward a failure nobody observed.
 */
export function pairingPassRate(counts: {
  passed: number;
  failed: number;
}): number | null {
  const decided = counts.passed + counts.failed;
  if (decided === 0) return null;
  return (counts.passed / decided) * 100;
}

/**
 * Per-pairing pass rows for the hero. Each target is one client/model on this
 * page; the previous launch contributes a delta only when that same host+model
 * ran before.
 */
export function buildHeroPairings({
  targets,
  previousLaunch,
  previousIterations,
}: {
  targets: readonly HeroPairingSource[];
  previousLaunch: readonly EvalSuiteRun[] | null;
  previousIterations: readonly EvalIteration[] | null;
}): HeroPairingPass[] {
  return targets.map((target) => {
    const counts = resultCounts(target.iterations);
    const previousRows = previousRowsFor(
      target,
      previousLaunch,
      previousIterations,
      targets.length,
    );
    const previousCounts = previousRows ? resultCounts(previousRows) : null;
    const stats = pairingStatsOf(target.iterations);
    const previousStats = previousRows ? pairingStatsOf(previousRows) : null;
    const passRate = pairingPassRate(counts);
    return {
      key: target.key,
      client: target.client,
      model: target.model,
      passed: counts.passed,
      failed: counts.failed,
      pending: counts.pending,
      cancelled: counts.cancelled,
      total: target.iterations.length,
      delta: buildPassedDelta(counts.passed, previousCounts?.passed ?? null),
      passRate,
      passRateDelta: deltaOf(
        passRate,
        previousCounts ? pairingPassRate(previousCounts) : null,
        (points) => `${Math.round(points)}%`,
        false,
      ),
      stats,
      statDeltas: {
        latencyP50: deltaOf(
          stats.latencyP50Ms,
          previousStats?.latencyP50Ms ?? null,
          (ms) => formatRunCaseLatencyMs(ms).replace("—", ""),
          true,
        ),
        latencyP95: deltaOf(
          stats.latencyP95Ms,
          previousStats?.latencyP95Ms ?? null,
          (ms) => formatRunCaseLatencyMs(ms).replace("—", ""),
          true,
        ),
        tokens: deltaOf(
          stats.tokens,
          previousStats?.tokens ?? null,
          formatHeroCount,
          true,
        ),
        toolCalls: deltaOf(
          stats.toolCalls,
          previousStats?.toolCalls ?? null,
          formatHeroCount,
          true,
        ),
      },
    };
  });
}

/** The previous run's iteration rows for this same client/model, or null. */
function previousRowsFor(
  target: HeroPairingSource,
  previousLaunch: readonly EvalSuiteRun[] | null,
  previousIterations: readonly EvalIteration[] | null,
  targetCount: number,
): EvalIteration[] | null {
  if (!previousIterations || previousIterations.length === 0) return null;
  if (previousLaunch && previousLaunch.length > 0) {
    const key = pairingKey(target.run, target.modelId);
    const twin = previousLaunch.find((run) => pairingKey(run) === key);
    if (!twin) return null;
    const rows = previousIterations.filter(
      (iteration) => iteration.suiteRunId === twin._id,
    );
    return rows.length === 0 ? null : rows;
  }
  // Single-run page: previous rows are already scoped to that pairing.
  // Never roll a multi-pairing launch into every row.
  if (targetCount !== 1) return null;
  return [...previousIterations];
}

/**
 * The previous completed launch of this suite — the whole group, not one
 * client/model pairing.
 *
 * Combined hero numbers are aggregates ("21 of 48 iterations on this page").
 * Comparing that strip to a single previous pairing, or requiring every
 * current pairing to have a twin, leaves the arrows off.
 */
export function previousLaunchRuns(
  selectedRuns: readonly EvalSuiteRun[],
  suiteRuns: readonly EvalSuiteRun[],
  previousRunId?: string | null,
): EvalSuiteRun[] | null {
  if (selectedRuns.length === 0) return null;
  const currentIds = new Set(selectedRuns.map((run) => run._id));
  const newest = [...selectedRuns].sort((a, b) =>
    compareRunsBySequence(b, a),
  )[0];

  let anchor =
    (previousRunId
      ? (suiteRuns.find((run) => run._id === previousRunId) ?? null)
      : null) ??
    [...suiteRuns]
      .filter(
        (run) =>
          run.status === "completed" &&
          !currentIds.has(run._id) &&
          (newest.suiteId == null || run.suiteId === newest.suiteId) &&
          (!newest.runGroupId || run.runGroupId !== newest.runGroupId) &&
          compareRunsBySequence(run, newest) < 0,
      )
      .sort((a, b) => compareRunsBySequence(b, a))[0] ??
    null;

  if (!anchor) return null;
  if (anchor.runGroupId) {
    const group = suiteRuns.filter(
      (run) =>
        run.runGroupId === anchor.runGroupId && run.status === "completed",
    );
    if (group.length > 0) return group;
  }
  return [anchor];
}

/**
 * Iteration rows for the previous consecutive suite launch.
 *
 * Unfiltered combined reports use the whole previous launch. A client/model
 * filter keeps only that pairing's previous counterpart. Null when this is
 * the first launch, or when those rows are not on the page.
 */
export function previousHeroIterations({
  selectedRuns,
  suiteRuns,
  allIterations,
  previousRunId,
  matchSelectedPairings = false,
}: {
  selectedRuns: readonly EvalSuiteRun[];
  suiteRuns: readonly EvalSuiteRun[];
  allIterations: readonly EvalIteration[] | undefined;
  previousRunId?: string | null;
  matchSelectedPairings?: boolean;
}): EvalIteration[] | null {
  if (!allIterations || selectedRuns.length === 0) return null;

  const launch = previousLaunchRuns(selectedRuns, suiteRuns, previousRunId);
  let previousIds = launch?.map((run) => run._id) ?? [];
  if (previousIds.length === 0 && previousRunId) {
    previousIds = [previousRunId];
  }
  if (matchSelectedPairings && launch) {
    const wanted = new Set(selectedRuns.map((run) => pairingKey(run)));
    previousIds = launch
      .filter((run) => wanted.has(pairingKey(run)))
      .map((run) => run._id);
  }
  if (previousIds.length === 0) return null;

  const rows = allIterations.filter(
    (iteration) =>
      iteration.suiteRunId != null &&
      previousIds.includes(iteration.suiteRunId),
  );
  return rows.length > 0 ? rows : null;
}
