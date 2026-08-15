/**
 * Statistics for run-over-run comparison.
 *
 * ZERO imports, by construction. This module is pure arithmetic and must stay
 * browser-safe like `percentiles.ts` — it is reachable from the compare gates,
 * which the CLI and (later) the dashboard both evaluate.
 *
 * --- Why an interval and not a threshold ---
 *
 * "The pass rate dropped 4 points" is not evidence of a regression when the
 * run has 10 iterations: two coin flips move it that far. A CI gate that fires
 * on the point estimate alone teaches its users to ignore it. So the question
 * asked here is the honest one — is the whole plausible range of the
 * difference below zero? — and the answer has THREE outcomes, because "the
 * sample is too small to tell" is not "no regression".
 *
 * --- Which interval ---
 *
 * Newcombe's hybrid-score method (Newcombe 1998, method 10): a Wilson score
 * interval per side, combined into an interval for the difference. Chosen over
 * "do the two Wilson intervals overlap?", which is a different and
 * systematically CONSERVATIVE test — non-overlapping intervals imply a
 * significant difference, but the converse fails, so overlap-testing misses
 * real regressions. Also chosen over the Wald interval, which is badly behaved
 * exactly where eval runs live: small n and rates near 0 or 1, where Wald can
 * produce bounds outside [-1, 1] and has ~0 coverage at p = 1.
 *
 * --- The bounds are pinned against an EXTERNAL oracle ---
 *
 * `sdk/tests/fixtures/newcombe-oracle.json` carries interval bounds produced by
 * statsmodels, not by a second reading of this file. A test that re-derives the
 * formula it is checking proves only that it was transcribed consistently. The
 * fixture's `__meta` records the exact command and library version.
 *
 * Everything here is FRACTIONS in [0,1]. No percent, ever.
 */

/** Two-sided 95% normal quantile. Pinned so a bound cannot drift on a rounding. */
export const Z_95 = 1.959963984540054;

export type ProportionSample = {
  /** Iterations that passed. */
  passed: number;
  /** Iterations counted. `0` makes every derived statistic undecidable. */
  total: number;
};

export type ConfidenceInterval = {
  /** The observed proportion, `passed / total`. */
  point: number;
  lower: number;
  upper: number;
};

export type DifferenceInterval = {
  /** `pCompare - pBase`. NEGATIVE means the compare run did worse. */
  delta: number;
  lower: number;
  upper: number;
};

export type RegressionVerdict =
  /** The whole interval is below zero AND the effect clears the floor. */
  | "regression"
  /** Decidable, and no regression established. */
  | "no_regression"
  /**
   * Not decidable at this sample size. Deliberately NOT `no_regression`: a
   * 3-iteration run cannot clear a comparison, and reporting it as clean is
   * how a gate becomes decorative. Callers map this to incomplete / exit 3.
   */
  | "insufficient_data";

export type RegressionAssessment = DifferenceInterval & {
  verdict: RegressionVerdict;
  /** Populated for `insufficient_data`, so the CLI can name the shortfall. */
  reason?: string;
};

export type FlakyCase = {
  caseKey: string;
  total: number;
  passed: number;
  failed: number;
};

function clampUnit(value: number): number {
  // Newcombe bounds are mathematically within [-1,1]; floating point can land
  // a few ulps outside. Clamping is presentational, never load-bearing.
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/**
 * Wilson score interval for one proportion.
 *
 * Not `p ± z·√(p(1-p)/n)`. The Wald interval collapses to zero width at p = 0
 * and p = 1 — precisely the eval cases that matter ("everything passed", "the
 * new scorer fails everything") — and would report those as infinitely certain.
 * Wilson stays sensible there.
 *
 * `total <= 0` yields a degenerate `[0,1]` at point 0: no information, stated
 * as no information.
 */
export function wilsonInterval(
  passed: number,
  total: number,
  z: number = Z_95
): ConfidenceInterval {
  if (total <= 0) {
    return { point: 0, lower: 0, upper: 1 };
  }
  const point = passed / total;
  const zSquared = z * z;
  const denominator = total + zSquared;
  const center = (passed + zSquared / 2) / denominator;
  const spread =
    (z / denominator) *
    Math.sqrt((passed * (total - passed)) / total + zSquared / 4);
  return {
    point,
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
  };
}

/**
 * Newcombe hybrid-score interval for `pCompare - pBase`.
 *
 * Each bound pairs the tail of one side with the opposite tail of the other —
 * that pairing is the whole method, and getting it backwards produces an
 * interval that looks plausible and is wrong. It is checked against
 * statsmodels rather than against a re-reading of this comment.
 */
export function newcombeDifferenceInterval(args: {
  base: ProportionSample;
  compare: ProportionSample;
  z?: number;
}): DifferenceInterval {
  const z = args.z ?? Z_95;
  const base = wilsonInterval(args.base.passed, args.base.total, z);
  const compare = wilsonInterval(args.compare.passed, args.compare.total, z);
  const delta = compare.point - base.point;

  const lowerTerm = Math.sqrt(
    Math.pow(compare.point - compare.lower, 2) +
      Math.pow(base.upper - base.point, 2)
  );
  const upperTerm = Math.sqrt(
    Math.pow(compare.upper - compare.point, 2) +
      Math.pow(base.point - base.lower, 2)
  );

  return {
    delta,
    lower: clampUnit(delta - lowerTerm),
    upper: clampUnit(delta + upperTerm),
  };
}

/** Below this many iterations on EITHER side, a comparison is not decidable. */
export const DEFAULT_MIN_SAMPLE_SIZE = 5;
/** A drop smaller than this is noise worth ignoring even when significant. */
export const DEFAULT_MIN_EFFECT_SIZE = 0.01;

/**
 * Decide whether the compare run's pass rate regressed against the base run's.
 *
 * Two independent floors, and both must clear:
 *
 *   - MINIMUM SAMPLE. Under it, `insufficient_data`. A tiny run can produce a
 *     statistically "significant" swing that means nothing operationally, and
 *     more importantly a tiny run that regressed genuinely cannot be
 *     distinguished from one that got unlucky.
 *   - MINIMUM EFFECT. Above it, a 10,000-iteration run would flag a 0.1-point
 *     drift as a regression, which is true and useless.
 *
 * Significance itself is `upper < 0` — the entire plausible range of the
 * difference sits below zero.
 */
export function assessPassRateRegression(args: {
  base: ProportionSample;
  compare: ProportionSample;
  minSampleSize?: number;
  minEffectSize?: number;
  z?: number;
}): RegressionAssessment {
  const minSampleSize = args.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const minEffectSize = args.minEffectSize ?? DEFAULT_MIN_EFFECT_SIZE;
  const interval = newcombeDifferenceInterval({
    base: args.base,
    compare: args.compare,
    z: args.z,
  });

  if (args.base.total < minSampleSize || args.compare.total < minSampleSize) {
    return {
      ...interval,
      verdict: "insufficient_data",
      reason:
        `need at least ${minSampleSize} iterations on each side to decide a ` +
        `pass-rate regression (base ${args.base.total}, compare ` +
        `${args.compare.total})`,
    };
  }

  const significant = interval.upper < 0;
  const material = interval.delta <= -minEffectSize;
  return {
    ...interval,
    verdict: significant && material ? "regression" : "no_regression",
  };
}

/**
 * Cases that both passed and failed WITHIN one run — same scenario, same
 * config, different outcomes across iterations.
 *
 * Reported, never gated. Flakiness is a property of the case, not a
 * regression: the run before it was probably flaky too, and failing CI on it
 * would fail on noise the change did not introduce. It belongs in the report so
 * a human can see why a pass rate is wobbling.
 *
 * Sorted by `caseKey` so the output is stable.
 */
export function detectFlakyCases(
  iterations: Array<{ caseKey: string; passed: boolean }>
): FlakyCase[] {
  const byCase = new Map<string, { passed: number; failed: number }>();
  for (const iteration of iterations) {
    const entry = byCase.get(iteration.caseKey) ?? { passed: 0, failed: 0 };
    if (iteration.passed) entry.passed += 1;
    else entry.failed += 1;
    byCase.set(iteration.caseKey, entry);
  }

  const flaky: FlakyCase[] = [];
  for (const [caseKey, counts] of byCase) {
    if (counts.passed > 0 && counts.failed > 0) {
      flaky.push({
        caseKey,
        total: counts.passed + counts.failed,
        passed: counts.passed,
        failed: counts.failed,
      });
    }
  }
  return flaky.sort((left, right) => left.caseKey.localeCompare(right.caseKey));
}
