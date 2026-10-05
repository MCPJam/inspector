/**
 * Flag parsing and input assembly for `mcpjam cloud eval compare`.
 *
 * Mirrors `eval-gate.ts`: kept out of `commands/eval.ts` so the parsing rules —
 * especially the percent→fraction boundary — are unit-testable without booting
 * commander.
 *
 * `--min-effect-size-percent` is the ONLY percent on this surface, and it is
 * converted here and nowhere else. Everything downstream is fractions.
 */

import type {
  CompareGateInput,
  DeterministicScoreRegression,
  EvalVerdictTrialStatistics,
  GateInput,
  GatePolicy,
  ProportionSample,
} from "@mcpjam/sdk";
import type {
  PlatformEvalIteration,
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "@mcpjam/sdk/platform";
import { usageError } from "./output.js";

export type EvalCompareOptions = {
  gateRegressions?: boolean;
  minSampleSize?: string;
  /** PERCENT at the boundary (0–100), converted to a fraction immediately. */
  minEffectSizePercent?: string;
  gateDeterministicRegressions?: boolean;
  maxP95LatencyIncreaseMs?: string;
  /** PERCENT increase over the baseline's cost (0–…), not a fraction. */
  maxCostIncreasePercent?: string;
};

function parseNonNegativeInteger(raw: string, flag: string): number {
  // Blank is rejected explicitly: `Number("")` is 0, and a silent 0 here would
  // disable the minimum-sample floor entirely.
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(`${flag} must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

/**
 * A non-negative decimal percentage, left AS a percentage.
 *
 * Distinct from `parsePercentAsFraction` above, which divides by 100 for the
 * engine's fraction-valued fields, and from it also in having no upper bound:
 * a run costing three times its baseline is a 200% increase.
 */
function parseNonNegativeDecimal(raw: string, flag: string): number {
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw usageError(`${flag} must be a non-negative number, got "${raw}".`);
  }
  return value;
}

function parsePercentAsFraction(raw: string, flag: string): number {
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw usageError(
      `${flag} must be a number between 0 and 100, got "${raw}".`
    );
  }
  return value / 100;
}

/**
 * Build the comparative half of a gate policy from flags.
 *
 * `--gate-regressions` with no tuning flags still produces a
 * `passRateRegression: {}`, so the SDK's defaults apply — an absent key would
 * mean "do not evaluate", which is the opposite of what the flag asks for.
 */
export function comparePolicyFromOptions(
  options: EvalCompareOptions
): GatePolicy {
  const policy: GatePolicy = {};

  const tuning: { minSampleSize?: number; minEffectSize?: number } = {};
  if (options.minSampleSize !== undefined) {
    tuning.minSampleSize = parseNonNegativeInteger(
      options.minSampleSize,
      "--min-sample-size"
    );
  }
  if (options.minEffectSizePercent !== undefined) {
    tuning.minEffectSize = parsePercentAsFraction(
      options.minEffectSizePercent,
      "--min-effect-size-percent"
    );
  }
  // Tuning without the gate is a usage error, not a silent no-op: the author
  // asked for a threshold on a gate they never enabled, and honouring neither
  // half quietly is how a policy ends up decorative.
  if (Object.keys(tuning).length > 0 && !options.gateRegressions) {
    throw usageError(
      "--min-sample-size and --min-effect-size-percent tune the pass-rate " +
        "regression gate; pass --gate-regressions to enable it."
    );
  }
  if (options.gateRegressions) policy.passRateRegression = tuning;

  if (options.gateDeterministicRegressions) {
    policy.noDeterministicRegressions = true;
  }
  if (options.maxP95LatencyIncreaseMs !== undefined) {
    policy.maximumP95LatencyIncreaseMs = parseNonNegativeInteger(
      options.maxP95LatencyIncreaseMs,
      "--max-p95-latency-increase-ms"
    );
  }
  if (options.maxCostIncreasePercent !== undefined) {
    // NOT `parsePercentAsFraction`: this threshold is compared against a
    // percentage the gate computes (`(compare - base) / base * 100`), so
    // converting it to a fraction here would make `--max-cost-increase-percent
    // 10` mean 0.1% — a hundredfold-stricter gate than the author wrote.
    // Also not capped at 100: a run that costs three times the baseline is a
    // 200% increase, and a ceiling above 100 is a legitimate thing to allow.
    policy.maximumCostIncreasePercent = parseNonNegativeDecimal(
      options.maxCostIncreasePercent,
      "--max-cost-increase-percent"
    );
  }
  return policy;
}

/** Case statuses that mean the two runs no longer cover the same case set. */
const CASE_SET_CHANGED_STATUSES = new Set(["new_case", "removed_case"]);

/**
 * Rows where a GATING, DETERMINISTIC scorer flipped `passed: true -> false`
 * under an UNCHANGED definition.
 *
 * Every one of those four conditions removes a false positive:
 *   - gating: an advisory scorer going red is information, not a gate.
 *   - deterministic: a judge disagreeing between two runs is the judge being a
 *     judge, not the product regressing.
 *   - definition unchanged: the same id graded by a different definition did
 *     not measure the same thing twice.
 *   - true -> false specifically: a scorer that was already failing has not
 *     regressed, and one with no base row is new.
 */
export function deterministicRegressionsFrom(
  cases: PlatformRunCompareCase[]
): DeterministicScoreRegression[] {
  const regressions: DeterministicScoreRegression[] = [];
  for (const row of cases) {
    for (const delta of row.scoreDeltas) {
      if (!delta.gating || !delta.deterministic) continue;
      if (delta.definitionChanged) continue;
      if (delta.base?.passed === true && delta.compare?.passed === false) {
        regressions.push({ caseKey: row.caseKey, scorerId: delta.scorerId });
      }
    }
  }
  return regressions;
}

/**
 * Whether every SHARED case ran the same number of iterations on both sides.
 *
 * New and removed cases are excluded deliberately — they have no counterpart to
 * weigh against, and `caseSetChanged` already reports them. What this catches
 * is the quiet case: a case that exists on both sides but ran five times
 * instead of two, silently reweighting the whole-run totals.
 */
export function iterationWeightingEqualFrom(
  cases: PlatformRunCompareCase[]
): boolean {
  for (const row of cases) {
    if (row.base.outcome === "absent" || row.compare.outcome === "absent") {
      continue;
    }
    if (row.base.iterationIds.length !== row.compare.iterationIds.length) {
      return false;
    }
  }
  return true;
}

/** Where a comparison's pass-rate sample came from. */
export type CompareSampleBasis = "eligibleTrials" | "legacySummary";

export type CompareSample = {
  basis: CompareSampleBasis;
  base: ProportionSample;
  compare: ProportionSample;
};

/**
 * The sample each side of the pass-rate comparison is sized by.
 *
 * `summary.total` is not one unit: it counts iterations for a hosted legacy
 * run, variant-collapsed cases for an SDK legacy run, and case variants for a
 * per-case-graded run. A Newcombe interval over it weighs the same evidence as
 * 3 observations on one surface and 15 on another. So when BOTH sides carry
 * per-case-graded trial statistics, the sample is their ELIGIBLE TRIALS — one
 * unit everywhere, with infrastructure failures and evaluator errors already
 * out of it. Otherwise BOTH sides fall back to the legacy summary: never one
 * of each, which would set a trial count against a case count.
 */
export function compareSampleFrom(compare: PlatformRunCompare): CompareSample {
  const baseStatistics = compare.baseRun.trialStatistics;
  const compareStatistics = compare.compareRun.trialStatistics;
  if (baseStatistics !== undefined && compareStatistics !== undefined) {
    return {
      basis: "eligibleTrials",
      base: {
        total: baseStatistics.eligibleTrials,
        passed: baseStatistics.passedTrials,
      },
      compare: {
        total: compareStatistics.eligibleTrials,
        passed: compareStatistics.passedTrials,
      },
    };
  }
  const legacy = (
    summary: PlatformRunCompare["baseRun"]["summary"]
  ): ProportionSample => ({
    total: summary?.total ?? 0,
    passed: summary?.passed ?? 0,
  });
  return {
    basis: "legacySummary",
    base: legacy(compare.baseRun.summary),
    compare: legacy(compare.compareRun.summary),
  };
}

/**
 * The report-only trial statistics `eval compare` prints beside its gate
 * report: which sample sized the comparison, and each side's per-case pass@k,
 * pass^k and Wilson interval rows (`null` for a side that carries none — a
 * legacy run, or a deployment predating the field). Never gated on.
 */
export function compareTrialStatisticsFrom(compare: PlatformRunCompare): {
  sample: CompareSample;
  base: EvalVerdictTrialStatistics | null;
  compare: EvalVerdictTrialStatistics | null;
} {
  return {
    sample: compareSampleFrom(compare),
    base: compare.baseRun.trialStatistics ?? null,
    compare: compare.compareRun.trialStatistics ?? null,
  };
}

function sideFromRun(
  sample: ProportionSample,
  integrity: "valid" | "invalid" | null,
  e2eP95Ms: number | undefined,
  cost: {
    costUsd?: number;
    costCoverage?: { costed: number; total: number };
  } = {}
): GateInput {
  const totals = {
    ...(e2eP95Ms !== undefined ? { e2eP95Ms } : {}),
    ...(cost.costUsd !== undefined ? { costUsd: cost.costUsd } : {}),
    ...(cost.costCoverage !== undefined
      ? { costCoverage: cost.costCoverage }
      : {}),
  };
  return {
    iterations: { total: sample.total, passed: sample.passed },
    ...(integrity ? { scoreIntegrity: integrity } : {}),
    ...(Object.keys(totals).length > 0 ? { totals } : {}),
  };
}

/**
 * Assemble the comparative gate input from the wire DTO.
 *
 * p95 is passed in rather than read off the DTO: the compare wire carries
 * whole-run metrics, not per-iteration durations, and a p95 must be computed
 * from the iterations. Absent p95 makes the latency gate non-gateable, which
 * is correct — a latency budget evaluated against a guess is worse than none.
 */
export function compareGateInputFrom(
  compare: PlatformRunCompare,
  latency: { baseP95Ms?: number; compareP95Ms?: number } = {}
): CompareGateInput {
  const cases = compare.cases;
  const sample = compareSampleFrom(compare);
  return {
    // Cost comes STRAIGHT OFF the wire, unlike p95: the compare DTO already
    // carries whole-run cost with its coverage, so no iteration fetch is
    // needed to decide a cost-increase gate. Coverage travels with it because
    // the gate refuses on a partial sum — a run we priced less of would
    // otherwise read as the cheaper run.
    base: sideFromRun(
      sample.base,
      compare.scoreContract.base.scoreIntegrity,
      latency.baseP95Ms,
      {
        ...(typeof compare.metrics.estimatedCostUsd.base === "number"
          ? { costUsd: compare.metrics.estimatedCostUsd.base }
          : {}),
        ...(compare.metrics.costCoverage
          ? { costCoverage: compare.metrics.costCoverage.base }
          : {}),
      }
    ),
    compare: sideFromRun(
      sample.compare,
      compare.scoreContract.compare.scoreIntegrity,
      latency.compareP95Ms,
      {
        ...(typeof compare.metrics.estimatedCostUsd.compare === "number"
          ? { costUsd: compare.metrics.estimatedCostUsd.compare }
          : {}),
        ...(compare.metrics.costCoverage
          ? { costCoverage: compare.metrics.costCoverage.compare }
          : {}),
      }
    ),
    deterministicScoreRegressions: deterministicRegressionsFrom(cases),
    scoreDeltasAvailable: cases.some((row) => row.scoreDeltas.length > 0),
    caseSetChanged: cases.some((row) =>
      CASE_SET_CHANGED_STATUSES.has(row.status)
    ),
    scenarioConfigChanged: cases.some((row) => row.configChanged),
    // Run-level OR any single case's own. A suite that re-grades ONE case has
    // changed what that case measures, and the whole-run rate now mixes two
    // measurements — the run-level hash alone would miss it.
    evaluationConfigChanged:
      compare.scoreContract.evaluationConfigChanged ||
      cases.some((row) => row.evaluationConfigChanged),
    iterationWeightingEqual: iterationWeightingEqualFrom(cases),
  };
}

/** Flatten iterations into the shape `detectFlakyCases` reads. */
export function flakyInputFrom(
  iterations: PlatformEvalIteration[]
): Array<{ caseKey: string; passed: boolean }> {
  return (
    iterations
      // A pending iteration has `result: null`. Mapping that to `passed: false`
      // would make a half-finished case look like it both passed and failed —
      // a fabricated flake.
      .filter(
        (iteration) =>
          iteration.result === "passed" || iteration.result === "failed"
      )
      .map((iteration) => ({
        // Falls back to the iteration's own id, never a shared literal: a
        // single "unknown" bucket would pool unrelated iterations, and one pass
        // plus one fail from two DIFFERENT cases would be reported as a flake
        // that never existed.
        caseKey: iteration.testCaseId ?? iteration.title ?? iteration.id,
        passed: iteration.result === "passed",
      }))
  );
}
