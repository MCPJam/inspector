/**
 * Flag parsing and run-fetching for `mcpjam cloud eval gate`.
 *
 * Kept out of `commands/eval.ts` so the parsing rules — especially the
 * percent→fraction boundary — are unit-testable without booting commander.
 */

import {
  DEFAULT_MIN_EFFECT_SIZE,
  DEFAULT_MIN_SAMPLE_SIZE,
  evaluateCompareGates,
  evaluateGates,
  gateInputFromPlatformRun,
  passRateFractionFromPercent,
  type CompareGateInput,
  type GatePolicy,
  type GateReport,
} from "@mcpjam/sdk";
import type {
  PlatformApiClient,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "@mcpjam/sdk/platform";
import {
  comparePolicyFromOptions,
  compareGateInputFrom,
} from "./eval-compare.js";
import {
  fetchAllIterations,
  p95Of,
  type FetchedIterations,
} from "./eval-iterations.js";
import { usageError } from "./output.js";

export type EvalGateOptions = {
  /** PERCENT at the boundary (0–100), converted to a fraction immediately. */
  minPassRatePercent?: string;
  noGatingScoreErrors?: boolean;
  /** Repeatable `<scorerId>=<percent>`. */
  minScorerPassRate?: string[];
  /** Repeatable `<scorerId>=<0..1>`. */
  minMeanScore?: string[];
  /**
   * Baseline RUN ID to gate a regression delta against. A SHA is rejected —
   * see {@link assertRunIdBaseline} — because source-SHA resolution needs a
   * backend index this step does not build.
   */
  baseline?: string;
  /** Same tuning flags `eval compare` exposes; require `--baseline`. */
  minSampleSize?: string;
  /** PERCENT at the boundary (0–100), converted to a fraction immediately. */
  minEffectSizePercent?: string;
  gateDeterministicRegressions?: boolean;
  maxP95LatencyIncreaseMs?: string;
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
      policy.maximumTotalTokens !== undefined ||
      // p95 comes from iteration durations, exactly like tokens come from
      // iteration counts. Omitting it here would leave the latency gate
      // permanently non-gateable — the fetch that could decide it never runs.
      policy.maximumP95LatencyMs !== undefined
  );
}

export function reportForRun(
  run: PlatformEvalRun,
  iterations: { items: PlatformEvalIteration[]; complete: boolean } | undefined,
  policy: GatePolicy
): GateReport {
  return evaluateGates(gateInputFromPlatformRun(run, iterations), policy);
}

// ─────────────────────────────────────────────── --baseline (runId half) ──
//
// PRD §18.4: `eval gate` keeps its four-code contract and GAINS `--baseline`.
// SHA resolution is a separate follow-up step gated on a backend index that
// does not exist yet, so a SHA-shaped argument is rejected here rather than
// silently mistreated as a run id.

/** A 40-hex git SHA-1, the shape `--baseline` must reject in this step. */
const SHA_LIKE_BASELINE = /^[0-9a-f]{40}$/i;

/**
 * Validate `--baseline` and return the NORMALIZED (trimmed) value to use for
 * everything downstream — the network request included. Validating the
 * trimmed value while forwarding the raw one would let a whitespace-padded
 * argument (`--baseline " run-baseline "`) slip past every check here and
 * then fail to resolve on the wire, reporting `incomplete` (exit 3) instead
 * of either working or naming the usage error.
 *
 * Blank is rejected explicitly: every downstream check treats
 * `options.baseline` as "present" with `!== undefined` but "enabled" with
 * `Boolean(options.baseline)` (see {@link comparePolicyFromGateOptions} and
 * `runEvalGate`'s `if (!options.baseline)`). A CI invocation that interpolates
 * an unset variable — `--baseline "$BASELINE_RUN_ID"` — hands Commander an
 * empty string, which is `!== undefined` but falsy: unchecked, the command
 * would silently skip the baseline comparison and exit 0 on the threshold
 * gates alone, having gated on nothing the caller asked for.
 *
 * `--baseline` equal to `--run` is the same failure mode wearing a different
 * shape: a run compared against itself has identical samples on both sides,
 * so `assessPassRateRegression` reports `no_regression` and the deterministic
 * gate finds nothing that flipped — not because nothing regressed, but
 * because no independent baseline was ever consulted. A CI script that wires
 * the same "latest run" variable into both `--run` and `--baseline` (a
 * plausible copy-paste) would otherwise get a green regression gate that
 * validated nothing.
 *
 * Run ids on this platform are never 40 lowercase-hex characters, so the SHA
 * discriminator cannot false-positive on a real run id; it exists purely to
 * catch the one shape a user is likely to hand it by habit — a git commit
 * SHA — before it reaches the network as a doomed run lookup.
 */
export function assertRunIdBaseline(baseline: string, runId: string): string {
  const normalized = baseline.trim();
  if (normalized === "") {
    throw usageError(
      `--baseline must not be blank. Pass a run id, or omit the flag entirely ` +
        `to gate on absolute thresholds only.`
    );
  }
  if (normalized === runId) {
    throw usageError(
      `--baseline "${baseline}" is the same as --run "${runId}". A run cannot ` +
        `be its own baseline — pass a different, earlier run id.`
    );
  }
  // Tested against the TRIMMED value: a whitespace-padded SHA
  // (`--baseline " <40-hex> "`) is still a doomed run lookup, and the blank
  // check above already proved trimming doesn't change what the flag means.
  if (SHA_LIKE_BASELINE.test(normalized)) {
    throw usageError(
      `--baseline "${baseline}" looks like a git SHA. SHA baselines are not ` +
        `supported yet; pass a run id. (Source-SHA baseline resolution is a ` +
        `follow-up step, gated on a backend index that does not exist yet.)`
    );
  }
  return normalized;
}

/**
 * Build the comparative half of the gate policy from `eval gate`'s flags.
 *
 * `eval gate` has no `--gate-regressions` flag: `--baseline` itself implies
 * regression gating, so passing one enables the pass-rate regression gate
 * even with no tuning flags (the SDK's defaults then apply). Reuses
 * `comparePolicyFromOptions` — the ONE place the percent→fraction boundary is
 * crossed — rather than re-parsing; the pre-check below only replaces ITS
 * usage-error message, which names a `--gate-regressions` flag this command
 * does not have.
 *
 * Every comparative flag requires `--baseline`, not only the pass-rate tuning
 * pair: without a baseline there is no compare fetch at all, so a
 * `--gate-deterministic-regressions` or `--max-p95-latency-increase-ms` with
 * no `--baseline` would otherwise be silently ignored — the exact failure
 * mode `evaluateGates` already refuses for the single-run comparative fields.
 */
export function comparePolicyFromGateOptions(
  options: Pick<
    EvalGateOptions,
    | "baseline"
    | "minSampleSize"
    | "minEffectSizePercent"
    | "gateDeterministicRegressions"
    | "maxP95LatencyIncreaseMs"
  >
): GatePolicy {
  const hasComparativeFlag =
    options.minSampleSize !== undefined ||
    options.minEffectSizePercent !== undefined ||
    options.gateDeterministicRegressions === true ||
    options.maxP95LatencyIncreaseMs !== undefined;
  if (hasComparativeFlag && !options.baseline) {
    throw usageError(
      "--min-sample-size, --min-effect-size-percent, " +
        "--gate-deterministic-regressions, and --max-p95-latency-increase-ms " +
        "tune the baseline regression gate; pass --baseline to enable it."
    );
  }
  return comparePolicyFromOptions({
    gateRegressions: Boolean(options.baseline),
    minSampleSize: options.minSampleSize,
    minEffectSizePercent: options.minEffectSizePercent,
    gateDeterministicRegressions: options.gateDeterministicRegressions,
    maxP95LatencyIncreaseMs: options.maxP95LatencyIncreaseMs,
  });
}

/**
 * The server says "no baseline" with a 404 carrying
 * `details.reason: "BASELINE_NOT_FOUND"`. Read the machine field, not the
 * prose. Shared by `eval compare` and `eval gate --baseline` — both hit the
 * same endpoint and must fold the same error into `incomplete`, never `failed`.
 */
export function baselineNotFoundReason(error: unknown): boolean {
  const details = (error as { details?: unknown })?.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "BASELINE_NOT_FOUND"
  );
}

/**
 * Fold a threshold `GateReport` and a comparative `GateReport` into one.
 *
 * Same precedence `evaluateGates` and `evaluateCompareGates` each already use
 * internally (`usage_error > failed > incomplete > passed`), applied one
 * level up: a run that both missed its threshold AND regressed against the
 * baseline DID both, and folding to whichever ranks higher must never bury
 * the other family's verdicts — every verdict from both reports survives in
 * the merged `verdicts` array.
 */
const OUTCOME_RANK: Record<GateReport["outcome"], number> = {
  passed: 0,
  incomplete: 1,
  failed: 2,
  usage_error: 3,
};

export function mergeGateReports(
  threshold: GateReport,
  comparative: GateReport
): GateReport {
  return {
    outcome:
      OUTCOME_RANK[comparative.outcome] > OUTCOME_RANK[threshold.outcome]
        ? comparative.outcome
        : threshold.outcome,
    verdicts: [...threshold.verdicts, ...comparative.verdicts],
    // The run being gated IS the compare side of the baseline comparison, so
    // its own score integrity — already computed by `evaluateGates` above —
    // is the one meaning that survives the merge. The comparison's own
    // (base+compare) combined integrity is recorded separately in the
    // baseline provenance, not lost.
    scoreIntegrity: threshold.scoreIntegrity,
  };
}

/** Why one case does not belong to the comparable population. */
type IncompatibleCaseReason =
  | "case_added"
  | "case_removed"
  | "scenario_config_changed"
  | "evaluation_config_changed"
  | "iteration_weighting_unequal";

/**
 * Every reason ONE case is excluded from the comparable population, using
 * the SAME predicates `compareGateInputFrom` aggregates into the whole-run
 * booleans — a case can be case-set-stable and STILL be individually
 * responsible for `scenarioConfigChanged`, `evaluationConfigChanged`, or
 * `iterationWeightingEqual: false`, and `comparableCaseIds` must not claim
 * a case the whole-run verdict did not actually trust.
 *
 * `runEvaluationConfigChanged` is `compare.scoreContract.evaluationConfigChanged`
 * — a RUN-LEVEL fact, not a per-row one. `compareGateInputFrom` ORs it into
 * the aggregate `evaluationConfigChanged` regardless of any single case's own
 * flag, so a case whose own row never changed can still be the reason the
 * whole-run gate is non-gateable; every case must inherit it, not just the
 * ones whose own `row.evaluationConfigChanged` happens to be true.
 */
function incompatibilityReasonsFor(
  row: PlatformRunCompareCase,
  runEvaluationConfigChanged: boolean
): IncompatibleCaseReason[] {
  const reasons: IncompatibleCaseReason[] = [];
  if (row.status === "new_case") reasons.push("case_added");
  if (row.status === "removed_case") reasons.push("case_removed");
  if (row.configChanged) reasons.push("scenario_config_changed");
  if (row.evaluationConfigChanged || runEvaluationConfigChanged) {
    reasons.push("evaluation_config_changed");
  }
  // Mirrors `iterationWeightingEqualFrom`'s own skip condition: a case
  // absent on either side has no counterpart to weigh against, and is
  // already covered by `case_added`/`case_removed` above.
  if (
    row.base.outcome !== "absent" &&
    row.compare.outcome !== "absent" &&
    row.base.iterationIds.length !== row.compare.iterationIds.length
  ) {
    reasons.push("iteration_weighting_unequal");
  }
  return reasons;
}

/**
 * Baseline-compatibility provenance for the gate report.
 *
 * The PINNED CONTRACT requires a gate to record baseline run id/SHA, suite
 * hashes, model/provider, host/harness, server/environment identity, and
 * comparable case ids — and to report incompatible dimensions explicitly
 * rather than silently comparing them. The `/compare` wire does not carry
 * every one of those yet; the dimensions it omits are recorded as
 * `"notRecorded"` here rather than left out, so a reader can tell "checked,
 * and they matched" apart from "nobody looked".
 */
export function buildBaselineProvenance(
  requestedBaseline: string,
  compare: PlatformRunCompare,
  input: CompareGateInput,
  policy: GatePolicy
): Record<string, unknown> {
  const classified = compare.cases.map((row) => ({
    row,
    reasons: incompatibilityReasonsFor(
      row,
      compare.scoreContract.evaluationConfigChanged
    ),
  }));
  return {
    requestedBaseline,
    baseline: compare.baseline,
    baseRunId: compare.baseRun.id,
    compareRunId: compare.compareRun.id,
    // The RESOLVED policy that produced this verdict, defaults filled in —
    // an archived report must be self-describing without cross-referencing
    // the CLI invocation that produced it. `null` means the gate was not
    // asked for, not "asked for with a threshold of nothing".
    policy: {
      passRateRegression: policy.passRateRegression
        ? {
            minSampleSize:
              policy.passRateRegression.minSampleSize ??
              DEFAULT_MIN_SAMPLE_SIZE,
            minEffectSize:
              policy.passRateRegression.minEffectSize ??
              DEFAULT_MIN_EFFECT_SIZE,
          }
        : null,
      noDeterministicRegressions: policy.noDeterministicRegressions === true,
      maximumP95LatencyIncreaseMs: policy.maximumP95LatencyIncreaseMs ?? null,
    },
    compatibility: {
      caseSetChanged: input.caseSetChanged,
      scenarioConfigChanged: input.scenarioConfigChanged,
      evaluationConfigChanged: input.evaluationConfigChanged,
      iterationWeightingEqual: input.iterationWeightingEqual,
      baseScoreIntegrity: compare.scoreContract.base.scoreIntegrity,
      compareScoreIntegrity: compare.scoreContract.compare.scoreIntegrity,
      // The pin names "comparable case ids" explicitly: which cases an
      // archived report's verdict actually covers, and which ones a
      // `caseSetChanged: true` flag alone does not name.
      comparableCaseIds: classified
        .filter(({ reasons }) => reasons.length === 0)
        .map(({ row }) => row.caseKey),
      incompatibleCases: classified
        .filter(({ reasons }) => reasons.length > 0)
        .map(({ row, reasons }) => ({
          caseKey: row.caseKey,
          status: row.status,
          reasons,
        })),
    },
    // Dimensions the pinned contract requires but the `/compare` wire does
    // not carry today (E4b / backend follow-up work). Never invented, never
    // silently dropped.
    notRecorded: {
      modelProvider: "notRecorded",
      hostHarness: "notRecorded",
      serverEnvironmentIdentity: "notRecorded",
      configHashesBeyondEvaluationConfigHash: "notRecorded",
    },
  };
}

export type BaselineComparisonResult = {
  report: GateReport;
  /** Absent when the comparison never resolved a compare report to describe. */
  provenance?: Record<string, unknown>;
};

/**
 * Evaluate the `--baseline` regression gate for `eval gate`.
 *
 * Called only once the run being gated has already produced a threshold
 * `GateReport` — a baseline comparison for a run with no verdict of its own
 * yet is meaningless. Errors fetching the comparison degrade to a
 * `non_gateable` verdict rather than throwing, so the caller can always
 * merge this result with the threshold report instead of discarding it.
 */
export async function evaluateBaselineComparison(input: {
  client: Pick<PlatformApiClient, "compareEvalRun" | "listEvalRunIterations">;
  signal: AbortSignal;
  projectId: string;
  runId: string;
  baseline: string;
  policy: GatePolicy;
  /** Already-fetched iterations for `runId`, reused instead of re-fetched. */
  compareIterations?: FetchedIterations;
}): Promise<BaselineComparisonResult> {
  let compare: PlatformRunCompare;
  try {
    compare = await input.client.compareEvalRun(
      {
        projectId: input.projectId,
        runId: input.runId,
        baseRunId: input.baseline,
      },
      { signal: input.signal }
    );
  } catch (error) {
    const reason = baselineNotFoundReason(error);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      report: {
        outcome: "incomplete",
        scoreIntegrity: "unknown",
        verdicts: [
          {
            gate: "baseline",
            status: "non_gateable",
            message: reason
              ? `no baseline to compare against: ${detail}`
              : `could not compare against the baseline: ${detail}`,
          },
        ],
      },
    };
  }

  // Defence in depth, mirroring `eval compare`: the backend action already
  // refuses a non-completed run, but this command's contract says an
  // unfinished comparison is INCOMPLETE, and that must not depend on a guard
  // in another repo staying put.
  if (
    compare.baseRun.completedAt === null ||
    compare.compareRun.completedAt === null
  ) {
    return {
      report: {
        outcome: "incomplete",
        scoreIntegrity: "unknown",
        verdicts: [
          {
            gate: "baseline",
            status: "non_gateable",
            message: "both runs must be completed before they can be compared",
          },
        ],
      },
    };
  }

  // Latency needs per-iteration rows on both sides. A fetch failure here
  // degrades only the latency gate to non-gateable — absent beats
  // approximate — rather than discarding the whole comparison.
  const needsLatency = input.policy.maximumP95LatencyIncreaseMs !== undefined;
  let baseIterations: FetchedIterations | undefined;
  let compareIterationsForLatency: FetchedIterations | undefined =
    input.compareIterations;
  if (needsLatency) {
    try {
      [baseIterations, compareIterationsForLatency] = await Promise.all([
        fetchAllIterations(
          input.client,
          input.signal,
          input.projectId,
          compare.baseRun.id
        ),
        input.compareIterations ??
          fetchAllIterations(
            input.client,
            input.signal,
            input.projectId,
            compare.compareRun.id
          ),
      ]);
    } catch {
      baseIterations = undefined;
      compareIterationsForLatency = undefined;
    }
  }

  const compareInput = compareGateInputFrom(compare, {
    baseP95Ms: p95Of(baseIterations),
    compareP95Ms: p95Of(compareIterationsForLatency),
  });

  return {
    report: evaluateCompareGates(compareInput, input.policy),
    provenance: buildBaselineProvenance(
      input.baseline,
      compare,
      compareInput,
      input.policy
    ),
  };
}
