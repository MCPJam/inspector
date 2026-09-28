/**
 * The ONE grading policy: what must pass, how much, how many times, and what
 * counts as enough evidence to decide — read out of every contract that has
 * ever expressed those four things, in one shape.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * It is a READ MODEL plus two pure adapter families:
 *
 *   - normalization: {@link resolveGradingPolicyFromSuiteFile},
 *     {@link resolveGradingPolicyFromHostedSuite} and
 *     {@link resolveGradingPolicyFromRunReporting} project an existing input
 *     onto {@link ResolvedEvalGradingPolicy}.
 *   - write-back: {@link planEvalGradingPolicyEdit} turns an edit against that
 *     model into the PATCH `settings` shape the hosted API already accepts, or
 *     refuses the edit and names the operation that would express it.
 *
 * It is NOT an aggregator, and nothing here reads trials or produces a verdict.
 * The authoritative arithmetic is the backend producer
 * (`convex/lib/evalVerdictPolicy.ts`: `aggregateEvalCaseVerdict` /
 * `aggregateEvalRunVerdict`) and the legacy adapters it layers on top of; this
 * file describes the RULES those producers are handed, so that one vocabulary
 * can name them all. A second decision algorithm in a normalization module is
 * the exact failure this contract exists to prevent.
 *
 * It is also NOT serialized. Like `ResolvedEvalSuiteFile` in the loader, the resolved
 * policy is an in-memory view: the coverage rule is a union with no wire
 * spelling, and a suite-wide criterion keeps its ORIGINAL percent. Handing one
 * of these to a writer is always a bug — {@link planEvalGradingPolicyEdit} is
 * how an edit reaches the wire.
 *
 * ── Why one model needs a criterion SCOPE ───────────────────────────────────
 *
 * `minimumAccuracy` and `passThreshold` are not one number in two units. With
 * ten equally sized cases, nine always passing and one always failing:
 *
 *   - a 90% SUITE-WIDE threshold passes (9/10 of the population met the bar),
 *   - a 0.9 PER-CASE threshold fails (the tenth case passes 0/N of its own
 *     iterations, which is below 0.9).
 *
 * Dividing the percentage by 100 therefore does not preserve the policy; it
 * moves the bar for every suite that has more than one case. So the scope
 * travels WITH the threshold, in a discriminated union, and no accessor hands
 * out a bare number that a caller could compare against the wrong population.
 *
 * ── Why the suite-wide member carries a population and an empty-population
 * rate ──────────────────────────────────────────────────────────────────────
 *
 * There is no single legacy producer. Three shipped ones disagree, and they
 * disagree in ways that decide runs:
 *
 *   | producer                                            | population | empty |
 *   |-----------------------------------------------------|------------|-------|
 *   | backend `testSuites.ts` run finalization            | iterations | 1     |
 *   | backend `sdkEvals.computeEvalRunSummaryFromIterations` | cases   | 0     |
 *   | SDK `EvalRunReporter` local fallback                | iterations | 0     |
 *
 * The case-populated one buckets by
 * `iterationGroupKeyForSummary`, which does NOT key on the execution variant —
 * a fan-out run's provider/model rows collapse into one case bucket, and a case
 * fails when ANY of its iterations failed or timed out. The empty-population
 * rate is the difference between a zero-iteration run reporting `passed` and
 * the same run reporting `failed`. Flattening those three into "the legacy
 * percent policy" would silently re-decide runs in both directions, so the
 * model carries them and {@link EVAL_SUITE_WIDE_POPULATIONS} spells the
 * grouping rule out in the identifier itself.
 *
 * ── Two rules inherited from the contracts this reads ───────────────────────
 *
 *  1. **No `.default()` anywhere**, so an omitted declaration stays omitted and
 *     nothing round-trips through a value its author never wrote. Above all,
 *     validity: {@link EvalGradingValidity} distinguishes "not enforced at all"
 *     from "enforced with the documented defaults", because showing a legacy
 *     suite an active 80% completion floor it has never applied is a false
 *     statement about how its runs are decided.
 *  2. **Every object is `.strict()`**, matching the Convex `v.object` the
 *     backend mirror uses.
 */

import { z } from "zod";
import {
  MAX_REPETITIONS,
  MAX_SUITE_FILE_TITLE_CHARS,
  evalSuiteFileValiditySchema,
  type EvalSuiteFileValidity,
} from "./suite-file.js";
import {
  evalFractionSchema,
  resolvedEvalValidityPolicySchema,
  type EvalValidityCoverage,
  type ResolvedEvalValidityPolicy,
} from "./verdict-policy.js";

// ── the defaults the suite file documents ────────────────────────────────────
/**
 * The validity defaults the suite-file contract documents and deliberately does
 * not materialize. Applied onto the RESOLVED value, never onto the file.
 *
 * `minEligibleTrials` has no NUMBER here on purpose, because its default is not
 * a number: omitting it selects the coverage RULE in
 * {@link SUITE_FILE_DEFAULT_COVERAGE} — every configured trial attempted, and
 * at least one gradeable trial. Picking a numeric stand-in (`1`, say) is the
 * bug this shape exists to prevent: it would let a suite that graded a single
 * trial out of thirty report a confident pass.
 *
 * Defined here rather than in `../suite-file-loader.js` (which re-exports it
 * under its shipped name) so that the loader, the hosted adapter and the
 * backend mirror resolve validity from ONE table instead of three.
 */
export const SUITE_FILE_VALIDITY_DEFAULTS = {
  minCompletionRate: 0.8,
  maxEvaluatorErrorRate: 0.1,
} as const;

/**
 * The coverage rule an omitted `minEligibleTrials` resolves to.
 *
 * `minGradeableTrials: 1` carries the "at least one gradeable trial" half of
 * the rule in the value rather than in prose, so a consumer reading the
 * resolved suite does not have to know this comment exists.
 */
export const SUITE_FILE_DEFAULT_COVERAGE = {
  kind: "allConfiguredTrialsAttempted",
  minGradeableTrials: 1,
} as const satisfies EvalValidityCoverage;

/**
 * Resolve a DECLARED validity block into the policy a run is decided against.
 *
 * The one resolver. It mirrors the backend's `resolveEvalValidityPolicy`
 * exactly, including the rule that omission is STRICTER rather than weaker, and
 * `../suite-file-loader.js` resolves through it so the file path and the hosted
 * path cannot drift.
 */
export function resolveEvalGradingValidityPolicy(
  declared?: EvalSuiteFileValidity
): ResolvedEvalValidityPolicy {
  return {
    coverage:
      declared?.minEligibleTrials === undefined
        ? { ...SUITE_FILE_DEFAULT_COVERAGE }
        : {
            kind: "minEligibleTrials",
            minEligibleTrials: declared.minEligibleTrials,
          },
    minCompletionRate:
      declared?.minCompletionRate ??
      SUITE_FILE_VALIDITY_DEFAULTS.minCompletionRate,
    maxEvaluatorErrorRate:
      declared?.maxEvaluatorErrorRate ??
      SUITE_FILE_VALIDITY_DEFAULTS.maxEvaluatorErrorRate,
  };
}

// ── the pass criterion ───────────────────────────────────────────────────────
/**
 * The two populations a SUITE-WIDE threshold has ever been measured over.
 *
 *   - `iterations` — every iteration row in the run, passing over total. A
 *     `pending` or `cancelled` row is in the denominator, so it lowers the
 *     rate; this is not the v2 `eligibleTrials` population and must not be
 *     described as one.
 *   - `casesIgnoringExecutionVariant` — one pass/fail bucket per CASE, where a
 *     case fails if any of its iterations failed or timed out, a case with no
 *     terminal iteration is dropped from the population entirely, and the
 *     bucket key does NOT include the provider/model pair. The long name is the
 *     point: "cases" alone reads as one row per case per variant, which is what
 *     the v2 contract means by a case aggregate and is not what this counts.
 */
export const EVAL_SUITE_WIDE_POPULATIONS = [
  "iterations",
  "casesIgnoringExecutionVariant",
] as const;
export type EvalSuiteWidePopulation =
  (typeof EVAL_SUITE_WIDE_POPULATIONS)[number];

/**
 * The pass rate a producer reports for an EMPTY population.
 *
 * A literal union rather than a boolean, because it is the number the rate
 * takes and not a policy choice with a name: `1` is the hosted finalizer's
 * "vacuously passing", `0` is what the SDK ingestion and local-fallback
 * adapters produce. At threshold `0` both still pass, which is why this is
 * modelled as the rate rather than as a verdict.
 */
export const evalEmptyPopulationRateSchema = z.union([
  z.literal(0),
  z.literal(1),
]);
export type EvalEmptyPopulationRate = z.infer<
  typeof evalEmptyPopulationRateSchema
>;

/**
 * What must pass, and how much — with the scope that says what the number
 * means.
 *
 *   - `perCase` — each case-execution variant must meet `threshold`, a
 *     FRACTION, over its own eligible trials. Equality passes at every
 *     threshold including `0` and `1`.
 *   - `suiteWide` — one rate over the whole run must meet `thresholdPercent`, a
 *     PERCENT in its original units, over `population`.
 *
 * The percent is kept rather than normalized because the conversion is only
 * ever a boundary operation: a suite-wide policy's stored field IS a percent,
 * its historical runs were decided in percent, and a resolved model carrying
 * `0.9` beside a wire field holding `90` is one refactor away from writing the
 * wrong one back. {@link evalPassCriterionFraction} converts for display.
 */
export const evalPassCriterionSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("perCase"),
      /** Fraction of a case's eligible trials that must pass. Never a percent. */
      threshold: evalFractionSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal("suiteWide"),
      /** Suite-wide floor as a PERCENT in [0,100]. Never a fraction. */
      thresholdPercent: z.number().min(0).max(100),
      population: z.enum(EVAL_SUITE_WIDE_POPULATIONS),
      emptyPopulationRate: evalEmptyPopulationRateSchema,
    })
    .strict(),
]);
export type EvalPassCriterion = z.infer<typeof evalPassCriterionSchema>;
export type EvalPassCriterionScope = EvalPassCriterion["scope"];

/**
 * The criterion's threshold as a FRACTION, for display beside a scope label.
 *
 * The only sanctioned percent→fraction conversion on the read path, and it is
 * deliberately a function rather than a field: a caller that has this number
 * has had to ask for it, and the criterion it came from is still in hand to say
 * what population it applies to. Never compare it against a per-case pass rate
 * when the scope is `suiteWide`.
 *
 * The arithmetic is `percent / 100`, the SAME conversion `passRateFractionFromPercent`
 * performs at the gate boundary in `../gates.js` — and for the same reason it
 * gives there: `100` must map to `1` EXACTLY, because a float landing a hair
 * under would fail a fully-passing run. It is not imported from that module
 * because `contract/` sits below `src/`, so a test pins the two in agreement
 * instead. This is the read direction only; the write direction lives in
 * {@link planEvalGradingPolicyEdit}, where float noise has to be suppressed
 * before a number reaches the wire.
 */
export function evalPassCriterionFraction(
  criterion: EvalPassCriterion
): number {
  return criterion.scope === "perCase"
    ? criterion.threshold
    : criterion.thresholdPercent / 100;
}

// ── the iteration rule ───────────────────────────────────────────────────────
const iterationsSchema = z.number().int().min(1).max(MAX_REPETITIONS);

/**
 * The platform's clamp on the suite-level iteration FLOOR.
 *
 * `max(1, min(10, floor(value)))`, applied by `updateTestSuite`, by
 * `startTestSuiteRun` and by the credit estimator. Restated here so the
 * resolved model cannot describe a floor the platform would not apply.
 */
export const MAX_MINIMUM_ITERATIONS = 10;

/**
 * How many times each case runs.
 *
 *   - `defaultCount` — the canonical rule: a suite default that a case
 *     OVERRIDES. `iterations` is the default; a case's own count replaces it.
 *   - `caseCountWithFloor` — the legacy rule: the case's own count RAISED to a
 *     suite floor, `max(caseIterations, minimumIterations)`. `null` means no
 *     floor, which is the suite's real state and not a stand-in for `1`.
 *
 * The distinction is load-bearing and is the reason a count edit is not always
 * representable: under `caseCountWithFloor` there is no suite default count to
 * write, so "every case runs 5 times" cannot be expressed without either
 * editing every case or changing the rule. Relabelling the floor as a default
 * would silently lower the count of every case that configured more than it.
 *
 * A per-run iteration override wins outright under BOTH rules — see
 * {@link resolveEvalGradingIterations}.
 */
export const evalIterationRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("defaultCount"),
      iterations: iterationsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("caseCountWithFloor"),
      minimumIterations: z
        .number()
        .int()
        .min(1)
        .max(MAX_MINIMUM_ITERATIONS)
        .nullable(),
    })
    .strict(),
]);
export type EvalIterationRule = z.infer<typeof evalIterationRuleSchema>;

/**
 * How many iterations ONE case runs under a rule.
 *
 * The single resolver, and it reproduces both shipped producers exactly:
 *
 *   - `defaultCount`: `runOverride ?? caseIterations ?? rule.iterations` —
 *     `resolveEvalV2CaseSettings` plus `startTestSuiteRun`'s transient
 *     override.
 *   - `caseCountWithFloor`: `runOverride ?? max(caseIterations ?? 1, floor)` —
 *     `startTestSuiteRun`'s legacy branch and the credit estimator's copy of
 *     it, including the `1` a missing case count falls back to.
 *
 * `replay` reproduces the one asymmetry between them: a replay run re-executes
 * its source run's snapshotted counts, so the legacy FLOOR is not re-applied
 * (`!useSnapshotTests && …` in `startTestSuiteRun`). A per-run override still
 * wins on a replay. Under `defaultCount` a replay changes nothing, because the
 * run's expected trial identities were frozen into the verdict-policy snapshot
 * at run start.
 */
export function resolveEvalGradingIterations(
  rule: EvalIterationRule,
  args: {
    /** The case's own configured count, when it declared one. */
    caseIterations?: number;
    /** A per-run override, already the caller's clamped value. */
    runOverride?: number;
    /** True when re-executing a source run's snapshotted counts. */
    replay?: boolean;
  } = {}
): number {
  if (args.runOverride !== undefined) return args.runOverride;
  if (rule.kind === "defaultCount") {
    return args.caseIterations ?? rule.iterations;
  }
  const caseCount = Math.max(1, Math.floor(args.caseIterations ?? 1));
  if (args.replay === true) return caseCount;
  return Math.max(caseCount, rule.minimumIterations ?? 1);
}

// ── validity applicability ───────────────────────────────────────────────────
/**
 * Whether this policy decides validity BEFORE a task verdict, and with what.
 *
 * A union rather than an optional block, because "not enforced" and "enforced
 * with the documented defaults" are different answers to the customer question
 * and the second one is false about every legacy configuration. A suite graded
 * by a suite-wide percent has no validity phase at all: its runs cannot be
 * `inconclusive` on evidence grounds, and rendering an 80% completion floor
 * beside it would claim a check that has never run.
 *
 * `declared` is the AUTHORED block, so an omitted `minEligibleTrials` stays
 * omitted and round-trips; `resolved` is what a run is actually decided
 * against. Both are present because the difference between them is precisely
 * what the editor has to explain.
 */
export const evalGradingValiditySchema = z.discriminatedUnion("enforced", [
  z.object({ enforced: z.literal(false) }).strict(),
  z
    .object({
      enforced: z.literal(true),
      declared: evalSuiteFileValiditySchema,
      resolved: resolvedEvalValidityPolicySchema,
    })
    .strict(),
]);
export type EvalGradingValidity = z.infer<typeof evalGradingValiditySchema>;

// ── per-case overrides ───────────────────────────────────────────────────────
/**
 * One case's own settings, as the source contract spelled them.
 *
 * `caseRef` is whatever identifies the case in THAT contract — a hosted
 * `testCase` id, a suite-file case `id`, or the authored title a file used
 * instead. It is carried rather than resolved so an edit can be written back
 * against the same identity it was read under.
 *
 * `iterations` is the case's own configured count under both rules: the value
 * that REPLACES the default under `defaultCount`, and the value the floor is
 * applied to under `caseCountWithFloor`. Those are different rules over the
 * same authored number, which is why one field carries it and
 * {@link resolveEvalGradingIterations} decides what it means.
 */
export const evalGradingCaseOverrideSchema = z
  .object({
    caseRef: z.string().min(1).max(MAX_SUITE_FILE_TITLE_CHARS),
    iterations: iterationsSchema.optional(),
    passThreshold: evalFractionSchema.optional(),
  })
  .strict();
export type EvalGradingCaseOverride = z.infer<
  typeof evalGradingCaseOverrideSchema
>;

// ── boundary metadata ────────────────────────────────────────────────────────
/**
 * Which contract this policy was READ from — boundary metadata, and nothing a
 * customer picks.
 *
 * It exists for one reason: an edit has to be written back through the contract
 * it came from, and the write shapes differ. It is deliberately NOT a policy
 * version, not rendered as a product name, and not something an editor offers
 * as a choice; the customer-visible fact is the criterion SCOPE, which is a
 * property of the rules rather than of the storage that holds them.
 *
 *   - `suiteFile` — a portable suite file, either dialect. The dialect decides
 *     the spelling of the count field, not the policy, so one origin covers
 *     both; a writer emits the file's own dialect.
 *   - `hostedPerCase` — stored `verdictPolicyVersion: 2` with
 *     `verdictPolicyDefaults`.
 *   - `hostedSuiteWide` — stored `defaultPassCriteria.minimumPassRate` with
 *     `minIterations`. Writable through the PATCH `settings` fields.
 *   - `runReporting` — an SDK run's `passCriteria.minimumPassRate`, which
 *     describes ONE run rather than a suite and has no settings write path.
 */
export const EVAL_GRADING_POLICY_ORIGINS = [
  "suiteFile",
  "hostedPerCase",
  "hostedSuiteWide",
  "runReporting",
] as const;
export type EvalGradingPolicyOrigin =
  (typeof EVAL_GRADING_POLICY_ORIGINS)[number];

// ── the resolved policy ──────────────────────────────────────────────────────
/**
 * One grading policy, resolved.
 *
 * Every field is the rule a producer is handed, never a rendering of it. The
 * cross-field refusal below is the one rule that holds across the union: a
 * suite-wide criterion has no per-case threshold, because no producer reads one
 * and the hosted API refuses to store one (`assertCasePolicyFieldsSupported`
 * in `server/routes/v1/evals.ts`). Carrying it anyway would let an editor
 * display a bar that decides nothing.
 */
export const evalGradingPolicyStructuralSchema = z
  .object({
    passCriterion: evalPassCriterionSchema,
    iterationRule: evalIterationRuleSchema,
    validity: evalGradingValiditySchema,
    caseOverrides: z.array(evalGradingCaseOverrideSchema),
    origin: z.enum(EVAL_GRADING_POLICY_ORIGINS),
  })
  .strict();

export const evalGradingPolicySchema =
  evalGradingPolicyStructuralSchema.superRefine((policy, ctx) => {
    if (policy.passCriterion.scope !== "suiteWide") return;
    policy.caseOverrides.forEach((entry, index) => {
      if (entry.passThreshold === undefined) return;
      ctx.addIssue({
        code: "custom",
        path: ["caseOverrides", index, "passThreshold"],
        message:
          `case "${entry.caseRef}" carries a per-case passThreshold under a ` +
          `suite-wide criterion, where nothing reads it: the suite-wide rate ` +
          `is measured once over the whole run. Change the criterion scope to ` +
          `perCase, or drop the override.`,
      });
    });
  });
export type ResolvedEvalGradingPolicy = z.infer<
  typeof evalGradingPolicyStructuralSchema
>;

// ── normalization: suite file ────────────────────────────────────────────────
/**
 * The subset of a resolved suite file this reads.
 *
 * Structural rather than an import of `ResolvedEvalSuiteFile`, so the contract
 * layer stays free of the loader that sits above it — and so a caller holding
 * the AUTHORED file plus its resolved defaults can use this too.
 */
export type SuiteFileGradingInput = {
  defaults: {
    /** The configured count under its canonical name, whatever the dialect. */
    iterations: number;
    passThreshold: number;
    /** The AUTHORED validity block, so omissions stay omitted. */
    validity?: EvalSuiteFileValidity;
  };
  cases?: ReadonlyArray<{
    id?: string;
    title?: string;
    iterations?: number;
    passThreshold?: number;
  }>;
};

/**
 * A suite file's grading policy.
 *
 * Suite files are already canonical: `passThreshold` is a required FRACTION
 * applied per case, `iterations` is a default a case overrides, and `validity`
 * is a required block whose members are optional. So this adapter converts
 * nothing — it names what the file already says, which is the point of having
 * one model.
 */
export function resolveGradingPolicyFromSuiteFile(
  input: SuiteFileGradingInput
): ResolvedEvalGradingPolicy {
  return {
    passCriterion: {
      scope: "perCase",
      threshold: input.defaults.passThreshold,
    },
    iterationRule: {
      kind: "defaultCount",
      iterations: input.defaults.iterations,
    },
    validity: {
      enforced: true,
      declared: { ...(input.defaults.validity ?? {}) },
      resolved: resolveEvalGradingValidityPolicy(input.defaults.validity),
    },
    caseOverrides: (input.cases ?? []).flatMap((entry) => {
      if (entry.iterations === undefined && entry.passThreshold === undefined) {
        return [];
      }
      const caseRef = entry.id ?? entry.title;
      if (caseRef === undefined) return [];
      return [
        {
          caseRef,
          ...(entry.iterations !== undefined
            ? { iterations: entry.iterations }
            : {}),
          ...(entry.passThreshold !== undefined
            ? { passThreshold: entry.passThreshold }
            : {}),
        },
      ];
    }),
    origin: "suiteFile",
  };
}

// ── normalization: hosted suite ──────────────────────────────────────────────
/**
 * The stored hosted-suite fields this reads, spelled exactly as storage spells
 * them.
 *
 * Deliberately the STORAGE names (`minIterations`, `defaultPassCriteria`,
 * `verdictPolicyDefaults`) rather than the public DTO's (`minimumIterations`,
 * `minimumAccuracy`), because those two disagree in one load-bearing way: the
 * DTO reports `minimumAccuracy: null` on a per-case suite whatever the column
 * holds. Reading the DTO would therefore lose nothing on a per-case suite and
 * everything on a suite-wide one; reading storage keeps the adapter honest and
 * lets the DTO stay the projection it is. {@link hostedGradingStorageFromDto}
 * converts a public read back into this shape for callers that only have one.
 */
export type HostedSuiteGradingStorage = {
  verdictPolicyVersion?: number;
  verdictPolicyDefaults?: {
    repetitions: number;
    passThreshold: number;
    validity?: EvalSuiteFileValidity;
  };
  defaultPassCriteria?: { minimumPassRate: number } | null;
  minIterations?: number | null;
  cases?: ReadonlyArray<{
    id?: string;
    title?: string;
    /** The legacy per-case count. */
    runs?: number;
    /** The per-case count under the per-case policy. */
    repetitions?: number;
    passThreshold?: number;
  }>;
};

/**
 * The suite-wide threshold a run falls back to when the suite declared none.
 *
 * `100` — every legacy producer spells it `run.passCriteria?.minimumPassRate ??
 * 100`, which is "every unit must pass". It is a PRODUCER fallback and not a
 * stored value, so a suite with no `defaultPassCriteria` resolves to it here
 * and still writes nothing back until somebody edits the threshold.
 */
export const LEGACY_SUITE_WIDE_THRESHOLD_PERCENT = 100;

/**
 * A hosted suite's grading policy, from its stored fields.
 *
 * The version is read LITERALLY: absence is the suite-wide policy, never a
 * defaulted per-case one. A suite marked per-case whose defaults are missing is
 * an integrity error rather than a suite-wide suite — the backend refuses to
 * even estimate such a run (`EVAL_VERDICT_POLICY_INCOMPLETE`) — so this throws
 * rather than downgrading it, which would re-decide the suite under semantics
 * it never opted into.
 *
 * `population` is `iterations` with an empty-population rate of `1`: that is the
 * hosted run finalizer in `convex/testSuites.ts`, which is what decides a
 * hosted suite's runs. A run INGESTED from the SDK is decided by a different
 * adapter — see {@link resolveGradingPolicyFromRunReporting}.
 */
export function resolveGradingPolicyFromHostedSuite(
  suite: HostedSuiteGradingStorage
): ResolvedEvalGradingPolicy {
  const perCase = suite.verdictPolicyVersion === 2;
  const defaults = suite.verdictPolicyDefaults;
  if (perCase && defaults === undefined) {
    throw new TypeError(
      "This suite is marked verdict policy 2 but carries no v2 defaults " +
        "(repetitions, passThreshold), so its grading policy cannot be read. " +
        "It must not be read as the suite-wide policy: that would decide its " +
        "runs under semantics it never opted into."
    );
  }
  const cases = suite.cases ?? [];
  if (defaults !== undefined && perCase) {
    return {
      passCriterion: { scope: "perCase", threshold: defaults.passThreshold },
      iterationRule: {
        kind: "defaultCount",
        iterations: defaults.repetitions,
      },
      validity: {
        enforced: true,
        declared: { ...(defaults.validity ?? {}) },
        resolved: resolveEvalGradingValidityPolicy(defaults.validity),
      },
      caseOverrides: cases.flatMap((entry) => {
        if (
          entry.repetitions === undefined &&
          entry.passThreshold === undefined
        ) {
          return [];
        }
        const caseRef = entry.id ?? entry.title;
        if (caseRef === undefined) return [];
        return [
          {
            caseRef,
            ...(entry.repetitions !== undefined
              ? { iterations: entry.repetitions }
              : {}),
            ...(entry.passThreshold !== undefined
              ? { passThreshold: entry.passThreshold }
              : {}),
          },
        ];
      }),
      origin: "hostedPerCase",
    };
  }
  return {
    passCriterion: {
      scope: "suiteWide",
      thresholdPercent:
        typeof suite.defaultPassCriteria?.minimumPassRate === "number"
          ? suite.defaultPassCriteria.minimumPassRate
          : LEGACY_SUITE_WIDE_THRESHOLD_PERCENT,
      population: "iterations",
      emptyPopulationRate: 1,
    },
    iterationRule: {
      kind: "caseCountWithFloor",
      minimumIterations:
        typeof suite.minIterations === "number"
          ? clampMinimumIterations(suite.minIterations)
          : null,
    },
    // A suite-wide suite has NO validity phase. Its runs are `passed` or
    // `failed` and never `inconclusive` on evidence grounds, so declaring the
    // documented defaults here would describe checks that have never run.
    validity: { enforced: false },
    caseOverrides: cases.flatMap((entry) => {
      if (entry.runs === undefined) return [];
      const caseRef = entry.id ?? entry.title;
      if (caseRef === undefined) return [];
      return [{ caseRef, iterations: entry.runs }];
    }),
    origin: "hostedSuiteWide",
  };
}

/** The platform's `max(1, min(10, floor(value)))` clamp on the floor. */
function clampMinimumIterations(value: number): number {
  return Math.max(1, Math.min(MAX_MINIMUM_ITERATIONS, Math.floor(value)));
}

/**
 * Project the PUBLIC suite-settings read back onto the storage shape.
 *
 * For callers that hold a `GET` response rather than a document — the CLI, the
 * MCP operations, the settings sheet. It is lossless for what the policy needs
 * because the DTO's one lossy field is lossy in the safe direction: it reports
 * `minimumAccuracy: null` on a per-case suite, where the percent decides
 * nothing anyway, and the per-case fields carry the live policy.
 *
 * ONE CAVEAT, and it belongs to the CALLER. An API deployment that predates the
 * per-case policy omits `verdictPolicyVersion` on every suite, per-case ones
 * included, so a response from such a deployment cannot distinguish a
 * suite-wide suite from a per-case one and this function will report the
 * former. That is a CAPABILITY question, not a policy one: the caller has to
 * establish that the deployment reports the field (the DTO's own `policy` word
 * is what it added for this) before trusting a resolved policy built from a
 * response. Resolving it here would mean inventing a capability probe inside a
 * pure adapter, and guessing per-case would be worse still — it would read a
 * historical percent as a fraction.
 */
export function hostedGradingStorageFromDto(settings: {
  minimumAccuracy?: number | null;
  minimumIterations?: number | null;
  verdictPolicyVersion?: number;
  verdictPolicyDefaults?: {
    repetitions: number;
    passThreshold: number;
    validity?: EvalSuiteFileValidity;
  };
}): HostedSuiteGradingStorage {
  return {
    ...(settings.verdictPolicyVersion !== undefined
      ? { verdictPolicyVersion: settings.verdictPolicyVersion }
      : {}),
    ...(settings.verdictPolicyDefaults !== undefined
      ? { verdictPolicyDefaults: settings.verdictPolicyDefaults }
      : {}),
    ...(typeof settings.minimumAccuracy === "number"
      ? { defaultPassCriteria: { minimumPassRate: settings.minimumAccuracy } }
      : {}),
    ...(settings.minimumIterations !== undefined
      ? { minIterations: settings.minimumIterations }
      : {}),
  };
}

// ── normalization: an SDK-reported run ───────────────────────────────────────
/**
 * Which producer decides a run reported through the SDK.
 *
 *   - `hosted` — `convex/sdkEvals.ts` finalization, which buckets by CASE and
 *     reports `0` for an empty population.
 *   - `localFallback` — `EvalRunReporter`'s own summary, used when the run
 *     could not be reported. It counts the results it was HANDED, one per
 *     iteration, and also reports `0` for an empty population.
 *
 * Two members rather than one because the denominators differ: a suite of three
 * cases run five times each is 3 units to the first and 15 to the second, and
 * the same `minimumPassRate` therefore decides differently.
 */
export const EVAL_RUN_REPORTING_PRODUCERS = [
  "hosted",
  "localFallback",
] as const;
export type EvalRunReportingProducer =
  (typeof EVAL_RUN_REPORTING_PRODUCERS)[number];

/**
 * The grading policy ONE SDK-reported run was decided under.
 *
 * A run-scoped policy, not a suite's: `passCriteria` travels on the run, has no
 * settings write path, and carries no iteration rule of its own — the counts
 * were decided by whatever produced the results. `iterationRule` therefore
 * reports the legacy shape with no floor, which is what "the case ran the
 * number of times it ran" means in this contract, and
 * {@link planEvalGradingPolicyEdit} refuses every edit against it.
 */
export function resolveGradingPolicyFromRunReporting(args: {
  minimumPassRate?: number;
  producer: EvalRunReportingProducer;
}): ResolvedEvalGradingPolicy {
  return {
    passCriterion: {
      scope: "suiteWide",
      thresholdPercent:
        args.minimumPassRate ?? LEGACY_SUITE_WIDE_THRESHOLD_PERCENT,
      population:
        args.producer === "hosted"
          ? "casesIgnoringExecutionVariant"
          : "iterations",
      emptyPopulationRate: 0,
    },
    iterationRule: { kind: "caseCountWithFloor", minimumIterations: null },
    validity: { enforced: false },
    caseOverrides: [],
    origin: "runReporting",
  };
}

// ── write-back ───────────────────────────────────────────────────────────────
/**
 * An edit against the canonical model, in canonical units.
 *
 * `passThreshold` is ALWAYS a fraction here, and the adapter converts it to the
 * units the stored contract speaks. That conversion is safe precisely because
 * the SCOPE is preserved: 0.9 written onto a suite-wide criterion becomes the
 * percent 90 measuring the same population it measured before. The unsafe
 * conversion — the one this whole contract exists to prevent — is the one that
 * changes what the number is measured over, and it is not an edit at all. It is
 * a scope change, which no field here can express.
 *
 * Every member is optional and an omitted member is "leave alone", matching the
 * PATCH body this produces.
 */
export type EvalGradingPolicyEdit = {
  /** New pass threshold, as a FRACTION in [0,1], in the current scope. */
  passThreshold?: number;
  /** New default iteration count. Only representable under `defaultCount`. */
  iterations?: number;
  /** New suite iteration floor; `null` clears it. Only under `caseCountWithFloor`. */
  minimumIterations?: number | null;
  /** Declared validity changes, merged by the route over what is stored. */
  validity?: EvalSuiteFileValidity;
};

/** The PATCH `settings` keys this adapter is allowed to write. */
export type EvalGradingPolicySettingsPatch = {
  minimumAccuracy?: number;
  minimumIterations?: number | null;
  repetitions?: number;
  passThreshold?: number;
  validity?: EvalSuiteFileValidity;
};

/**
 * Why an edit was refused.
 *
 *   - `iterationsNotRepresentable` — a default-count edit against a floor rule.
 *   - `minimumIterationsNotRepresentable` — a floor edit against a default-count
 *     rule.
 *   - `validityNotEnforced` — a validity edit against a policy with no validity
 *     phase. Turning the phase on changes what the run's verdict can BE
 *     (`inconclusive` becomes reachable), so it is a reviewed behaviour change
 *     and not a settings edit.
 *   - `readOnlyPolicy` — a run-scoped policy, which has no settings to write.
 *
 * There is deliberately no code for "convert the scope": nothing here can do
 * it, and an error code naming it would read as a supported operation.
 */
export const EVAL_GRADING_POLICY_REFUSALS = [
  "iterationsNotRepresentable",
  "minimumIterationsNotRepresentable",
  "validityNotEnforced",
  "readOnlyPolicy",
] as const;
export type EvalGradingPolicyRefusal =
  (typeof EVAL_GRADING_POLICY_REFUSALS)[number];

export type EvalGradingPolicyWritePlan =
  | {
      ok: true;
      /**
       * The PATCH `settings` sub-object. EMPTY when the edit changed nothing —
       * which is what keeps a read-edit-write of unchanged settings from
       * rotating a suite's `configRevision`.
       */
      settings: EvalGradingPolicySettingsPatch;
      /** The canonical fields this plan actually changes, in a stable order. */
      changed: readonly (keyof EvalGradingPolicyEdit)[];
    }
  | {
      ok: false;
      refusal: EvalGradingPolicyRefusal;
      message: string;
    };

/**
 * `fraction × 100` without the float noise.
 *
 * `0.07 * 100` is `7.000000000000001` in IEEE-754, and writing that as a
 * percent makes a suite whose threshold "did not change" fail its next revision
 * comparison — and renders as `7.000000000000001%`. Ten decimal places of
 * percent is far past anything a threshold means, so rounding there is lossless
 * for every real value and exact for every one a human typed.
 */
function percentFromFraction(fraction: number): number {
  return Math.round(fraction * 1e12) / 1e10;
}

/**
 * Turn an edit against a resolved policy into the write the hosted API already
 * accepts — or refuse it and name the operation that would express it.
 *
 * THREE properties this is built for, in order of how badly their absence bites:
 *
 *  1. **The scope survives.** A threshold edit writes `minimumAccuracy` on a
 *     suite-wide policy and `passThreshold` on a per-case one. It never writes
 *     the pair `repetitions` + `passThreshold` onto a suite-wide suite, which is
 *     the request the route reads as an upgrade
 *     (`applyVerdictPolicySettings`) — so a count edit and a threshold edit in
 *     one PATCH can never migrate a suite as a side effect.
 *  2. **An unchanged edit writes nothing.** Every field is compared against the
 *     resolved policy first, and an edit that restates what is already stored
 *     produces `{}`. Suite `configRevision` is a digest over the stored policy
 *     objects, so a normalize-and-write round trip that "changed nothing" but
 *     re-sent them would rotate every suite's revision and invalidate its
 *     parity comparisons.
 *  3. **A refusal never degrades into a partial write.** An edit this cannot
 *     represent is refused whole. Dropping the unrepresentable field and
 *     writing the rest is how a caller ends up believing it set an iteration
 *     count it did not set.
 */
export function planEvalGradingPolicyEdit(
  policy: ResolvedEvalGradingPolicy,
  edit: EvalGradingPolicyEdit
): EvalGradingPolicyWritePlan {
  if (policy.origin === "runReporting") {
    return {
      ok: false,
      refusal: "readOnlyPolicy",
      message:
        "This policy describes one reported run, not a suite: its threshold " +
        "travelled with the run and there is nothing to edit. Edit the suite " +
        "the run was reported against.",
    };
  }

  assertPlannableEdit(edit);

  const settings: EvalGradingPolicySettingsPatch = {};
  const changed: (keyof EvalGradingPolicyEdit)[] = [];

  if (edit.iterations !== undefined) {
    if (policy.iterationRule.kind !== "defaultCount") {
      return {
        ok: false,
        refusal: "iterationsNotRepresentable",
        message:
          "This suite has no default iteration count: each case runs its own " +
          "number of times, raised to the suite minimum. Set the minimum with " +
          "settings.minimumIterations, or edit the cases. Writing this count " +
          "as the minimum would lower every case that configured more.",
      };
    }
    if (edit.iterations !== policy.iterationRule.iterations) {
      settings.repetitions = edit.iterations;
      changed.push("iterations");
    }
  }

  if (edit.minimumIterations !== undefined) {
    if (policy.iterationRule.kind !== "caseCountWithFloor") {
      return {
        ok: false,
        refusal: "minimumIterationsNotRepresentable",
        message:
          "This suite has no iteration minimum: it has a default count each " +
          "case may override. Set the default with settings.repetitions.",
      };
    }
    // No clamp here: `assertPlannableEdit` has already refused anything outside
    // the platform's range, so the value compared IS the value written. The
    // READ side still clamps, because storage can hold a floor written before
    // the route bounded the field.
    if (edit.minimumIterations !== policy.iterationRule.minimumIterations) {
      settings.minimumIterations = edit.minimumIterations;
      changed.push("minimumIterations");
    }
  }

  if (edit.passThreshold !== undefined) {
    if (policy.passCriterion.scope === "perCase") {
      if (edit.passThreshold !== policy.passCriterion.threshold) {
        settings.passThreshold = edit.passThreshold;
        changed.push("passThreshold");
      }
    } else {
      const percent = percentFromFraction(edit.passThreshold);
      if (percent !== policy.passCriterion.thresholdPercent) {
        settings.minimumAccuracy = percent;
        changed.push("passThreshold");
      }
    }
  }

  if (edit.validity !== undefined) {
    if (!policy.validity.enforced) {
      return {
        ok: false,
        refusal: "validityNotEnforced",
        message:
          "This suite does not require evidence before deciding: its runs are " +
          "passed or failed and never inconclusive. Turning that on changes " +
          "what a run can conclude, so it is a reviewed change to the grading " +
          "policy rather than a settings edit.",
      };
    }
    const merged = { ...policy.validity.declared, ...edit.validity };
    if (!sameDeclaredValidity(merged, policy.validity.declared)) {
      settings.validity = edit.validity;
      changed.push("validity");
    }
  }

  return { ok: true, settings, changed };
}

/**
 * The edit, as a schema — the same bounds the PATCH route enforces.
 *
 * `EvalGradingPolicyEdit` is a TypeScript type and TypeScript is not present at
 * runtime, so a JavaScript caller (or a value parsed out of JSON, a CLI flag, an
 * MCP argument) can hand this function anything. Without a bound, a
 * `passThreshold` of `90` — a percent where a fraction belongs — plans
 * `minimumAccuracy: 9000` on a suite-wide policy and reports `ok: true`, and a
 * `minimumIterations` of `42` plans a floor the route refuses. Both are exactly
 * the "successful plan the API then rejects" this module exists to prevent.
 *
 * The numbers are the route's own (`updateSuiteSchema` in
 * `server/routes/v1/evals.ts`), not new product limits: `minimumAccuracy` is a
 * percent the caller never types (the adapter converts), so the bound is on the
 * FRACTION the caller does type.
 */
const evalGradingPolicyEditSchema = z
  .object({
    passThreshold: evalFractionSchema.optional(),
    iterations: z.number().int().min(1).max(MAX_REPETITIONS).optional(),
    minimumIterations: z
      .union([z.number().int().min(1).max(MAX_MINIMUM_ITERATIONS), z.null()])
      .optional(),
    validity: evalSuiteFileValiditySchema.optional(),
  })
  .strict();

/**
 * Refuse a malformed edit before any field is planned.
 *
 * A THROW rather than an `ok: false` result, and the distinction is deliberate:
 * {@link EvalGradingPolicyRefusal} means "this policy cannot express that
 * operation", which is a legitimate answer a caller renders to a user. An
 * out-of-range number is not an operation this policy cannot express — it is a
 * malformed input, and it gets the same treatment
 * {@link resolveGradingPolicyFromHostedSuite} gives malformed storage.
 */
function assertPlannableEdit(edit: EvalGradingPolicyEdit): void {
  const parsed = evalGradingPolicyEditSchema.safeParse(edit);
  if (parsed.success) return;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
    .concat(
      `. passThreshold is a FRACTION in [0,1] — a suite-wide percent is ` +
        `converted by this adapter and never passed in.`
    );
  throw new TypeError(`This grading-policy edit cannot be written. ${issues}`);
}

/**
 * Whether two DECLARED validity blocks say the same thing.
 *
 * Key-by-key over the closed vocabulary, with omission distinct from every
 * number — an omitted `minEligibleTrials` selects a different coverage RULE
 * than any explicit value, so `{} ` and `{ minEligibleTrials: 1 }` are not
 * equal and comparing resolved policies instead would report that they are.
 */
function sameDeclaredValidity(
  left: EvalSuiteFileValidity,
  right: EvalSuiteFileValidity
): boolean {
  const keys = [
    "minEligibleTrials",
    "minCompletionRate",
    "maxEvaluatorErrorRate",
  ] as const;
  return keys.every((key) => left[key] === right[key]);
}
