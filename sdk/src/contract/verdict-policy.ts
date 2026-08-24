/**
 * The versioned **run verdict policy** — what a suite-level eval verdict means,
 * and what must be measured before it is allowed to mean anything.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * It is the CONTRACT and nothing else: the shapes a verdict travels in, the
 * closed vocabularies it is spelled with, and the validators that refuse a
 * self-inconsistent one. There is deliberately NO aggregator here — nothing in
 * this file reads trials and produces a verdict. The producer (hosted runner or
 * SDK run) is a later wave, and the fixtures in
 * `tests/fixtures/eval-verdict-policy-parity-fixtures.json` are what pin the
 * expected output it will have to reproduce.
 *
 * Two rules follow the same discipline as `./suite-file.ts` and are load-
 * bearing:
 *
 *  1. **No `.default()` anywhere.** An omitted field stays omitted, so a
 *     payload is byte-stable through `canonicalJson` and back. Above all,
 *     {@link EVAL_VERDICT_POLICY_VERSION} is never defaulted: a legacy row that
 *     carries no `verdictPolicyVersion` was produced under the old percent-
 *     threshold rules and MUST NOT be read as v2. Defaulting it would silently
 *     restate old numbers under new semantics.
 *  2. **Every object declared here is `.strict()`.** Unknown fields are errors,
 *     matching Convex `v.object`, which the backend mirror uses.
 *
 * ── Why a verdict can be `inconclusive` ──────────────────────────────────────
 *
 * A run that did not measure the server has not produced evidence about it, and
 * reporting that as `failed` blames the server for the harness or the grader.
 * So the policy is evaluated in TWO ORDERED phases and the order is normative:
 *
 *   1. **Validity.** Was enough of the run actually measured? Failing this is
 *      `inconclusive`, with a reason drawn from
 *      {@link EVAL_VALIDITY_DECISION_REASONS}. A case that produced ZERO
 *      eligible trials makes the suite `inconclusive` too — even when its
 *      threshold is `0`, because "nothing was graded" is not "everything that
 *      was graded passed".
 *   2. **Task verdict.** Only once validity holds: every MEASURED case must
 *      meet its own effective `passThreshold` for the suite to pass.
 *
 * Lifecycle and task verdict are ORTHOGONAL. `ITERATION_STATUSES` (see
 * `./chain.ts`) describes what happened to a trial mechanically; the verdict
 * describes whether the case's goal was met. A trial that ran to `completed`
 * with a failing task verdict is the normal way a case fails, and no mapper
 * from one vocabulary to the other exists — or should be added. The bridge
 * between them is {@link EvalTrialExclusionReason}, which records why a trial
 * was removed from a denominator, and it is supplied by the producer rather
 * than derived here.
 *
 * ── Every rate is an envelope, never a bare number ───────────────────────────
 *
 * {@link EvalRateMeasurement} carries `numerator`, `denominator`, `exclusions`
 * and a `state`. A zero denominator is `notMeasured` with a `null` value, which
 * is unrepresentable as a pass: the one failure mode this shape exists to
 * prevent is `0/0` rendering as `0`, or as `1`, and either way as a verdict.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 *
 * These are NOT the `EvalDecisionSummary` / `EvalDecisionVerdict` types in the
 * SDK main entry (`src/eval-decision-summary.ts`). Those are the existing
 * per-case stage-chain summary, whose verdict vocabulary is
 * `passed | failed | incomplete` and whose rate is a percent over CASES. This
 * contract is a separate, versioned surface over TRIALS with an `inconclusive`
 * verdict, so it takes distinct names rather than widening a shipped one.
 */

import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { MAX_REPETITIONS, MAX_SUITE_FILE_CASES } from "./suite-file.js";

/**
 * The policy version, as a literal.
 *
 * `2` because v1 is the shipped percent-threshold behaviour that has no version
 * field at all. Absence therefore means v1, and {@link isEvalVerdictPolicyV2}
 * is the only sanctioned way to ask.
 */
export const EVAL_VERDICT_POLICY_VERSION = 2;
export type EvalVerdictPolicyVersion = typeof EVAL_VERDICT_POLICY_VERSION;
export const evalVerdictPolicyVersionSchema = z.literal(
  EVAL_VERDICT_POLICY_VERSION,
  {
    error: (issue: { input: unknown }) =>
      issue.input === undefined
        ? `verdictPolicyVersion is required and must be ` +
          `${EVAL_VERDICT_POLICY_VERSION}. An absent version is a LEGACY ` +
          `(percent-threshold) row and must not be read as v2.`
        : `verdictPolicyVersion ${JSON.stringify(issue.input)} is not ` +
          `supported by this contract, which pins ` +
          `${EVAL_VERDICT_POLICY_VERSION}.`,
  }
);

/** The `$id` of the published JSON Schema for this contract. */
export const EVAL_VERDICT_POLICY_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-verdict-policy/v2.json";

/**
 * True only when `value` is LITERALLY the v2 version.
 *
 * Exists so no consumer has to write `version ?? 2`. A row read out of storage
 * with no version is v1 and this returns `false` for it.
 */
export function isEvalVerdictPolicyV2(value: unknown): boolean {
  return value === EVAL_VERDICT_POLICY_VERSION;
}

// ── verdict ──────────────────────────────────────────────────────────────────
/**
 * What a run (or one case within it) is allowed to conclude.
 *
 *   - `passed`       — measured, and every measured case met its threshold.
 *   - `failed`       — measured, and at least one measured case did not.
 *   - `inconclusive` — not measured well enough to say either. Never merged
 *     into `failed`: the distinction between "the server is broken" and "we did
 *     not measure the server" is the entire point of this policy.
 */
export const EVAL_RUN_VERDICTS = ["passed", "failed", "inconclusive"] as const;
export type EvalRunVerdict = (typeof EVAL_RUN_VERDICTS)[number];
export const evalRunVerdictSchema = z.enum(EVAL_RUN_VERDICTS);

export function isEvalRunVerdict(value: unknown): value is EvalRunVerdict {
  return (
    typeof value === "string" &&
    (EVAL_RUN_VERDICTS as readonly string[]).includes(value)
  );
}

// ── primitives ───────────────────────────────────────────────────────────────
/**
 * A rate or a threshold: a finite real number in [0,1]. NEVER a percent.
 *
 * `z.number()` already rejects `NaN` and both infinities, and the bounds reject
 * a percent-like `50` structurally — so the JSON Schema twin rejects all of
 * them too, rather than leaning on a refinement that would not project.
 */
export const evalFractionSchema = z.number().min(0).max(1);

/** A count of trials: a non-negative integer. */
const trialCountSchema = z.number().int().min(0);

/**
 * Trials a case was CONFIGURED to run.
 *
 * The portable range is the suite file's own `repetitions` range, 1 through
 * {@link MAX_REPETITIONS} — imported rather than restated so the two cannot
 * drift. The hosted platform's own, much lower, per-case cap is a PRODUCT
 * limit enforced where runs are launched; encoding it here would make a
 * perfectly legal portable file unrepresentable in the contract that describes
 * its results.
 */
const configuredTrialsSchema = z.number().int().min(1).max(MAX_REPETITIONS);

// ── why a trial left a denominator ───────────────────────────────────────────
/**
 * The closed vocabulary for a trial that was NOT graded.
 *
 * Supplied by the producer, never derived here: mapping a lifecycle status onto
 * one of these is the producer's job, and a mapper in this file would quietly
 * become the thing that decides verdicts.
 *
 *   - `notTerminal`     — still `pending`/`running` when the roll-up was taken.
 *   - `skipped`         — deliberately not run (disabled case, filtered
 *     selection). Never attempted, so it is not a completion failure either.
 *   - `setupFailed`     — the environment was never prepared. Says something
 *     about us, not about the server.
 *   - `cancelled`       — a run stopped mid-flight by a human or a shutdown.
 *   - `timedOut`        — no terminal outcome inside the budget.
 *   - `executionFailed` — the trial ran and errored out mechanically, so it has
 *     no task verdict to grade.
 *   - `evaluatorError`  — the GRADER failed. Kept separate from every other
 *     reason because it is the numerator of its own validity ceiling: folding a
 *     broken judge into server failures poisons every rate derived from it.
 */
export const EVAL_TRIAL_EXCLUSION_REASONS = [
  "notTerminal",
  "skipped",
  "setupFailed",
  "cancelled",
  "timedOut",
  "executionFailed",
  "evaluatorError",
] as const;
export type EvalTrialExclusionReason =
  (typeof EVAL_TRIAL_EXCLUSION_REASONS)[number];
export const evalTrialExclusionReasonSchema = z.enum(
  EVAL_TRIAL_EXCLUSION_REASONS
);

export function isEvalTrialExclusionReason(
  value: unknown
): value is EvalTrialExclusionReason {
  return (
    typeof value === "string" &&
    (EVAL_TRIAL_EXCLUSION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * How many trials each reason removed from ONE rate's denominator.
 *
 * A closed object of optional counts rather than an open map: the keys are the
 * vocabulary above, and a typo'd reason must fail loudly instead of being
 * counted under a key nobody reads. A reason that excluded nothing is OMITTED
 * (no `.default()`, so the payload round-trips byte-stable) — `0` and absent
 * mean the same thing and only one of them is written.
 */
export const evalTrialExclusionsSchema = z
  .object({
    notTerminal: trialCountSchema.optional(),
    skipped: trialCountSchema.optional(),
    setupFailed: trialCountSchema.optional(),
    cancelled: trialCountSchema.optional(),
    timedOut: trialCountSchema.optional(),
    executionFailed: trialCountSchema.optional(),
    evaluatorError: trialCountSchema.optional(),
  })
  .strict();
export type EvalTrialExclusions = z.infer<typeof evalTrialExclusionsSchema>;

// ── the measurement envelope ─────────────────────────────────────────────────
/**
 * Whether a rate says anything at all.
 *
 * `notMeasured` is not a low score. It is the absence of a score, and no floor
 * or ceiling can be satisfied by it — see
 * {@link EVAL_VALIDITY_DECISION_REASONS}.
 */
export const EVAL_RATE_MEASUREMENT_STATES = [
  "measured",
  "notMeasured",
] as const;
export type EvalRateMeasurementState =
  (typeof EVAL_RATE_MEASUREMENT_STATES)[number];
export const evalRateMeasurementStateSchema = z.enum(
  EVAL_RATE_MEASUREMENT_STATES
);

/**
 * One rate, with the arithmetic that produced it.
 *
 * A discriminated union rather than one object with nullable fields, so the
 * `0/0` case is unrepresentable as a pass: `notMeasured` pins `value: null` and
 * `denominator: 0`, and `measured` requires `denominator >= 1`. A consumer that
 * forgets to branch gets a type error, not a `0` it can compare against a
 * threshold.
 *
 * `exclusions` travels with EVERY rate rather than once per case, because the
 * trials excluded from an eligibility denominator are not the ones excluded
 * from a completion denominator, and one shared tally could not say which was
 * which.
 */
export const evalRateMeasurementStructuralSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("measured"),
        value: evalFractionSchema,
        numerator: trialCountSchema,
        denominator: z.number().int().min(1),
        exclusions: evalTrialExclusionsSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("notMeasured"),
        value: z.null(),
        numerator: z.literal(0),
        denominator: z.literal(0),
        exclusions: evalTrialExclusionsSchema,
      })
      .strict(),
  ]
);

/**
 * The rate validator, with the cross-field arithmetic the structural half
 * cannot express: the numerator never exceeds the denominator, and `value` IS
 * the quotient rather than a rounded-off restatement of it.
 *
 * The quotient is checked exactly. IEEE-754 division is deterministic across
 * the runtimes that mirror this contract, and a producer that rounds `value`
 * has produced a number that no longer matches the counts it ships beside —
 * which is precisely the drift that makes a hosted rate and a re-derived one
 * disagree.
 */
export const evalRateMeasurementSchema =
  evalRateMeasurementStructuralSchema.superRefine((rate, ctx) => {
    if (rate.state !== "measured") return;
    if (rate.numerator > rate.denominator) {
      ctx.addIssue({
        code: "custom",
        path: ["numerator"],
        message: `numerator ${rate.numerator} exceeds denominator ${rate.denominator}`,
      });
    }
    const quotient = rate.numerator / rate.denominator;
    if (rate.value !== quotient) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          `value ${rate.value} is not ${rate.numerator}/${rate.denominator} ` +
          `(${quotient}); a rate must be the quotient of the counts it ships with`,
      });
    }
  });
export type EvalRateMeasurement = z.infer<typeof evalRateMeasurementSchema>;

// ── the resolved validity policy ─────────────────────────────────────────────
/**
 * The suite-file `validity` block once its documented defaults are resolved —
 * the form a verdict is actually decided against.
 *
 * `coverage` is a DISCRIMINATED UNION rather than an optional
 * `minEligibleTrials` beside a boolean, because the two coverage rules are
 * mutually exclusive and a shape that can express both (or neither) would let
 * an incidental defaulting expression — `minEligibleTrials ?? 1` somewhere in a
 * runner — decide the policy:
 *
 *   - `allConfiguredTrialsAttempted` — what an OMITTED `minEligibleTrials`
 *     means: every configured trial must have been attempted, AND the suite
 *     must have at least one gradeable trial. `minGradeableTrials` is pinned to
 *     `1` so the second half of that rule is present in the payload instead of
 *     living in prose.
 *   - `minEligibleTrials` — an explicit floor N REPLACES the coverage rule
 *     above: `eligibleTrials >= N`, and an unattempted configured trial is no
 *     longer disqualifying on its own.
 *
 * `minCompletionRate` (suite-file default **0.8**) and `maxEvaluatorErrorRate`
 * (default **0.1**) are INDEPENDENT checks under either coverage rule.
 */
export const evalValidityCoverageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("allConfiguredTrialsAttempted"),
      minGradeableTrials: z.literal(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("minEligibleTrials"),
      minEligibleTrials: z.number().int().min(1),
    })
    .strict(),
]);
export type EvalValidityCoverage = z.infer<typeof evalValidityCoverageSchema>;

export const resolvedEvalValidityPolicySchema = z
  .object({
    coverage: evalValidityCoverageSchema,
    minCompletionRate: evalFractionSchema,
    maxEvaluatorErrorRate: evalFractionSchema,
  })
  .strict();
export type ResolvedEvalValidityPolicy = z.infer<
  typeof resolvedEvalValidityPolicySchema
>;

// ── why a verdict is what it is ──────────────────────────────────────────────
/**
 * Reasons that make a run `inconclusive`. Evaluated BEFORE any task verdict.
 *
 *   - `configuredTrialsNotAttempted`   — coverage rule
 *     `allConfiguredTrialsAttempted`: some configured trial never ran.
 *   - `noGradeableTrials`              — same rule: nothing in the suite was
 *     gradeable.
 *   - `eligibleTrialsBelowMinimum`     — explicit `minEligibleTrials` N not
 *     reached.
 *   - `completionRateBelowMinimum`     — measured, and under the floor.
 *   - `completionRateNotMeasured`      — nothing was attempted, so the floor is
 *     unsatisfiable. A `notMeasured` rate never passes a floor.
 *   - `evaluatorErrorRateAboveMaximum` — the grader failed too often for the
 *     run to describe the server.
 *   - `evaluatorErrorRateNotMeasured`  — the same unsatisfiable case for the
 *     ceiling.
 *   - `caseHasNoEligibleTrials`        — a case graded nothing. Inconclusive
 *     even at `passThreshold: 0`.
 */
export const EVAL_VALIDITY_DECISION_REASONS = [
  "configuredTrialsNotAttempted",
  "noGradeableTrials",
  "eligibleTrialsBelowMinimum",
  "completionRateBelowMinimum",
  "completionRateNotMeasured",
  "evaluatorErrorRateAboveMaximum",
  "evaluatorErrorRateNotMeasured",
  "caseHasNoEligibleTrials",
] as const;
export type EvalValidityDecisionReason =
  (typeof EVAL_VALIDITY_DECISION_REASONS)[number];

/**
 * Reasons that decide a `passed` / `failed` task verdict, once validity holds.
 *
 *   - `casePassRateMetThreshold`       — a case's own passing reason.
 *   - `casePassRateBelowThreshold`     — a case failed its threshold, and so
 *     therefore did the suite.
 *   - `allMeasuredCasesMetThreshold`   — the suite's only passing reason.
 */
export const EVAL_TASK_DECISION_REASONS = [
  "casePassRateMetThreshold",
  "casePassRateBelowThreshold",
  "allMeasuredCasesMetThreshold",
] as const;
export type EvalTaskDecisionReason =
  (typeof EVAL_TASK_DECISION_REASONS)[number];

/** The full closed reason vocabulary, validity reasons first. */
export const EVAL_VERDICT_DECISION_REASONS = [
  ...EVAL_VALIDITY_DECISION_REASONS,
  ...EVAL_TASK_DECISION_REASONS,
] as const;
export type EvalVerdictDecisionReason =
  (typeof EVAL_VERDICT_DECISION_REASONS)[number];
export const evalVerdictDecisionReasonSchema = z.enum(
  EVAL_VERDICT_DECISION_REASONS
);

export function isEvalVerdictDecisionReason(
  value: unknown
): value is EvalVerdictDecisionReason {
  return (
    typeof value === "string" &&
    (EVAL_VERDICT_DECISION_REASONS as readonly string[]).includes(value)
  );
}

export function isEvalValidityDecisionReason(
  value: unknown
): value is EvalValidityDecisionReason {
  return (
    typeof value === "string" &&
    (EVAL_VALIDITY_DECISION_REASONS as readonly string[]).includes(value)
  );
}

// ── per-case aggregation ─────────────────────────────────────────────────────
/**
 * One case's trials, rolled up.
 *
 * The arithmetic is pinned here because four runtimes must agree on it:
 *
 *   - `passRate`          — `passedTrials / eligibleTrials`.
 *   - `completionRate`    — completed attempted trials / `attemptedTrials`.
 *   - `observedStability` — `max(passedTrials, failedTrials) / eligibleTrials`.
 *     A run that failed EVERY eligible trial is perfectly stable: stability
 *     `1`, pass rate `0`. Reading stability as a quality score is the misread
 *     this note exists to prevent.
 *   - `mixedVerdict`      — both a pass and a fail are present. Not "unstable":
 *     it is the flag that says the case did not agree with itself.
 *
 * `verdict` is `inconclusive` exactly when nothing was eligible, `passed` when
 * `passRate.value >= effectivePassThreshold` (EQUALITY passes, at every
 * threshold including `0` and `1`), and `failed` otherwise.
 */
export const evalCaseVerdictAggregationStructuralSchema = z
  .object({
    caseId: opaqueIdSchema,
    /** What the resolved suite/case `repetitions` asked for. */
    configuredTrials: configuredTrialsSchema,
    /** Configured trials that actually began. */
    attemptedTrials: trialCountSchema,
    /** Attempted trials that produced a gradeable task verdict. */
    eligibleTrials: trialCountSchema,
    passedTrials: trialCountSchema,
    failedTrials: trialCountSchema,
    /** The case's own `passThreshold`, or the suite default it inherited. */
    effectivePassThreshold: evalFractionSchema,
    passRate: evalRateMeasurementStructuralSchema,
    completionRate: evalRateMeasurementStructuralSchema,
    observedStability: evalRateMeasurementStructuralSchema,
    mixedVerdict: z.boolean(),
    verdict: evalRunVerdictSchema,
    reason: evalVerdictDecisionReasonSchema,
  })
  .strict();

/**
 * The case validator, with every cross-field rule the structural half cannot
 * express.
 *
 * These are CONSISTENCY checks on a supplied roll-up, not an aggregator: they
 * refuse a payload whose verdict does not follow from the counts it ships with.
 * That is what lets this wave pin the semantics before any producer exists —
 * the expected-output fixtures are checked by the same validator a real
 * producer will be checked by.
 */
export const evalCaseVerdictAggregationSchema =
  evalCaseVerdictAggregationStructuralSchema.superRefine((entry, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (entry.attemptedTrials > entry.configuredTrials) {
      fail(
        "attemptedTrials",
        `attempted ${entry.attemptedTrials} exceeds configured ${entry.configuredTrials}`
      );
    }
    if (entry.eligibleTrials > entry.attemptedTrials) {
      fail(
        "eligibleTrials",
        `eligible ${entry.eligibleTrials} exceeds attempted ${entry.attemptedTrials}`
      );
    }
    if (entry.passedTrials + entry.failedTrials !== entry.eligibleTrials) {
      fail(
        "eligibleTrials",
        `passed ${entry.passedTrials} + failed ${entry.failedTrials} must equal ` +
          `eligible ${entry.eligibleTrials}: an eligible trial is one with a ` +
          `task verdict, so there is no third bucket`
      );
    }
    if (
      entry.mixedVerdict !== (entry.passedTrials > 0 && entry.failedTrials > 0)
    ) {
      fail(
        "mixedVerdict",
        `mixedVerdict must be true exactly when both a pass and a fail were graded`
      );
    }

    // Each rate's denominator identifies WHICH population it measured; a rate
    // over the wrong denominator is the classic way a stale numerator survives.
    if (entry.passRate.denominator !== entry.eligibleTrials) {
      fail(
        "passRate",
        `passRate denominator ${entry.passRate.denominator} must be eligibleTrials ${entry.eligibleTrials}`
      );
    }
    if (entry.passRate.numerator !== entry.passedTrials) {
      fail(
        "passRate",
        `passRate numerator ${entry.passRate.numerator} must be passedTrials ${entry.passedTrials}`
      );
    }
    if (entry.completionRate.denominator !== entry.attemptedTrials) {
      fail(
        "completionRate",
        `completionRate denominator ${entry.completionRate.denominator} must be attemptedTrials ${entry.attemptedTrials}`
      );
    }
    if (entry.observedStability.denominator !== entry.eligibleTrials) {
      fail(
        "observedStability",
        `observedStability denominator ${entry.observedStability.denominator} must be eligibleTrials ${entry.eligibleTrials}`
      );
    }
    const dominant = Math.max(entry.passedTrials, entry.failedTrials);
    if (entry.observedStability.numerator !== dominant) {
      fail(
        "observedStability",
        `observedStability numerator ${entry.observedStability.numerator} must be ` +
          `max(passed, failed) = ${dominant}`
      );
    }

    if (entry.eligibleTrials === 0) {
      if (entry.verdict !== "inconclusive") {
        fail(
          "verdict",
          `a case with no eligible trials is inconclusive, whatever its threshold`
        );
      }
      if (entry.reason !== "caseHasNoEligibleTrials") {
        fail("reason", `expected reason "caseHasNoEligibleTrials"`);
      }
      return;
    }

    if (entry.passRate.state !== "measured") {
      fail("passRate", `a case with eligible trials has a measured passRate`);
      return;
    }
    const met = entry.passRate.value >= entry.effectivePassThreshold;
    const expected: EvalRunVerdict = met ? "passed" : "failed";
    if (entry.verdict !== expected) {
      fail(
        "verdict",
        `passRate ${entry.passRate.value} against threshold ` +
          `${entry.effectivePassThreshold} is "${expected}"`
      );
    }
    const expectedReason: EvalVerdictDecisionReason = met
      ? "casePassRateMetThreshold"
      : "casePassRateBelowThreshold";
    if (entry.reason !== expectedReason) {
      fail("reason", `expected reason "${expectedReason}"`);
    }
  });
export type EvalCaseVerdictAggregation = z.infer<
  typeof evalCaseVerdictAggregationSchema
>;

// ── the decision ─────────────────────────────────────────────────────────────
/** Suite-level trial totals and the two validity rates measured over them. */
export const evalVerdictValidityStructuralSchema = z
  .object({
    policy: resolvedEvalValidityPolicySchema,
    /** Whether the validity phase passed. `false` forces `inconclusive`. */
    holds: z.boolean(),
    configuredTrials: trialCountSchema,
    attemptedTrials: trialCountSchema,
    eligibleTrials: trialCountSchema,
    /** Completed attempted trials over attempted trials. */
    completionRate: evalRateMeasurementStructuralSchema,
    /** Evaluator-error trials over attempted trials. */
    evaluatorErrorRate: evalRateMeasurementStructuralSchema,
  })
  .strict();

/**
 * The decision summary: one run's verdict, the validity phase that gated it,
 * and every case that fed it.
 *
 * `reasons` is ORDERED and non-empty, and it is the audit trail rather than
 * decoration — an `inconclusive` verdict whose reasons are all task reasons is
 * refused, because it claims the validity phase concluded something it cannot.
 */
export const evalVerdictDecisionStructuralSchema = z
  .object({
    verdictPolicyVersion: evalVerdictPolicyVersionSchema,
    verdict: evalRunVerdictSchema,
    reasons: z
      .array(evalVerdictDecisionReasonSchema)
      .min(1)
      .max(EVAL_VERDICT_DECISION_REASONS.length),
    validity: evalVerdictValidityStructuralSchema,
    cases: z
      .array(evalCaseVerdictAggregationStructuralSchema)
      .min(1)
      .max(MAX_SUITE_FILE_CASES),
  })
  .strict();

/**
 * The decision validator.
 *
 * Beyond re-running every case's own consistency rules, it pins the two
 * things the phase ORDER means:
 *
 *   1. `holds: false` ⇒ `inconclusive`, and every reason is a validity reason.
 *   2. `holds: true`  ⇒ the verdict follows from the cases alone: any
 *      unmeasured case ⇒ `inconclusive`; any measured case under its own
 *      threshold ⇒ `failed`; otherwise `passed`.
 *
 * `holds` itself is checked against the measurements it claims to summarize, so
 * a producer cannot assert validity it did not have. This is validation of a
 * supplied summary — no verdict is produced from trials anywhere in this file.
 */
export const evalVerdictDecisionSchema =
  evalVerdictDecisionStructuralSchema.superRefine((decision, ctx) => {
    const fail = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    for (const [index, entry] of decision.cases.entries()) {
      const parsed = evalCaseVerdictAggregationSchema.safeParse(entry);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          fail(["cases", index, ...issue.path], issue.message);
        }
      }
    }

    const seenReasons = new Set<string>();
    decision.reasons.forEach((reason, index) => {
      if (seenReasons.has(reason)) {
        fail(["reasons", index], `duplicate reason "${reason}"`);
      }
      seenReasons.add(reason);
    });

    const totals = decision.cases.reduce(
      (sum, entry) => ({
        configured: sum.configured + entry.configuredTrials,
        attempted: sum.attempted + entry.attemptedTrials,
        eligible: sum.eligible + entry.eligibleTrials,
      }),
      { configured: 0, attempted: 0, eligible: 0 }
    );
    const validity = decision.validity;
    if (validity.configuredTrials !== totals.configured) {
      fail(
        ["validity", "configuredTrials"],
        `configuredTrials ${validity.configuredTrials} must be the sum over cases (${totals.configured})`
      );
    }
    if (validity.attemptedTrials !== totals.attempted) {
      fail(
        ["validity", "attemptedTrials"],
        `attemptedTrials ${validity.attemptedTrials} must be the sum over cases (${totals.attempted})`
      );
    }
    if (validity.eligibleTrials !== totals.eligible) {
      fail(
        ["validity", "eligibleTrials"],
        `eligibleTrials ${validity.eligibleTrials} must be the sum over cases (${totals.eligible})`
      );
    }
    if (validity.completionRate.denominator !== validity.attemptedTrials) {
      fail(
        ["validity", "completionRate"],
        `completionRate denominator ${validity.completionRate.denominator} must be attemptedTrials ${validity.attemptedTrials}`
      );
    }
    if (validity.evaluatorErrorRate.denominator !== validity.attemptedTrials) {
      fail(
        ["validity", "evaluatorErrorRate"],
        `evaluatorErrorRate denominator ${validity.evaluatorErrorRate.denominator} must be attemptedTrials ${validity.attemptedTrials}`
      );
    }

    // ── validity, exactly as the phase defines it ──
    const coverageMet =
      validity.policy.coverage.kind === "minEligibleTrials"
        ? validity.eligibleTrials >= validity.policy.coverage.minEligibleTrials
        : validity.attemptedTrials === validity.configuredTrials &&
          validity.eligibleTrials >=
            validity.policy.coverage.minGradeableTrials;
    const completionMet =
      validity.completionRate.state === "measured" &&
      validity.completionRate.value >= validity.policy.minCompletionRate;
    const evaluatorMet =
      validity.evaluatorErrorRate.state === "measured" &&
      validity.evaluatorErrorRate.value <=
        validity.policy.maxEvaluatorErrorRate;
    const everyCaseMeasured = decision.cases.every(
      (entry) => entry.eligibleTrials > 0
    );
    const expectedHolds =
      coverageMet && completionMet && evaluatorMet && everyCaseMeasured;
    if (validity.holds !== expectedHolds) {
      fail(
        ["validity", "holds"],
        `holds must be ${expectedHolds} for these measurements against this policy`
      );
    }

    if (!expectedHolds) {
      if (decision.verdict !== "inconclusive") {
        fail(
          ["verdict"],
          `validity does not hold, so the verdict is inconclusive — a run that ` +
            `was not measured says nothing about the server`
        );
      }
      const taskReason = decision.reasons.find(
        (reason) => !isEvalValidityDecisionReason(reason)
      );
      if (taskReason) {
        fail(
          ["reasons"],
          `"${taskReason}" is a task reason, but validity is evaluated first ` +
            `and did not hold`
        );
      }
      return;
    }

    const unmeasured = decision.cases.find(
      (entry) => entry.verdict === "inconclusive"
    );
    const failedCase = decision.cases.find(
      (entry) => entry.verdict === "failed"
    );
    const expectedVerdict: EvalRunVerdict = unmeasured
      ? "inconclusive"
      : failedCase
      ? "failed"
      : "passed";
    if (decision.verdict !== expectedVerdict) {
      fail(
        ["verdict"],
        `with validity holding, the cases make this run "${expectedVerdict}"`
      );
    }
    if (expectedVerdict === "passed") {
      if (!decision.reasons.includes("allMeasuredCasesMetThreshold")) {
        fail(
          ["reasons"],
          `a passed run records "allMeasuredCasesMetThreshold"`
        );
      }
    } else if (
      expectedVerdict === "failed" &&
      !decision.reasons.includes("casePassRateBelowThreshold")
    ) {
      fail(["reasons"], `a failed run records "casePassRateBelowThreshold"`);
    }
  });
export type EvalVerdictDecision = z.infer<typeof evalVerdictDecisionSchema>;
export type EvalVerdictValidity = EvalVerdictDecision["validity"];
