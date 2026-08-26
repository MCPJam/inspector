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
  GateInput,
  GatePolicy,
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
};

function parseNonNegativeInteger(raw: string, flag: string): number {
  // Blank is rejected explicitly: `Number("")` is 0, and a silent 0 here would
  // disable the minimum-sample floor entirely.
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(
      `${flag} must be a non-negative integer, got "${raw}".`
    );
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

function sideFromRun(
  summary: PlatformRunCompare["baseRun"]["summary"],
  integrity: "valid" | "invalid" | null,
  e2eP95Ms: number | undefined
): GateInput {
  return {
    iterations: {
      total: summary?.total ?? 0,
      passed: summary?.passed ?? 0,
    },
    ...(integrity ? { scoreIntegrity: integrity } : {}),
    ...(e2eP95Ms !== undefined ? { totals: { e2eP95Ms } } : {}),
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
  return {
    base: sideFromRun(
      compare.baseRun.summary,
      compare.scoreContract.base.scoreIntegrity,
      latency.baseP95Ms
    ),
    compare: sideFromRun(
      compare.compareRun.summary,
      compare.scoreContract.compare.scoreIntegrity,
      latency.compareP95Ms
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
  return iterations
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
    }));
}
