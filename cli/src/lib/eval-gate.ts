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
  isGateWaiverInForce,
  passRateFractionFromPercent,
  type CompareGateInput,
  type GatePolicy,
  type GateReport,
  type GateWaiver,
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
   * Baseline RUN ID to gate a regression delta against. Mutually exclusive
   * with {@link EvalGateOptions.baselineSha}.
   */
  baseline?: string;
  /**
   * Baseline SOURCE COMMIT SHA, resolved server-side to the completed run in
   * this suite recorded against it. A SEPARATE flag rather than a shape
   * sniffed out of `baseline`: see {@link resolveBaselineSelector}.
   */
  baselineSha?: string;
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
    throw usageError(
      `${flag} must be a number between 0 and 100, got "${raw}".`
    );
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

/**
 * Whether a run's IMPORT evidence is too incomplete for it to gate anything.
 *
 * Three states, and the third is the reason this is a function rather than a
 * boolean field read:
 *
 *   - ABSENT `importEligibility` — an Inspector/platform deployment that
 *     predates the projection. It has no opinion, so behave exactly as before.
 *     Reading absence as "incomplete" would make every existing gate fail the
 *     moment this CLI shipped against an older server; reading it as
 *     "eligible" would vouch for evidence nobody checked. "No opinion" is the
 *     only honest reading, and the rollout gate is what stops us relying on it.
 *   - `legacy` / `eligible` — proceed through the ordinary verdict logic.
 *   - `incomplete`, or `gateable: false` — an EXPLICIT statement that the
 *     evidence cannot be trusted.
 *
 * `gateable === false` is checked alongside the status rather than derived
 * from it: the platform owns that decision, and a future state it adds must
 * fail closed here rather than fall through to a verdict.
 */
export function importEvidenceBlocksGate(run: PlatformEvalRun): boolean {
  const eligibility = run.importEligibility;
  if (!eligibility) return false;
  return eligibility.status === "incomplete" || eligibility.gateable === false;
}

/**
 * The report for a run whose import evidence is explicitly incomplete.
 *
 * `incomplete`, never `failed`. Import completeness is EVIDENCE ELIGIBILITY,
 * not a measurement of the server: the run has not told us anything regressed,
 * it has told us its own evidence cannot be relied on. Reporting it as a
 * verdict failure would blame the server under test for a conversion nobody
 * finished reviewing — and, worse, would make it waivable, because a waiver
 * overrides a measured verdict and `applyGateWaiver` deliberately refuses to
 * touch `incomplete`.
 */
export function importIneligibleReport(run: PlatformEvalRun): GateReport {
  const eligibility = run.importEligibility;
  const issues = eligibility?.issues ?? [];
  const detail =
    issues.length === 0
      ? ""
      : `: ${issues
          .map((issue) =>
            [issue.code, issue.caseKey ?? issue.testCaseId, issue.toolName]
              .filter(Boolean)
              .join(" ")
          )
          .join("; ")}`;
  return {
    outcome: "incomplete",
    scoreIntegrity: "unknown",
    verdicts: [
      {
        gate: "import",
        status: "non_gateable",
        message:
          `run is not gateable: its import evidence is incomplete` +
          `${detail}. This is not a test failure — the run's imported cases ` +
          `do not carry the decisions a gate would rely on. Re-run with the ` +
          `approvals the cases need, or with the unsupported cases excluded.`,
      },
    ],
  };
}

export function reportForRun(
  run: PlatformEvalRun,
  iterations: { items: PlatformEvalIteration[]; complete: boolean } | undefined,
  policy: GatePolicy
): GateReport {
  // BEFORE the verdict logic, not merged with it: a run whose evidence is
  // ineligible has no verdict to combine with anything.
  if (importEvidenceBlocksGate(run)) return importIneligibleReport(run);
  return evaluateGates(gateInputFromPlatformRun(run, iterations), policy);
}

// ──────────────────────────────── --baseline / --baseline-sha selection ──
//
// PRD §18.4: `eval gate` keeps its four-code contract and GAINS `--baseline`.
// PRD §18.3 adds the other half of the pin — a baseline may be pinned by run
// id OR by SOURCE SHA — with no automatic selection in v1.
//
// WHY TWO FLAGS RATHER THAN ONE THAT SNIFFS THE SHAPE.
//
// A single `--baseline` that guessed "this looks like a SHA" would need a
// discriminator that is provably right, and there is none. A Convex `Id` is a
// BRANDED OPAQUE STRING: the platform documents no alphabet, no length and no
// format for it, this repo contains no id-shape validator anywhere, and the
// public OpenAPI spec types `runId` as a bare `string` with no `pattern`.
// Nothing contractual stops a run id from being all hex characters. Short
// SHAs settle it outright — CI systems routinely pass abbreviated 7-12
// character SHAs, a length at which a hex string is indistinguishable from an
// opaque id by construction.
//
// A baseline that silently resolves the WRONG WAY is worse than one that
// makes the caller be explicit: it would compare against something nobody
// asked for and report a regression, or a clean run, on that basis. So the
// kind is named by the flag, never inferred.

/**
 * A 40-hex git SHA-1. No longer a refusal to support SHAs — it is a REDIRECT.
 * `--baseline` still refuses this shape, because a caller who pastes a commit
 * SHA into the run-id flag would otherwise send a doomed run lookup and get
 * `incomplete` (exit 3), which reads as "no baseline exists" when the truth is
 * "you used the wrong flag". Pointing at `--baseline-sha` costs one error
 * message and saves a misdiagnosed CI failure.
 */
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
 * The 40-hex check is a REDIRECT to `--baseline-sha`, not a refusal to
 * support SHA baselines — see {@link SHA_LIKE_BASELINE}. It catches the one
 * shape a user is likely to hand this flag by habit, before it reaches the
 * network as a doomed run lookup that would report `incomplete`.
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
      `--baseline "${baseline}" looks like a git commit SHA. Pass it as ` +
        `--baseline-sha to pin the baseline by source SHA, or pass a run id ` +
        `to --baseline.`
    );
  }
  return normalized;
}

/**
 * Validate `--baseline-sha` and return the NORMALIZED (trimmed) value.
 *
 * Trims for the same reason {@link assertRunIdBaseline} does, and the stakes
 * are identical: the backend refuses a blank-after-trim SHA with
 * `EVAL_COMPARE_BASELINE_INVALID`, and a padded value forwarded raw would
 * either be refused on the wire or resolve to nothing and report `incomplete`
 * (exit 3) — a comparability answer for what is really a usage error.
 *
 * NOT validated for hex shape or length. SHAs are matched byte-for-byte as CI
 * reported them, and inventing a shape rule here would refuse a source
 * identifier the backend would have resolved (a short SHA, or a non-git
 * revision id) — a client-side veto over a server-side lookup.
 */
export function assertCommitShaBaseline(baselineSha: string): string {
  const normalized = baselineSha.trim();
  if (normalized === "") {
    throw usageError(
      `--baseline-sha must not be blank. Pass a commit SHA, or omit the flag ` +
        `entirely to gate on absolute thresholds only.`
    );
  }
  return normalized;
}

/** Which kind of baseline the caller pinned, once the flags are resolved. */
export type ResolvedBaseline =
  | { kind: "run"; runId: string }
  | { kind: "commitSha"; commitSha: string };

/**
 * Resolve `--baseline` / `--baseline-sha` into the one baseline this gate
 * pins, or `undefined` when neither was passed.
 *
 * The two are MUTUALLY EXCLUSIVE, refused here as a usage error (exit 2)
 * rather than silently preferring one. The v1 route and the Convex action both
 * refuse the same pair for the same reason; this check exists so the caller
 * learns it without spending a request, and so no layer wins silently.
 */
export function resolveBaselineSelector(input: {
  baseline?: string;
  baselineSha?: string;
  runId: string;
}): ResolvedBaseline | undefined {
  if (input.baseline !== undefined && input.baselineSha !== undefined) {
    throw usageError(
      `--baseline and --baseline-sha are mutually exclusive. Pass a run id to ` +
        `--baseline, or a source commit SHA to --baseline-sha, not both.`
    );
  }
  if (input.baselineSha !== undefined) {
    return {
      kind: "commitSha",
      commitSha: assertCommitShaBaseline(input.baselineSha),
    };
  }
  if (input.baseline !== undefined) {
    return {
      kind: "run",
      runId: assertRunIdBaseline(input.baseline, input.runId),
    };
  }
  return undefined;
}

/**
 * The `eval compare` half of the same selection, as `compareEvalRun` params.
 *
 * Differs from {@link resolveBaselineSelector} in exactly one way: `eval
 * compare` has NO required baseline — omitting both selectors is its
 * documented default (the nearest earlier completed run in the suite) — so
 * neither-given returns an empty selector rather than `undefined`. The mutual
 * exclusion and the trimming are identical, and deliberately live beside the
 * gate's copy so the two commands cannot drift apart on what they refuse.
 */
export function compareBaseSelector(input: {
  baseRun?: string;
  baseSha?: string;
}): { baseRunId?: string; baseCommitSha?: string } {
  if (input.baseRun !== undefined && input.baseSha !== undefined) {
    throw usageError(
      `--base-run and --base-sha are mutually exclusive. Pass a run id to ` +
        `--base-run, or a source commit SHA to --base-sha, not both.`
    );
  }
  if (input.baseSha !== undefined) {
    const normalized = input.baseSha.trim();
    if (normalized === "") {
      throw usageError(
        `--base-sha must not be blank. Pass a commit SHA, or omit the flag ` +
          `to compare against the nearest earlier completed run.`
      );
    }
    return { baseCommitSha: normalized };
  }
  if (input.baseRun !== undefined) {
    const normalized = input.baseRun.trim();
    if (normalized === "") {
      throw usageError(
        `--base-run must not be blank. Pass a run id, or omit the flag to ` +
          `compare against the nearest earlier completed run.`
      );
    }
    return { baseRunId: normalized };
  }
  return {};
}

/** The `compareEvalRun` query params for a resolved baseline. */
export function baselineCompareParams(
  baseline: ResolvedBaseline
): { baseRunId: string } | { baseCommitSha: string } {
  return baseline.kind === "run"
    ? { baseRunId: baseline.runId }
    : { baseCommitSha: baseline.commitSha };
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
    | "baselineSha"
  >
): GatePolicy {
  const hasComparativeFlag =
    options.minSampleSize !== undefined ||
    options.minEffectSizePercent !== undefined ||
    options.gateDeterministicRegressions === true ||
    options.maxP95LatencyIncreaseMs !== undefined;
  // EITHER selector enables the gate. Reading only `baseline` here would make
  // every comparative flag silently inert under `--baseline-sha` — the exact
  // failure mode this pre-check exists to prevent, reintroduced by the new
  // flag.
  const hasBaseline = Boolean(options.baseline) || Boolean(options.baselineSha);
  if (hasComparativeFlag && !hasBaseline) {
    throw usageError(
      "--min-sample-size, --min-effect-size-percent, " +
        "--gate-deterministic-regressions, and --max-p95-latency-increase-ms " +
        "tune the baseline regression gate; pass --baseline or " +
        "--baseline-sha to enable it."
    );
  }
  return comparePolicyFromOptions({
    gateRegressions: hasBaseline,
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
  // UNREACHABLE by construction: a waiver is folded in by `applyGateWaiver`
  // AFTER the two halves are merged, so no input to this function can carry
  // it. Ranked with `passed` rather than left to a lookup miss (`undefined`,
  // whose every comparison is false, would silently pin the merged outcome to
  // whichever side was evaluated first) — and ranked LOWEST deliberately: if
  // one half were ever waived, an unwaived failure on the other half must
  // still win. A waiver granted over the threshold gate is not consent to
  // ship a baseline regression.
  waived: 0,
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
  requestedBaseline: ResolvedBaseline,
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
  // The pin says a gate records "baseline run id/source SHA". BOTH, when a
  // SHA was pinned: the SHA is what CI asked for and what a human reads back,
  // the run id is what the verdict was actually computed against, and an
  // archived report that keeps only one cannot answer "which run did commit X
  // resolve to?" months later. `requestedBaselineKind` names which flag was
  // used so a reader never has to infer it from which field is populated.
  const requested: Record<string, unknown> = {
    requestedBaselineKind: requestedBaseline.kind,
    ...(requestedBaseline.kind === "run"
      ? { requestedBaselineRunId: requestedBaseline.runId }
      : { requestedBaselineCommitSha: requestedBaseline.commitSha }),
    // The RESOLVED source SHA as the backend echoed it, kept separate from
    // the requested one: a mixed-version backend can resolve without echoing,
    // and silently presenting the request as the answer would fabricate
    // confirmation the server never gave.
    ...(typeof compare.baseline.baseCommitSha === "string"
      ? { resolvedBaselineCommitSha: compare.baseline.baseCommitSha }
      : {}),
  };

  // Uniqueness of the SHA match. `matchCount` is reported ONLY when uniqueness
  // could not be established, so its ABSENCE is the unambiguous case and must
  // not be defaulted to 1. `matchCountTruncated` says the count is a floor
  // rather than a total — true even when it reads 1 — so the two are recorded
  // together: a count archived without its flag is a false claim of
  // uniqueness, which is precisely the claim a regression verdict rests on.
  const ambiguity: Record<string, unknown> =
    typeof compare.baseline.matchCount === "number"
      ? {
          baselineMatchCount: compare.baseline.matchCount,
          baselineMatchCountTruncated:
            compare.baseline.matchCountTruncated === true,
          baselineMatchUnique: false,
        }
      : { baselineMatchUnique: true };

  return {
    ...requested,
    ...ambiguity,
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
/**
 * The baseline run itself, or `undefined` when it cannot be read.
 *
 * Undefined means "we could not look", which the caller turns into
 * `incomplete` — the same fail-closed reading the surrounding code already
 * gives a compare call that throws. A deployment gate that silently skipped
 * this check on a transient error would be trustworthy only when the network
 * happened to be up.
 */
async function readBaselineRun(
  input: {
    client: Pick<PlatformApiClient, "getEvalRun">;
    signal: AbortSignal;
    projectId: string;
  },
  baseRunId: string
): Promise<PlatformEvalRun | undefined> {
  try {
    return await input.client.getEvalRun(
      { projectId: input.projectId, runId: baseRunId },
      { signal: input.signal }
    );
  } catch {
    return undefined;
  }
}

export async function evaluateBaselineComparison(input: {
  client: Pick<
    PlatformApiClient,
    "compareEvalRun" | "listEvalRunIterations" | "getEvalRun"
  >;
  signal: AbortSignal;
  projectId: string;
  runId: string;
  baseline: ResolvedBaseline;
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
        // Exactly ONE of `baseRunId` / `baseCommitSha` — sending both is a 400
        // at the route and at the action alike.
        ...baselineCompareParams(input.baseline),
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

  // THE BASELINE'S OWN IMPORT EVIDENCE.
  //
  // A regression gate rests on TWO runs, so "a run with incomplete import
  // evidence cannot be used as a deployment gate" has to cover the one being
  // compared against as well. `PlatformRunCompareSide` carries no eligibility
  // — the compare wire reports counters, not provenance — so the baseline is
  // fetched by id rather than assumed sound. Without this, a baseline whose
  // own approximations were never approved could still produce a confident
  // "no regression" and let a release through on evidence the platform has
  // already said is not gateable.
  const baseRun = await readBaselineRun(input, compare.baseRun.id);
  if (baseRun === undefined) {
    return {
      report: {
        outcome: "incomplete",
        scoreIntegrity: "unknown",
        verdicts: [
          {
            gate: "baseline",
            status: "non_gateable",
            message:
              "could not read the baseline run's import evidence, so the " +
              "comparison cannot be trusted as a gate",
          },
        ],
      },
    };
  }
  if (importEvidenceBlocksGate(baseRun)) {
    const report = importIneligibleReport(baseRun);
    return {
      report: {
        ...report,
        verdicts: report.verdicts.map((verdict) => ({
          ...verdict,
          gate: "baseline",
          message: `baseline run ${compare.baseRun.runNumber}: ${verdict.message}`,
        })),
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

// ── Gate waivers ────────────────────────────────────────────────────────────

/**
 * Read the waiver in force over a run, as `eval gate` should honor it.
 *
 * TWO INDEPENDENT CHECKS, and the second one is the point.
 *
 * The platform already filters to active waivers, so `active` should always be
 * true here. It is checked anyway, together with `expiresAt`, because of a
 * measured weakness on the other side: a Convex query is cached against the
 * DOCUMENTS it read, and the passage of time is not a document — so a waiver
 * that lapses between two reads can keep being served as active until
 * something writes to its row. The platform schedules a write at exactly
 * `expiresAt` to force that invalidation, and its own tests cannot observe
 * whether it works (a mutant deleting the write still passes them).
 *
 * `eval gate` computes its verdict independently of the platform by design.
 * Re-deciding the waiver's validity here keeps that independence at the one
 * place where trusting the server would silently turn a time-boxed waiver into
 * a permanent one — the exact property this workflow exists to hold, failing
 * in the exact way nothing on the other side can detect.
 *
 * ABSENT (rather than `null`) means an API deployment that predates the field.
 * That is "we do not know", not "not waived", and it is handled the same way
 * either produces the same behaviour here: no waiver is applied. What it must
 * NOT do is throw or warn, because every run gated against an older deployment
 * would then be noisy about a feature nobody asked for.
 */
export function activeWaiverForRun(
  run: PlatformEvalRun | undefined,
  now: number = Date.now()
): GateWaiver | undefined {
  const waiver = run?.gateWaiver;
  if (!waiver) return undefined;
  if (waiver.active !== true) return undefined;
  if (waiver.revokedAt !== null) return undefined;
  if (!isGateWaiverInForce(waiver, now)) return undefined;
  return {
    id: waiver.id,
    reason: waiver.reason,
    expiresAt: waiver.expiresAt,
    createdAt: waiver.createdAt,
    createdBy: waiver.createdBy,
    createdByEmail: waiver.createdByEmail,
    policySnapshot: waiver.policySnapshot,
  };
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse `--expires-in` into an absolute instant.
 *
 * A DURATION at the boundary, not a timestamp, because the thing a human knows
 * is "give me three days", and hand-computing an epoch-millisecond deadline is
 * an invitation to typo a waiver into the wrong month.
 *
 * Deliberately does NOT enforce the platform's 30-day ceiling. That refusal
 * (`gate_waiver_expiry_too_far`) carries copy the platform wrote, naming the
 * cap and what to do instead; a local check firing first would replace it with
 * a message this file invented, and would then be a second copy of a limit
 * that can change on the other side of the wire.
 *
 * Bare numbers are rejected rather than assumed to be anything: `--expires-in
 * 7` is ambiguous between seven minutes and seven days, and the difference is
 * a gate that reopens before lunch or three weeks later.
 */
export function parseWaiverExpiry(
  raw: string,
  now: number = Date.now()
): number {
  const match = /^(\d+)\s*([mhd])$/i.exec(raw.trim());
  if (!match) {
    throw usageError(
      `--expires-in must be a duration like 30m, 12h, or 7d, got "${raw}".`
    );
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw usageError(`--expires-in must be greater than zero, got "${raw}".`);
  }
  return now + amount * DURATION_UNIT_MS[match[2]!.toLowerCase()]!;
}
