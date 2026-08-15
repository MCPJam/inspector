/**
 * Flag parsing and run-fetching for `mcpjam eval gate`.
 *
 * Kept out of `commands/eval.ts` so the parsing rules — especially the
 * percent→fraction boundary — are unit-testable without booting commander.
 */

import {
  evaluateGates,
  gateInputFromPlatformRun,
  passRateFractionFromPercent,
  type GatePolicy,
  type GateReport,
} from "@mcpjam/sdk";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "@mcpjam/sdk/platform";
import { usageError } from "./output.js";

export type EvalGateOptions = {
  /** PERCENT at the boundary (0–100), converted to a fraction immediately. */
  minPassRatePercent?: string;
  noGatingScoreErrors?: boolean;
  /** Repeatable `<scorerId>=<percent>`. */
  minScorerPassRate?: string[];
  /** Repeatable `<scorerId>=<0..1>`. */
  minMeanScore?: string[];
};

function parsePercent(raw: string, flag: string): number {
  // Blank is rejected explicitly: `Number("")` is 0, so an empty flag value
  // would silently become "0%" — a gate that passes unconditionally, which is
  // the worst possible way for a typo to fail.
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw usageError(`${flag} must be a number between 0 and 100, got "${raw}".`);
  }
  return passRateFractionFromPercent(value);
}

function parseScorerMap(
  entries: string[],
  flag: string,
  parseValue: (raw: string, flag: string) => number
): Record<string, number> {
  // Null prototype: `out["__proto__"] = 0.9` on a plain object sets the
  // PROTOTYPE rather than an own key, so `--min-scorer-pass-rate __proto__=100`
  // would silently drop the gate the author asked for.
  const out: Record<string, number> = Object.create(null);
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw usageError(`${flag} must be <scorerId>=<value>, got "${entry}".`);
    }
    const scorerId = entry.slice(0, index).trim();
    if (!scorerId) {
      throw usageError(`${flag} is missing a scorer id in "${entry}".`);
    }
    if (Object.prototype.hasOwnProperty.call(out, scorerId)) {
      // Last-wins would silently discard the stricter of two thresholds the
      // author wrote — a gate quietly weakened by a copy-paste.
      throw usageError(
        `${flag} names "${scorerId}" more than once; pass one threshold per scorer.`
      );
    }
    out[scorerId] = parseValue(entry.slice(index + 1).trim(), flag);
  }
  return out;
}

function parseUnit(raw: string, flag: string): number {
  // Same blank guard as `parsePercent`, for the same reason.
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw usageError(`${flag} must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

/**
 * Build the policy from flags.
 *
 * The percent→fraction conversion happens HERE and only here — the engine
 * works in fractions throughout, and a `minimumPassRate` that could hold either
 * `1` or `100` depending on which caller filled it is a bug waiting for a
 * release to gate on it.
 */
export function policyFromOptions(options: EvalGateOptions): GatePolicy {
  const policy: GatePolicy = {};
  if (options.minPassRatePercent !== undefined) {
    policy.minimumPassRate = parsePercent(
      options.minPassRatePercent,
      "--min-pass-rate-percent"
    );
  }
  if (options.noGatingScoreErrors) policy.noGatingScoreErrors = true;
  if (options.minScorerPassRate?.length) {
    policy.minimumScorerPassRate = parseScorerMap(
      options.minScorerPassRate,
      "--min-scorer-pass-rate",
      parsePercent
    );
  }
  if (options.minMeanScore?.length) {
    policy.minimumMeanScore = parseScorerMap(
      options.minMeanScore,
      "--min-mean-score",
      parseUnit
    );
  }
  return policy;
}

/** Does this policy need per-iteration score rows to be decidable? */
export function policyNeedsIterations(policy: GatePolicy): boolean {
  return Boolean(
    policy.noGatingScoreErrors ||
      policy.minimumScorerPassRate ||
      policy.minimumMeanScore ||
      policy.maximumTotalTokens !== undefined
  );
}

export function reportForRun(
  run: PlatformEvalRun,
  iterations: { items: PlatformEvalIteration[]; complete: boolean } | undefined,
  policy: GatePolicy
): GateReport {
  return evaluateGates(gateInputFromPlatformRun(run, iterations), policy);
}
