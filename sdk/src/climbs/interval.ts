/**
 * The confirmation's interval: a 95% interval on the difference between the
 * best server and the baseline, found by resampling cases.
 *
 * The case is the unit, not the iteration: both servers run the same cases and
 * one case's iterations move together, so counting iterations as independent
 * would make the interval look tighter than it is. The seed is fixed, so the
 * same stored measurements give the same interval whenever they are read. The
 * backend stores per-case measurements and nothing more; this is computed on
 * read.
 */
import type { PlatformClimbMeasure } from "../platform/climb-types.js";

/** One case in one environment on one arm, as the backend stored it. */
export type ConfirmationCaseRow = {
  environmentId: string;
  caseKey: string;
  arm: "baseline" | "best";
  counted: number;
  passed: number;
  lost: number;
  m: {
    tokens: { sum: number; n: number; missing: number };
    cost: { sum: number; n: number; missing: number };
    tool_calls: { sum: number; n: number; missing: number };
  };
};

export type ConfirmationInterval = {
  environmentId: string;
  measure: PlatformClimbMeasure;
  /** Pass rate in percentage points; tokens, cost and tool calls as the change in percent (negative is fewer). */
  unit: "points" | "percent";
  cases: number;
  /** The difference in the measure, best against baseline. Null when no case could be compared. */
  difference: number | null;
  low: number | null;
  high: number | null;
  includesZero: boolean;
  /** Which side of zero is a gain for this measure. */
  better: "higher" | "lower";
  /** Pass rate beside the measure, when the measure is something else. */
  passRate?: { baselineBps: number | null; bestBps: number | null };
  note?: string;
};

const RESAMPLES = 4_000;
export const CONFIRMATION_SEED = 0x2024_1124;
const MIN_CASES = 2;

/** mulberry32: small, seedable and the same everywhere. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pair = { baseline: ConfirmationCaseRow; best: ConfirmationCaseRow };

function pairsOf(rows: readonly ConfirmationCaseRow[], environmentId: string): Pair[] {
  const byCase = new Map<string, Partial<Pair>>();
  for (const row of rows.filter((candidate) => candidate.environmentId === environmentId)) {
    byCase.set(row.caseKey, { ...byCase.get(row.caseKey), [row.arm]: row });
  }
  return [...byCase.values()].filter((pair): pair is Pair => !!pair.baseline && !!pair.best);
}

const rate = (pairs: readonly Pair[], arm: "baseline" | "best"): number | null => {
  const counted = pairs.reduce((sum, pair) => sum + pair[arm].counted, 0);
  return counted === 0 ? null : pairs.reduce((sum, pair) => sum + pair[arm].passed, 0) / counted;
};

type RatioMeasure = Exclude<PlatformClimbMeasure, "pass_rate">;

/** Best's total over baseline's, on cases both passed at least once with the measure recorded (as the keep rule's ratio). */
function ratio(pairs: readonly Pair[], measure: RatioMeasure): number | null {
  let best = 0;
  let baseline = 0;
  let compared = 0;
  for (const { baseline: a, best: b } of pairs) {
    if (a.m[measure].n === 0 || b.m[measure].n === 0) continue;
    baseline += a.m[measure].sum / a.m[measure].n;
    best += b.m[measure].sum / b.m[measure].n;
    compared += 1;
  }
  return compared === 0 || baseline === 0 ? null : best / baseline;
}

/** The statistic on one set of paired cases: points of pass rate, or percent change of a ratio. */
function statistic(pairs: readonly Pair[], measure: PlatformClimbMeasure): number | null {
  if (measure === "pass_rate") {
    const [baseline, best] = [rate(pairs, "baseline"), rate(pairs, "best")];
    return baseline === null || best === null ? null : (best - baseline) * 100;
  }
  const value = ratio(pairs, measure);
  return value === null ? null : (value - 1) * 100;
}

export function confirmationInterval(
  rows: readonly ConfirmationCaseRow[],
  environmentId: string,
  measure: PlatformClimbMeasure,
  seed: number = CONFIRMATION_SEED,
): ConfirmationInterval {
  const pairs = pairsOf(rows, environmentId);
  const point = statistic(pairs, measure);
  const base = {
    environmentId,
    measure,
    unit: measure === "pass_rate" ? ("points" as const) : ("percent" as const),
    cases: pairs.length,
    better: measure === "pass_rate" ? ("higher" as const) : ("lower" as const),
    ...(measure === "pass_rate"
      ? {}
      : { passRate: { baselineBps: toBps(rate(pairs, "baseline")), bestBps: toBps(rate(pairs, "best")) } }),
  };
  if (point === null) {
    return { ...base, difference: null, low: null, high: null, includesZero: true, note: "No case could be compared on this measure, so there is no difference to report." };
  }
  if (pairs.length < MIN_CASES) {
    return { ...base, difference: round(point), low: null, high: null, includesZero: true, note: `With ${pairs.length} confirmation case an interval cannot be found: the difference is one case's.` };
  }
  const next = random(seed);
  const draws: number[] = [];
  for (let draw = 0; draw < RESAMPLES; draw += 1) {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(next() * pairs.length)]!);
    const value = statistic(sample, measure);
    if (value !== null) draws.push(value);
  }
  draws.sort((a, b) => a - b);
  const low = draws[Math.floor(draws.length * 0.025)] ?? point;
  const high = draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.975))] ?? point;
  return { ...base, difference: round(point), low: round(low), high: round(high), includesZero: low <= 0 && high >= 0 };
}

const toBps = (value: number | null) => (value === null ? null : Math.round(value * 10_000));
const round = (value: number) => Math.round(value * 100) / 100;
