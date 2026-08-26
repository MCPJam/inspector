/**
 * `EvalStageAnalyticsV1` — one run's stage funnel, materialized.
 *
 * This module is browser-safe and intentionally has no node-only deps, and it
 * is PURE: no ctx, no network, no clock. Every timestamp it carries is passed
 * in by its caller.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * "Where do trials fall out of the chain, and does that differ by intent, by
 * model, or by host?" — answered from ONE indexed derived row per run, not by
 * scanning iteration metadata and not by reading trace blobs. The precedent is
 * the denormalized run summary, and the reason is the same: a dashboard that
 * aggregates raw child rows gets slower with every run and eventually stops
 * answering at all.
 *
 * ── The rules this shape exists to enforce ───────────────────────────────────
 *
 * **1. Counts are stored; rates are derived.** Nothing persisted here is a
 * rate, a mean, a percentile or a confidence interval. Storing `passRate: 0.8`
 * throws away the numerator and the denominator, and a stored rate cannot be
 * re-sliced, re-checked, or told apart from `4/5` and `800/1000` — which are
 * very different claims. The rate helpers at the bottom of this file derive
 * every rate on demand and every one of them ships its arithmetic.
 *
 * **2. A zero denominator is `notMeasured`, never `0`.** This is the single
 * failure mode the whole contract is built against: `0/0` rendering as `0%` and
 * being read as "everything failed", or as `100%` and being read as "all
 * green". {@link EvalStageRate} makes it unrepresentable as a number.
 *
 * **3. Unknown is not a drop-off.** A trial whose stage captured nothing is
 * excluded from the reach denominator with a named class, not counted as having
 * failed to reach. Every exclusion is COUNTED and returned: a denominator that
 * quietly shrank is indistinguishable from a server that quietly improved.
 *
 * **4. Marginals only — never a cross-product.** Slices are `overall`,
 * `intent`, `model`, `host`, each independently. There is deliberately no
 * intent×model×host cube: it multiplies row size by three dimensions' cardinality
 * for cells that mostly hold one or two trials, and a funnel computed over two
 * trials is not a comparison. See {@link EvalStageAnalyticsSlice}.
 *
 * **5. Trials are the unit.** {@link EvalStageAnalyticsV1.measurementUnit} is
 * the literal `"trial"` and is carried on the row rather than assumed. An eval
 * iteration, a user-testing session and a swarm traversal share this
 * vocabulary but are NOT the same measurement unit, and a denominator that
 * silently mixes them is a number with no meaning. The literal is what makes a
 * mistaken merge fail loudly.
 *
 * ── Provisionality ───────────────────────────────────────────────────────────
 *
 * A judge second pass can REWRITE stage attribution after the run first becomes
 * terminal. So this row is rebuilt after terminalization and again after each
 * applicable judge fanout completes, and it says which it is:
 * {@link EvalStageAnalyticsV1.materializationState} is `provisional` while any
 * applicable fanout is still pending and `final` afterwards. A consumer that
 * renders a provisional row as settled will show a funnel that changes under
 * the reader with no explanation.
 *
 * ── Absence ──────────────────────────────────────────────────────────────────
 *
 * No backfill. Runs from before this shipped have no row, and a missing row
 * renders as UNMEASURED — never as zero, and never as a funnel of empty stages.
 */

import { z } from "zod";
import {
  FAILURE_CATEGORIES,
  USER_VALUE_STAGES,
  failureCategorySchema,
  userValueStageSchema,
} from "./chain.js";
import { STAGE_REASONS, stageReasonSchema } from "./stage-derivation.js";
import {
  LATENCY_BASIS_EVIDENCE_SPAN_UNION,
  LATENCY_BASIS_SETUP_PHASE_WALL,
  LATENCY_UNIT,
} from "./stage-measurements.js";
import {
  EVAL_RATE_MEASUREMENT_STATES,
  evalFractionSchema,
} from "./verdict-policy.js";

/** The analytics schema version, as a literal. Absence means "no row". */
export const EVAL_STAGE_ANALYTICS_SCHEMA_VERSION = 1;
export type EvalStageAnalyticsSchemaVersion =
  typeof EVAL_STAGE_ANALYTICS_SCHEMA_VERSION;

/** The `$id` of the published JSON Schema for this contract. */
export const EVAL_STAGE_ANALYTICS_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-stage-analytics/v1.json";

const countSchema = z.number().int().min(0);

// ── caps ─────────────────────────────────────────────────────────────────────
/**
 * How many distinct values each marginal dimension may retain.
 *
 * Caps exist because a row must have a bounded size, and unbounded means a
 * 500-case suite with a free-text label per case produces a 500-row slice array
 * on a single document. They are per-dimension because the dimensions have very
 * different natural cardinality: intents are authored (many), models and hosts
 * are configured (few).
 *
 * When a cap bites it is RECORDED, never silent — see
 * {@link EvalStageAnalyticsV1.sliceTruncation}. A truncated slice array that
 * looked complete would be read as "these are all the models", which is exactly
 * the false comparison this whole contract is trying not to ship.
 */
export const MAX_INTENT_SLICES = 50;
export const MAX_MODEL_SLICES = 25;
export const MAX_HOST_SLICES = 25;

/**
 * The total slice cap, stated so a storage mirror can size the row.
 *
 * The `1` is `overall`, which is never truncated and never absent: a run whose
 * dimension values all fell off a cap must still report its funnel.
 */
export const MAX_ANALYTICS_SLICES =
  1 + MAX_INTENT_SLICES + MAX_MODEL_SLICES + MAX_HOST_SLICES;

/** Six stages, six tallies. Fixed by {@link USER_VALUE_STAGES}, not a cap. */
export const STAGE_TALLIES_PER_SLICE = USER_VALUE_STAGES.length;

// ── materialization state ────────────────────────────────────────────────────
/**
 * Whether this row is done changing.
 *
 *   - `provisional` — at least one applicable judge fanout is still pending, so
 *     stage attribution may still be rewritten under it.
 *   - `final` — every applicable fanout has completed. The counts will not move
 *     again without a new run.
 *
 * There is no `stale`. A row is rebuilt in place after each fanout, so a reader
 * never has to reason about a row that is final-but-out-of-date.
 */
export const EVAL_STAGE_ANALYTICS_MATERIALIZATION_STATES = [
  "provisional",
  "final",
] as const;
export type EvalStageAnalyticsMaterializationState =
  (typeof EVAL_STAGE_ANALYTICS_MATERIALIZATION_STATES)[number];
export const evalStageAnalyticsMaterializationStateSchema = z.enum(
  EVAL_STAGE_ANALYTICS_MATERIALIZATION_STATES
);

// ── exclusions ───────────────────────────────────────────────────────────────
/**
 * Why a trial (or a stage observation) was left out of a denominator.
 *
 * A CLOSED vocabulary, and deliberately its OWN rather than a reuse of
 * `EVAL_TRIAL_EXCLUSION_REASONS` from the verdict policy. The chain of eval
 * surfaces shares vocabulary, not denominators: the verdict policy excludes
 * trials from a PASS RATE, this excludes observations from a FUNNEL, and the
 * two do not exclude the same things. `reachUnknown` has no meaning to a
 * verdict; `evaluatorError` does not remove a trial from a reach denominator.
 * Folding them into one list would produce a tally whose keys mean different
 * things depending on which rate is reading it.
 *
 *   - `lifecycle`      — the trial never produced a comparable observation:
 *     not terminal, skipped, cancelled, timed out, setup-failed, execution
 *     failed, or the evaluator itself errored.
 *   - `integrity`      — a chain or a measurement was missing, unverified or
 *     rejected at the write boundary. NOT a passing observation. Never coerced.
 *   - `version`        — produced by an analyzer or schema version this reader
 *     does not understand. Also not coerced: a version-ahead payload may mean
 *     something different by the same word.
 *   - `notApplicable`  — the stage does not apply to this case at all.
 *   - `reachUnknown`   — nothing was captured, so reach cannot be decided.
 *   - `notMeasured`    — the stage was reached but nothing decided it.
 */
export const EVAL_STAGE_EXCLUSION_CLASSES = [
  "lifecycle",
  "integrity",
  "version",
  "notApplicable",
  "reachUnknown",
  "notMeasured",
] as const;
export type EvalStageExclusionClass =
  (typeof EVAL_STAGE_EXCLUSION_CLASSES)[number];

/**
 * How many observations each class removed from ONE denominator.
 *
 * Optional counts, and a class that excluded nothing is OMITTED rather than
 * written as `0` — so the payload round-trips byte-stable and `0` never has to
 * be told apart from absent (they mean the same thing here).
 */
export const evalStageExclusionsSchema = z
  .object({
    lifecycle: countSchema.optional(),
    integrity: countSchema.optional(),
    version: countSchema.optional(),
    notApplicable: countSchema.optional(),
    reachUnknown: countSchema.optional(),
    notMeasured: countSchema.optional(),
  })
  .strict();
export type EvalStageExclusions = z.infer<typeof evalStageExclusionsSchema>;

/**
 * The FINE-GRAINED reason a trial was excluded, run-level only.
 *
 * {@link EvalStageExclusions} is deliberately coarse — six classes — because it
 * is repeated on every stage of every slice and a per-stage tally of fifteen
 * keys is mostly zeros. But "we could not read the chain" and "the chain was
 * there and the server refused to believe it" are different operator actions,
 * and collapsing them everywhere would make the run-level coverage report
 * unactionable.
 *
 * So the detail is carried ONCE, at the run level, beside the coarse tally.
 *
 * `analyzerMismatch` is its own key rather than a flavour of `chainVersionAhead`:
 * version-AHEAD means a newer producer we have not caught up to (expected during
 * a deploy, and harmless once we have), while a MISMATCH between the chain's
 * analyzer version and its own measurements' is a payload whose two halves were
 * produced by different analyzers — always a bug, never a deploy window.
 */
export const evalStageCoverageDetailSchema = z
  .object({
    // lifecycle
    notTerminal: countSchema.optional(),
    skipped: countSchema.optional(),
    cancelled: countSchema.optional(),
    setupFailed: countSchema.optional(),
    timedOut: countSchema.optional(),
    executionFailed: countSchema.optional(),
    evaluatorError: countSchema.optional(),
    // chain integrity
    chainMissing: countSchema.optional(),
    chainUnverified: countSchema.optional(),
    chainVersionAhead: countSchema.optional(),
    // measurement integrity
    measurementsMissing: countSchema.optional(),
    measurementsInvalid: countSchema.optional(),
    measurementsVersionAhead: countSchema.optional(),
    // the two halves disagree about which analyzer produced them
    analyzerMismatch: countSchema.optional(),
  })
  .strict();
export type EvalStageCoverageDetail = z.infer<
  typeof evalStageCoverageDetailSchema
>;

// ── the rate envelope ────────────────────────────────────────────────────────
/**
 * One derived rate, with the arithmetic that produced it.
 *
 * Same discipline as the verdict policy's `EvalRateMeasurement` — a
 * discriminated union so `0/0` cannot be a number — over this contract's own
 * exclusion vocabulary. Nothing persists this shape; it is what the read-side
 * helpers return.
 */
export const evalStageRateSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal(EVAL_RATE_MEASUREMENT_STATES[0]),
      value: evalFractionSchema,
      numerator: countSchema,
      denominator: z.number().int().min(1),
      exclusions: evalStageExclusionsSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal(EVAL_RATE_MEASUREMENT_STATES[1]),
      value: z.null(),
      numerator: z.literal(0),
      denominator: z.literal(0),
      exclusions: evalStageExclusionsSchema,
    })
    .strict(),
]);
export type EvalStageRate = z.infer<typeof evalStageRateSchema>;

/**
 * Build a rate from counts, or `notMeasured` when there is nothing to divide.
 *
 * The ONE place a stage rate is constructed, so the zero-denominator branch is
 * written once instead of at every call site that needs a percentage. A
 * numerator larger than its denominator is a caller bug and is clamped to
 * `notMeasured` rather than emitted: a rate above 1 is not a value anyone can
 * act on, and shipping it would put an impossible number on a dashboard.
 */
export function stageRate(
  numerator: number,
  denominator: number,
  exclusions: EvalStageExclusions = {}
): EvalStageRate {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    return {
      state: "notMeasured",
      value: null,
      numerator: 0,
      denominator: 0,
      exclusions,
    };
  }
  return {
    state: "measured",
    value: numerator / denominator,
    numerator,
    denominator,
    exclusions,
  };
}

// ── latency aggregates ───────────────────────────────────────────────────────
/**
 * Sums, not means.
 *
 * `totalMs` + `sampleCount` is strictly more information than a mean and is
 * MERGEABLE: two aggregates can be added, two means cannot. `minMs`/`maxMs` are
 * supporting detail. There is no p99 and no confidence interval here on
 * purpose — computing either from a bucketed sum is not possible, and computing
 * it from a handful of trials would be a precision claim this data does not
 * support.
 */
function latencyAggregateSchema<B extends string>(basis: B) {
  return z
    .object({
      unit: z.literal(LATENCY_UNIT),
      basis: z.literal(basis),
      /** At least one. An aggregate with no samples is OMITTED, not zeroed. */
      sampleCount: z.number().int().min(1),
      totalMs: z.number().finite().min(0),
      minMs: z.number().finite().min(0),
      maxMs: z.number().finite().min(0),
    })
    .strict()
    .superRefine((agg, ctx) => {
      if (agg.minMs > agg.maxMs) {
        ctx.addIssue({
          code: "custom",
          path: ["minMs"],
          message: `minMs ${agg.minMs} exceeds maxMs ${agg.maxMs}`,
        });
      }
      // The bounds must be able to produce the total. A total below
      // `min × count` or above `max × count` proves the three numbers did not
      // come from the same set of samples — the signature of a merge that added
      // totals but forgot the counts.
      if (agg.totalMs < agg.minMs * agg.sampleCount) {
        ctx.addIssue({
          code: "custom",
          path: ["totalMs"],
          message:
            `totalMs ${agg.totalMs} is below minMs × sampleCount ` +
            `(${agg.minMs} × ${agg.sampleCount}); the counts and bounds ` +
            `describe different sample sets`,
        });
      }
      if (agg.totalMs > agg.maxMs * agg.sampleCount) {
        ctx.addIssue({
          code: "custom",
          path: ["totalMs"],
          message:
            `totalMs ${agg.totalMs} exceeds maxMs × sampleCount ` +
            `(${agg.maxMs} × ${agg.sampleCount}); the counts and bounds ` +
            `describe different sample sets`,
        });
      }
    });
}

export const evalStageLatencyAggregateSchema = latencyAggregateSchema(
  LATENCY_BASIS_EVIDENCE_SPAN_UNION
);
export type EvalStageLatencyAggregate = z.infer<
  typeof evalStageLatencyAggregateSchema
>;

export const evalSetupLatencyAggregateSchema = latencyAggregateSchema(
  LATENCY_BASIS_SETUP_PHASE_WALL
);
export type EvalSetupLatencyAggregate = z.infer<
  typeof evalSetupLatencyAggregateSchema
>;

/**
 * The mean, derived from the count and the sum.
 *
 * `null` for an absent aggregate rather than `0`, for the same reason every
 * other absence in this file is not zero: a mean of no samples is not a fast
 * server. Callers render `null` as "no samples", never as a number.
 */
export function latencyMeanMs(
  aggregate:
    | Pick<EvalStageLatencyAggregate, "sampleCount" | "totalMs">
    | undefined
): number | null {
  if (aggregate === undefined || aggregate.sampleCount <= 0) return null;
  return aggregate.totalMs / aggregate.sampleCount;
}

// ── per-stage tally ──────────────────────────────────────────────────────────
const reasonCountSchema = z
  .object({ reason: stageReasonSchema, count: z.number().int().min(1) })
  .strict();

/**
 * One stage's counts within one slice.
 *
 * Every field is a COUNT of trials. The relationships that must hold are
 * checked by {@link evalStageTallySchema}'s refinements rather than being
 * relied upon by convention, because a funnel whose stages do not sum
 * consistently is not a funnel — it is six unrelated numbers drawn in a row.
 */
export const evalStageTallySchema = z
  .object({
    stage: userValueStageSchema,
    /** Trials for which this stage applies at all (`included − notApplicable`). */
    applicable: countSchema,
    reached: countSchema,
    notReached: countSchema,
    /** Reached-ness could not be decided. Excluded from the reach denominator. */
    reachUnknown: countSchema,
    /** Reached AND decided — `passed + failed`. */
    measured: countSchema,
    passed: countSchema,
    failed: countSchema,
    /** Reached but nothing decided it. */
    notMeasured: countSchema,
    notApplicable: countSchema,
    /** Trials dropped before this stage could be observed, by class. */
    excluded: evalStageExclusionsSchema,
    /**
     * Why stages landed where they did, by reason code.
     *
     * Bounded by `STAGE_REASONS` and ordered by it. Kept BESIDE the slice's
     * failure categories rather than merged into them: `judgeFailed` on
     * `selection` and a deterministic `unexpectedToolCall` on `selection` are
     * both selection failures and are not the same finding, and an operator
     * acts differently on each.
     */
    reasons: z.array(reasonCountSchema).max(STAGE_REASONS.length),
    latency: evalStageLatencyAggregateSchema.optional(),
  })
  .strict()
  .superRefine((tally, ctx) => {
    if (tally.passed + tally.failed !== tally.measured) {
      ctx.addIssue({
        code: "custom",
        path: ["measured"],
        message:
          `measured ${tally.measured} is not passed + failed ` +
          `(${tally.passed} + ${tally.failed})`,
      });
    }
    if (tally.measured + tally.notMeasured !== tally.reached) {
      ctx.addIssue({
        code: "custom",
        path: ["reached"],
        message:
          `reached ${tally.reached} is not measured + notMeasured ` +
          `(${tally.measured} + ${tally.notMeasured})`,
      });
    }
    if (
      tally.reached + tally.notReached + tally.reachUnknown !==
      tally.applicable
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["applicable"],
        message:
          `applicable ${tally.applicable} is not reached + notReached + ` +
          `reachUnknown (${tally.reached} + ${tally.notReached} + ` +
          `${tally.reachUnknown})`,
      });
    }
    if (
      tally.latency !== undefined &&
      tally.latency.sampleCount > tally.reached
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["latency", "sampleCount"],
        message:
          `latency sampleCount ${tally.latency.sampleCount} exceeds reached ` +
          `${tally.reached}; a stage cannot be timed more often than it ran`,
      });
    }
  });
export type EvalStageTally = z.infer<typeof evalStageTallySchema>;

// ── slices ───────────────────────────────────────────────────────────────────
const categoryCountSchema = z
  .object({ category: failureCategorySchema, count: z.number().int().min(1) })
  .strict();

/**
 * Which population a slice describes.
 *
 * A discriminated union rather than `{dimension: string, value?: string}`
 * because the dimensions do not share a key shape: a model needs a provider
 * beside it (two providers serve models by the same name), and a host needs a
 * stable key that survives being renamed.
 *
 * MARGINAL only. There is no combined dimension and adding one is a version
 * bump, not a new member — see rule 4 in the module docblock.
 */
export const evalStageAnalyticsSliceSchema = z.discriminatedUnion("dimension", [
  z.object({ dimension: z.literal("overall") }).strict(),
  z
    .object({
      dimension: z.literal("intent"),
      /**
       * `null` is UNLABELLED, and is a real slice rather than an omission —
       * historically untagged cases are the majority and dropping them would
       * make the intent funnel describe a subset while looking like the whole.
       * Never the display word: see `UNLABELED_INTENT_LABEL`.
       */
      intent: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      dimension: z.literal("model"),
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .strict(),
  z
    .object({
      dimension: z.literal("host"),
      /** Stable across renames. The join key, not the display name. */
      hostKey: z.string().min(1),
      hostName: z.string().min(1).optional(),
      /** `emulated` | `harness:<id>`. Absent means NOT RECORDED, not emulated. */
      executionEngine: z.string().min(1).optional(),
    })
    .strict(),
]);
export type EvalStageAnalyticsSlice = z.infer<
  typeof evalStageAnalyticsSliceSchema
>;

export const evalStageAnalyticsSliceRowSchema = z
  .object({
    slice: evalStageAnalyticsSliceSchema,
    /** Trials that contributed observations to this slice. */
    includedTrials: countSchema,
    /** Trials attributed to this slice that contributed nothing, by class. */
    excludedTrials: evalStageExclusionsSchema,
    /**
     * Failure categories over TRIALS in this slice.
     *
     * Slice-level rather than per-stage because `failureCategory` is one bucket
     * per trial, not per stage — a setup abort and an evaluator error are both
     * categories with NO failed stage at all, and per-stage counts would have
     * nowhere to put them. Ordered by `FAILURE_CATEGORIES`.
     */
    failureCategories: z
      .array(categoryCountSchema)
      .max(FAILURE_CATEGORIES.length),
    /** Six tallies, in `USER_VALUE_STAGES` order. Never sorted. */
    stages: z.array(evalStageTallySchema).length(STAGE_TALLIES_PER_SLICE),
  })
  .strict()
  .superRefine((row, ctx) => {
    USER_VALUE_STAGES.forEach((stage, index) => {
      const tally = row.stages[index];
      if (tally !== undefined && tally.stage !== stage) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "stage"],
          message:
            `stages[${index}] is '${tally.stage}' but must be '${stage}': the ` +
            `six tallies are a funnel and position is meaning`,
        });
      }
    });
  });
export type EvalStageAnalyticsSliceRow = z.infer<
  typeof evalStageAnalyticsSliceRowSchema
>;

// ── setup ────────────────────────────────────────────────────────────────────
export const SETUP_PHASES = ["connection", "discovery"] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

/**
 * One setup phase's facts for this run.
 *
 * RUN-LEVEL, not per-slice, and that placement is the point. A setup attempt
 * happens once per run+phase and is copied onto every iteration so the
 * derivation can read it per-iteration. Counting the copies gives a run with
 * 200 trials "200 connection attempts", all of them the same attempt. So
 * attempts are counted once here, while `impactedTrials` — which genuinely
 * varies per trial — is counted distinctly.
 *
 * That asymmetry is the whole reason this is a separate row shape rather than a
 * seventh stage tally.
 */
export const evalSetupTallySchema = z
  .object({
    phase: z.enum(SETUP_PHASES),
    /** Distinct attempts. One per run+phase that carried a setup signal. */
    uniqueAttempts: countSchema,
    failedAttempts: countSchema,
    /**
     * Failures attributable to the SERVER, under the pinned rule: the signal
     * said `theirs` AND our own egress was positively verified. Anything less
     * is `unknown` and is not attributed — blaming a server for our own
     * network is the failure mode this narrow rule exists to prevent.
     */
    serverAttributedFailures: countSchema,
    /**
     * DISTINCT trials this phase's failed attempts blocked.
     *
     * Counted per trial while attempts are counted per run+phase, so the
     * required reading holds: N copied signals ⇒ 1 attempt, 1 latency sample,
     * N impacted trials.
     */
    impactedTrials: countSchema,
    latency: evalSetupLatencyAggregateSchema.optional(),
  })
  .strict()
  .superRefine((tally, ctx) => {
    if (tally.failedAttempts > tally.uniqueAttempts) {
      ctx.addIssue({
        code: "custom",
        path: ["failedAttempts"],
        message:
          `failedAttempts ${tally.failedAttempts} exceeds uniqueAttempts ` +
          `${tally.uniqueAttempts}`,
      });
    }
    if (tally.serverAttributedFailures > tally.failedAttempts) {
      ctx.addIssue({
        code: "custom",
        path: ["serverAttributedFailures"],
        message:
          `serverAttributedFailures ${tally.serverAttributedFailures} exceeds ` +
          `failedAttempts ${tally.failedAttempts}`,
      });
    }
    if (
      tally.latency !== undefined &&
      tally.latency.sampleCount > tally.uniqueAttempts
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["latency", "sampleCount"],
        message:
          `latency sampleCount ${tally.latency.sampleCount} exceeds ` +
          `uniqueAttempts ${tally.uniqueAttempts}; setup latency is sampled ` +
          `once per attempt, never once per copied iteration`,
      });
    }
  });
export type EvalSetupTally = z.infer<typeof evalSetupTallySchema>;

/** The pinned server-attribution rule. */
export function isServerAttributedSetupFailure(signal: {
  outcome?: string;
  attribution?: string;
  egressVerified?: boolean;
}): boolean {
  return (
    signal.outcome === "failed" &&
    signal.attribution === "theirs" &&
    signal.egressVerified === true
  );
}

// ── the row ──────────────────────────────────────────────────────────────────
const sliceTruncationSchema = z
  .object({
    dimension: z.enum(["intent", "model", "host"]),
    /** How many distinct values the run actually had. */
    distinctValues: z.number().int().min(1),
    /** How many of them this row retained. */
    retained: z.number().int().min(0),
  })
  .strict();

export const evalStageAnalyticsStructuralSchema = z
  .object({
    schemaVersion: z.literal(EVAL_STAGE_ANALYTICS_SCHEMA_VERSION),
    /**
     * The literal `"trial"`, carried rather than assumed.
     *
     * See rule 5 in the module docblock: an eval iteration, a UT session and a
     * swarm traversal share this stage vocabulary and are different units. A
     * consumer that merges two rows must check this field first, and a literal
     * is what makes the mistake a type error instead of a wrong average.
     */
    measurementUnit: z.literal("trial"),

    runId: z.string().min(1),
    suiteId: z.string().min(1),
    /** Present when the run is grouped for comparison (a matrix, a schedule). */
    runGroupId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),

    /** When the run reached a terminal status. Epoch ms. */
    runCompletedAt: z.number().int().min(0).optional(),

    /** How many iterations this materialization actually read. */
    sourceIterationCount: countSchema,
    /**
     * The newest `_creationTime`/update stamp among those iterations.
     *
     * The staleness handle: a rebuild that reads a max-updated stamp no newer
     * than the stored one knows nothing moved. Without it, "has a judge
     * rewritten anything since?" can only be answered by re-reading everything.
     */
    sourceMaxUpdatedAt: z.number().int().min(0).optional(),

    /** The analyzer the source chains were derived at. */
    stageAnalyzerVersion: z.number().int().min(1),
    /** The measurement schema the source measurements were produced at. */
    measurementsSchemaVersion: z.number().int().min(1),

    materializationState: evalStageAnalyticsMaterializationStateSchema,
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),

    /** Run-wide chain coverage: what was counted and what was dropped. */
    includedTrials: countSchema,
    excludedTrials: evalStageExclusionsSchema,
    /** Every trial the materializer saw, included or not. */
    totalTrials: countSchema,
    /** The same exclusions, named precisely. Run-level only — see its docblock. */
    excludedTrialDetail: evalStageCoverageDetailSchema,

    /** Marginal slices, in canonical order. `overall` is always first. */
    slices: z.array(evalStageAnalyticsSliceRowSchema).max(MAX_ANALYTICS_SLICES),
    /** Run-level setup facts, one row per phase that had a signal. */
    setup: z.array(evalSetupTallySchema).max(SETUP_PHASES.length),
    /**
     * Which dimensions hit a cap, and by how much.
     *
     * Present ONLY when a cap bit. A truncated slice array with no such record
     * reads as "these are all the models", and a comparison drawn over an
     * unknowingly partial set is worse than no comparison.
     */
    sliceTruncation: z.array(sliceTruncationSchema).max(3).optional(),
  })
  .strict();

export const evalStageAnalyticsSchema =
  evalStageAnalyticsStructuralSchema.superRefine((row, ctx) => {
    const overall = row.slices.filter((s) => s.slice.dimension === "overall");
    const [only] = overall;
    if (overall.length !== 1 || only === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["slices"],
        message:
          `expected exactly one 'overall' slice, found ${overall.length}: the ` +
          `overall funnel is the one slice every reader can rely on`,
      });
    } else if (only.includedTrials !== row.includedTrials) {
      ctx.addIssue({
        code: "custom",
        path: ["slices"],
        message:
          `the overall slice counts ${only.includedTrials} included ` +
          `trials but the row counts ${row.includedTrials}`,
      });
    }
    if (row.includedTrials > row.totalTrials) {
      ctx.addIssue({
        code: "custom",
        path: ["includedTrials"],
        message:
          `includedTrials ${row.includedTrials} exceeds totalTrials ` +
          `${row.totalTrials}`,
      });
    }
    const phases = row.setup.map((s) => s.phase);
    if (new Set(phases).size !== phases.length) {
      ctx.addIssue({
        code: "custom",
        path: ["setup"],
        message:
          `duplicate setup phases ${JSON.stringify(phases)}: a phase is ` +
          `measured once per run and two rows for one phase means the copies ` +
          `were counted`,
      });
    }
  });
export type EvalStageAnalyticsV1 = z.infer<
  typeof evalStageAnalyticsStructuralSchema
>;

// ── derived rates ────────────────────────────────────────────────────────────
/**
 * Measurement coverage — of the trials that reached this stage, how many did we
 * actually decide?
 *
 * The first number to read, and the one that qualifies every other: a 100% pass
 * rate over 5% coverage is not a green server, it is an uninstrumented one.
 */
export function measurementCoverageRate(tally: EvalStageTally): EvalStageRate {
  return stageRate(tally.measured, tally.reached, {
    ...tally.excluded,
    ...(tally.notMeasured > 0 ? { notMeasured: tally.notMeasured } : {}),
  });
}

/** Measured pass rate — of what we decided, how much passed. */
export function measuredPassRate(tally: EvalStageTally): EvalStageRate {
  return stageRate(tally.passed, tally.measured, {
    ...tally.excluded,
    ...(tally.notMeasured > 0 ? { notMeasured: tally.notMeasured } : {}),
  });
}

/**
 * Reach rate — of the trials whose reach we could decide, how many got here.
 *
 * The denominator is `reached + notReached`. `reachUnknown` is NOT in it: a
 * trial we captured nothing for is not evidence of a drop-off, and putting it
 * in the denominator would make a run with broken instrumentation look like a
 * run with a broken server.
 */
export function reachRate(tally: EvalStageTally): EvalStageRate {
  return stageRate(tally.reached, tally.reached + tally.notReached, {
    ...tally.excluded,
    ...(tally.reachUnknown > 0 ? { reachUnknown: tally.reachUnknown } : {}),
  });
}

// ── compatibility ────────────────────────────────────────────────────────────
/**
 * Why two runs cannot be compared side by side.
 *
 * "Parity" is a claim, and it is only allowed when the two rows measured
 * comparable things. Rendering two funnels beside each other IS the claim, so
 * an incompatible pair must be drawn as separate observations rather than as a
 * comparison.
 */
export const EVAL_STAGE_PARITY_BLOCKERS = [
  "differentRunGroup",
  "differentAnalyzerVersion",
  "differentMeasurementsVersion",
  "differentMeasurementUnit",
  "provisional",
] as const;
export type EvalStageParityBlocker =
  (typeof EVAL_STAGE_PARITY_BLOCKERS)[number];

/**
 * Can these two rows be compared? Returns the blockers; empty means yes.
 *
 * `provisional` is a blocker rather than a caveat: a comparison against a row
 * that is still being rebuilt can invert between two page loads, and a reader
 * has no way to tell that happened.
 */
export function stageAnalyticsParityBlockers(
  a: Pick<
    EvalStageAnalyticsV1,
    | "runGroupId"
    | "stageAnalyzerVersion"
    | "measurementsSchemaVersion"
    | "measurementUnit"
    | "materializationState"
  >,
  b: typeof a
): EvalStageParityBlocker[] {
  const blockers: EvalStageParityBlocker[] = [];
  if (a.runGroupId !== b.runGroupId) blockers.push("differentRunGroup");
  if (a.stageAnalyzerVersion !== b.stageAnalyzerVersion) {
    blockers.push("differentAnalyzerVersion");
  }
  if (a.measurementsSchemaVersion !== b.measurementsSchemaVersion) {
    blockers.push("differentMeasurementsVersion");
  }
  if (a.measurementUnit !== b.measurementUnit) {
    blockers.push("differentMeasurementUnit");
  }
  if (
    a.materializationState === "provisional" ||
    b.materializationState === "provisional"
  ) {
    blockers.push("provisional");
  }
  return blockers;
}
