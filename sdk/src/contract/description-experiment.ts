/**
 * The canonical **eval description-experiment report** — one versioned
 * shape that says whether rewriting a tool's description changed
 * selection outcomes, without deciding a verdict.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Description TEXT is the lever (arXiv 2602.20426). Embeddings navigate
 * evidence; they never measure reliability. This report compares two
 * replayed arms of the same source run — ORIGINAL catalog vs a rewritten
 * description — and states a Newcombe interval over the trial population.
 *
 * ── It REPORTS; it never DECIDES ─────────────────────────────────────────────
 *
 * `reportOnly` is a literal `true`. Nothing here writes `result`, feeds a
 * gate, or changes a verdict. A missing document is UNMEASURED, never zero.
 *
 * ── Counting rules ───────────────────────────────────────────────────────────
 *
 *   - Population is the trial. Eligible = terminal, graded, not a negative
 *     test, and (on the rewrite arm) the override was actually applied.
 *   - Passed iff `result === "passed"`. A completed trial with no result
 *     is a failed observation, not an exclusion.
 *   - Interval is Newcombe hybrid-score for `pRewrite − pOriginal`, in
 *     **points** (fraction × 100). `null` when either arm is below the
 *     minimum sample. The bound that matters is the lower when delta > 0
 *     and the upper when delta < 0.
 *   - Regression is `noDeterministicRegressions` over non-affected cases:
 *     a case that passed on original and failed on rewrite is a flip.
 *     Any flip ⇒ `failed`. Unchecked ⇒ `non_gateable`.
 *   - `controlled` only when every eligible trial had a per-trial sandbox
 *     reset AND assignment overlap was verified; otherwise `reproducible`.
 *   - Deterministic: per-case rows sorted by `aggregationKey`, exclusion
 *     keys omitted when zero, no clock reads.
 *
 * ── No `.default()`, every object `.strict()` ────────────────────────────────
 *
 * Same discipline as `./verdict-policy.ts` and `./route-facts.ts`: an
 * omitted field stays omitted so the payload is byte-stable, and an unknown
 * field is an error rather than a silent passenger.
 */

import { z } from "zod";
import {
  DEFAULT_MIN_SAMPLE_SIZE,
  newcombeDifferenceInterval,
} from "../compare-stats.js";
import { EVAL_RUN_MEASUREMENT_UNITS } from "./decision-summary.js";

/**
 * The contract version, as a literal.
 *
 * `1` because this shape has no predecessor on the wire.
 */
export const DESCRIPTION_EXPERIMENT_SCHEMA_VERSION = 1;
export type DescriptionExperimentSchemaVersion =
  typeof DESCRIPTION_EXPERIMENT_SCHEMA_VERSION;

/** The `$id` of the published JSON Schema for this contract. */
export const DESCRIPTION_EXPERIMENT_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-description-experiment/v1.json";

const countSchema = z.number().int().min(0);

// ── closed vocabularies ──────────────────────────────────────────────────────

export const DESCRIPTION_EXPERIMENT_ARMS = ["original", "rewrite"] as const;
export type DescriptionExperimentArm =
  (typeof DESCRIPTION_EXPERIMENT_ARMS)[number];
export const descriptionExperimentArmSchema = z.enum(
  DESCRIPTION_EXPERIMENT_ARMS
);
export function isDescriptionExperimentArm(
  value: unknown
): value is DescriptionExperimentArm {
  return (
    typeof value === "string" &&
    (DESCRIPTION_EXPERIMENT_ARMS as readonly string[]).includes(value)
  );
}

export const DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS = [
  "notTerminal",
  "errored",
  "timedOut",
  "negativeTest",
  "overrideNotApplied",
  "unsupportedEngine",
] as const;
export type DescriptionExperimentExclusionReason =
  (typeof DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS)[number];
export const descriptionExperimentExclusionReasonSchema = z.enum(
  DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS
);
export function isDescriptionExperimentExclusionReason(
  value: unknown
): value is DescriptionExperimentExclusionReason {
  return (
    typeof value === "string" &&
    (DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS as readonly string[]).includes(
      value
    )
  );
}

export const DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS = [
  "controlled",
  "reproducible",
] as const;
export type DescriptionExperimentEvidenceLabel =
  (typeof DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS)[number];
export const descriptionExperimentEvidenceLabelSchema = z.enum(
  DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS
);
export function isDescriptionExperimentEvidenceLabel(
  value: unknown
): value is DescriptionExperimentEvidenceLabel {
  return (
    typeof value === "string" &&
    (DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS as readonly string[]).includes(
      value
    )
  );
}

export const DESCRIPTION_EXPERIMENT_OUTCOME_SOURCES = [
  "deterministic",
  "judge_gated",
] as const;
export type DescriptionExperimentOutcomeSource =
  (typeof DESCRIPTION_EXPERIMENT_OUTCOME_SOURCES)[number];
export const descriptionExperimentOutcomeSourceSchema = z.enum(
  DESCRIPTION_EXPERIMENT_OUTCOME_SOURCES
);

export const DESCRIPTION_EXPERIMENT_VERDICTS = [
  "improved",
  "regressed",
  "no_difference",
  "insufficient_data",
] as const;
export type DescriptionExperimentVerdict =
  (typeof DESCRIPTION_EXPERIMENT_VERDICTS)[number];
export const descriptionExperimentVerdictSchema = z.enum(
  DESCRIPTION_EXPERIMENT_VERDICTS
);

export const DESCRIPTION_EXPERIMENT_REGRESSION_STATUSES = [
  "passed",
  "failed",
  "non_gateable",
] as const;
export type DescriptionExperimentRegressionStatus =
  (typeof DESCRIPTION_EXPERIMENT_REGRESSION_STATUSES)[number];
export const descriptionExperimentRegressionStatusSchema = z.enum(
  DESCRIPTION_EXPERIMENT_REGRESSION_STATUSES
);

export const DESCRIPTION_EXPERIMENT_ENVIRONMENT_RESETS = [
  "per_trial_sandbox",
  "none",
] as const;
export type DescriptionExperimentEnvironmentReset =
  (typeof DESCRIPTION_EXPERIMENT_ENVIRONMENT_RESETS)[number];
export const descriptionExperimentEnvironmentResetSchema = z.enum(
  DESCRIPTION_EXPERIMENT_ENVIRONMENT_RESETS
);

export const DESCRIPTION_EXPERIMENT_ASSIGNMENT_METHODS = [
  "concurrent_two_run",
] as const;
export type DescriptionExperimentAssignmentMethod =
  (typeof DESCRIPTION_EXPERIMENT_ASSIGNMENT_METHODS)[number];
export const descriptionExperimentAssignmentMethodSchema = z.enum(
  DESCRIPTION_EXPERIMENT_ASSIGNMENT_METHODS
);

// ── nested shapes ────────────────────────────────────────────────────────────

export const descriptionExperimentExclusionsSchema = z
  .object({
    notTerminal: countSchema.optional(),
    errored: countSchema.optional(),
    timedOut: countSchema.optional(),
    negativeTest: countSchema.optional(),
    overrideNotApplied: countSchema.optional(),
    unsupportedEngine: countSchema.optional(),
  })
  .strict();
export type DescriptionExperimentExclusions = z.infer<
  typeof descriptionExperimentExclusionsSchema
>;

export const descriptionExperimentArmSampleSchema = z
  .object({
    eligible: countSchema,
    passed: countSchema,
    failed: countSchema,
    exclusions: descriptionExperimentExclusionsSchema,
  })
  .strict();
export type DescriptionExperimentArmSample = z.infer<
  typeof descriptionExperimentArmSampleSchema
>;

export const descriptionExperimentIntervalSchema = z
  .object({
    deltaPoints: z.number(),
    lowerPoints: z.number(),
    upperPoints: z.number(),
  })
  .strict();
export type DescriptionExperimentInterval = z.infer<
  typeof descriptionExperimentIntervalSchema
>;

const comparisonBlockSchema = z
  .object({
    original: descriptionExperimentArmSampleSchema,
    rewrite: descriptionExperimentArmSampleSchema,
    interval: descriptionExperimentIntervalSchema.nullable(),
    verdict: descriptionExperimentVerdictSchema,
    minSampleSize: z.number().int().min(1),
  })
  .strict();

export const descriptionExperimentPerCaseSchema = comparisonBlockSchema
  .extend({
    aggregationKey: z.string().min(1),
  })
  .strict();
export type DescriptionExperimentPerCase = z.infer<
  typeof descriptionExperimentPerCaseSchema
>;

export const descriptionExperimentPooledSchema = comparisonBlockSchema;
export type DescriptionExperimentPooled = z.infer<
  typeof descriptionExperimentPooledSchema
>;

export const descriptionExperimentSecondarySchema = z
  .object({
    expectedToolNotCalled: z
      .object({
        original: countSchema,
        rewrite: countSchema,
      })
      .strict(),
    substitutions: z
      .array(
        z
          .object({
            expected: z.string().min(1),
            observed: z.string().min(1),
            original: countSchema,
            rewrite: countSchema,
          })
          .strict()
      )
      .optional(),
  })
  .strict();
export type DescriptionExperimentSecondary = z.infer<
  typeof descriptionExperimentSecondarySchema
>;

export const descriptionExperimentRegressionSchema = z
  .object({
    checked: z.boolean(),
    otherCases: countSchema,
    regressed: z.array(z.string().min(1)),
    status: descriptionExperimentRegressionStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export type DescriptionExperimentRegression = z.infer<
  typeof descriptionExperimentRegressionSchema
>;

export const descriptionExperimentFrozenSchema = z
  .object({
    model: z.array(z.string().min(1)),
    engine: z.string().min(1),
    hostConfigId: z.string().min(1).optional(),
    toolSnapshotHash: z.string().min(1).optional(),
    judgeConfigHash: z.string().min(1).optional(),
    environmentReset: descriptionExperimentEnvironmentResetSchema,
  })
  .strict();
export type DescriptionExperimentFrozen = z.infer<
  typeof descriptionExperimentFrozenSchema
>;

export const descriptionExperimentAssignmentSchema = z
  .object({
    method: descriptionExperimentAssignmentMethodSchema,
    overlapVerified: z.boolean(),
  })
  .strict();
export type DescriptionExperimentAssignment = z.infer<
  typeof descriptionExperimentAssignmentSchema
>;

export const descriptionExperimentReportStructuralSchema = z
  .object({
    schemaVersion: z.literal(DESCRIPTION_EXPERIMENT_SCHEMA_VERSION),
    toolName: z.string().min(1),
    population: z.literal(EVAL_RUN_MEASUREMENT_UNITS[1]),
    primary: z
      .object({
        outcomeSource: descriptionExperimentOutcomeSourceSchema,
        pooled: descriptionExperimentPooledSchema,
        perCase: z.array(descriptionExperimentPerCaseSchema),
      })
      .strict(),
    secondary: descriptionExperimentSecondarySchema,
    regression: descriptionExperimentRegressionSchema,
    frozen: descriptionExperimentFrozenSchema,
    assignment: descriptionExperimentAssignmentSchema,
    evidenceLabel: descriptionExperimentEvidenceLabelSchema,
    reportOnly: z.literal(true),
  })
  .strict();

function addArmSampleIssues(
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  sample: DescriptionExperimentArmSample
): void {
  if (sample.passed + sample.failed !== sample.eligible) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "eligible"],
      message:
        `eligible ${sample.eligible} is not passed ${sample.passed} + ` +
        `failed ${sample.failed}`,
    });
  }
}

export const descriptionExperimentReportSchema =
  descriptionExperimentReportStructuralSchema.superRefine((row, ctx) => {
    addArmSampleIssues(ctx, ["primary", "pooled", "original"], row.primary.pooled.original);
    addArmSampleIssues(ctx, ["primary", "pooled", "rewrite"], row.primary.pooled.rewrite);
    for (const [index, perCase] of row.primary.perCase.entries()) {
      addArmSampleIssues(
        ctx,
        ["primary", "perCase", index, "original"],
        perCase.original
      );
      addArmSampleIssues(
        ctx,
        ["primary", "perCase", index, "rewrite"],
        perCase.rewrite
      );
    }
    const belowMinimum =
      row.primary.pooled.original.eligible < row.primary.pooled.minSampleSize ||
      row.primary.pooled.rewrite.eligible < row.primary.pooled.minSampleSize;
    if (belowMinimum && row.primary.pooled.interval !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["primary", "pooled", "interval"],
        message:
          "interval must be null when either arm is below minSampleSize",
      });
    }
    if (belowMinimum && row.primary.pooled.verdict !== "insufficient_data") {
      ctx.addIssue({
        code: "custom",
        path: ["primary", "pooled", "verdict"],
        message:
          "verdict must be insufficient_data when either arm is below minSampleSize",
      });
    }
  });

export type DescriptionExperimentReport = z.infer<
  typeof descriptionExperimentReportStructuralSchema
>;

// ── inputs ───────────────────────────────────────────────────────────────────

export type DescriptionExperimentTrialInput = {
  trialKey: string;
  aggregationKey: string;
  status: string;
  result?: string;
  isNegativeTest?: boolean;
  evaluatorErrored?: boolean;
  engineSupported?: boolean;
  actualToolCalls?: readonly unknown[];
  expectedToolCalls?: readonly unknown[];
  metadata?: {
    descriptionExperiment?: {
      applied?: boolean;
    };
  };
};

export type DescriptionExperimentArmInput = {
  trials: readonly DescriptionExperimentTrialInput[];
};

export type DescriptionExperimentCaseFlip = {
  aggregationKey: string;
  originalStatus: string;
  rewriteStatus: string;
};

export type DescriptionExperimentReportInput = {
  toolName: string;
  affectedAggregationKeys: readonly string[];
  original: DescriptionExperimentArmInput;
  rewrite: DescriptionExperimentArmInput;
  otherCaseFlips?: readonly DescriptionExperimentCaseFlip[];
  minSampleSize?: number;
  outcomeSource?: DescriptionExperimentOutcomeSource;
  frozen: DescriptionExperimentFrozen;
  assignment: DescriptionExperimentAssignment;
};

// ── classification ───────────────────────────────────────────────────────────

const NOT_TERMINAL_STATUSES = new Set([
  "pending",
  "running",
  "skipped",
  "cancelled",
  "setup_failed",
]);

/**
 * Decide whether one trial is eligible for the experiment rate, and if
 * not, why.
 *
 * Order is deliberate: engine support first (a harness trial was never
 * in scope), then lifecycle, then the rewrite-arm applied marker. A
 * cancelled trial's missing `applied` stamp is not `overrideNotApplied`.
 */
export function classifyDescriptionExperimentTrial(
  trial: DescriptionExperimentTrialInput,
  arm: DescriptionExperimentArm
): DescriptionExperimentExclusionReason | undefined {
  if (trial.engineSupported === false) return "unsupportedEngine";
  if (trial.evaluatorErrored === true) return "errored";
  if (trial.status === "timed_out") return "timedOut";
  if (trial.status === "failed") return "errored";
  if (NOT_TERMINAL_STATUSES.has(trial.status) || trial.status !== "completed") {
    return "notTerminal";
  }
  if (trial.isNegativeTest === true) return "negativeTest";
  if (arm === "rewrite" && trial.metadata?.descriptionExperiment?.applied !== true) {
    return "overrideNotApplied";
  }
  return undefined;
}

function incrementExclusion(
  exclusions: DescriptionExperimentExclusions,
  reason: DescriptionExperimentExclusionReason
): void {
  exclusions[reason] = (exclusions[reason] ?? 0) + 1;
}

function emptyExclusions(): DescriptionExperimentExclusions {
  return {};
}

type ClassifiedTrial = {
  trial: DescriptionExperimentTrialInput;
  exclusion: DescriptionExperimentExclusionReason | undefined;
  passed: boolean;
};

function classifyArm(
  arm: DescriptionExperimentArmInput,
  which: DescriptionExperimentArm
): ClassifiedTrial[] {
  return arm.trials.map((trial) => {
    const exclusion = classifyDescriptionExperimentTrial(trial, which);
    return {
      trial,
      exclusion,
      passed: exclusion === undefined && trial.result === "passed",
    };
  });
}

function sampleFromClassified(
  classified: readonly ClassifiedTrial[]
): DescriptionExperimentArmSample {
  const exclusions = emptyExclusions();
  let passed = 0;
  let failed = 0;
  for (const row of classified) {
    if (row.exclusion) {
      incrementExclusion(exclusions, row.exclusion);
      continue;
    }
    if (row.passed) passed += 1;
    else failed += 1;
  }
  return {
    eligible: passed + failed,
    passed,
    failed,
    exclusions,
  };
}

function toPoints(value: number): number {
  return value * 100;
}

function comparisonFromSamples(
  original: DescriptionExperimentArmSample,
  rewrite: DescriptionExperimentArmSample,
  minSampleSize: number
): Omit<DescriptionExperimentPooled, never> {
  const belowMinimum =
    original.eligible < minSampleSize || rewrite.eligible < minSampleSize;
  if (belowMinimum) {
    return {
      original,
      rewrite,
      interval: null,
      verdict: "insufficient_data",
      minSampleSize,
    };
  }

  const interval = newcombeDifferenceInterval({
    base: { passed: original.passed, total: original.eligible },
    compare: { passed: rewrite.passed, total: rewrite.eligible },
  });
  const points = {
    deltaPoints: toPoints(interval.delta),
    lowerPoints: toPoints(interval.lower),
    upperPoints: toPoints(interval.upper),
  };

  let verdict: DescriptionExperimentVerdict;
  if (interval.delta > 0) {
    verdict = interval.lower > 0 ? "improved" : "no_difference";
  } else if (interval.delta < 0) {
    verdict = interval.upper < 0 ? "regressed" : "no_difference";
  } else {
    verdict = "no_difference";
  }

  return {
    original,
    rewrite,
    interval: points,
    verdict,
    minSampleSize,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readToolName(call: unknown): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const record = call as Record<string, unknown>;
  return (
    nonEmptyString(record.toolName) ??
    nonEmptyString(record.tool) ??
    nonEmptyString(record.name)
  );
}

function uniqueToolNames(calls: readonly unknown[] | undefined): string[] {
  if (!calls) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const call of calls) {
    const name = readToolName(call);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function countExpectedNotCalled(
  classified: readonly ClassifiedTrial[],
  toolName: string
): number {
  let count = 0;
  for (const row of classified) {
    if (row.exclusion) continue;
    const expected = uniqueToolNames(row.trial.expectedToolCalls);
    if (!expected.includes(toolName)) continue;
    const actual = uniqueToolNames(row.trial.actualToolCalls);
    if (!actual.includes(toolName)) count += 1;
  }
  return count;
}

function substitutionKey(expected: string, observed: string): string {
  return `${expected}\u0000${observed}`;
}

function collectSubstitutions(
  classified: readonly ClassifiedTrial[]
): Map<string, { expected: string; observed: string; count: number }> {
  const out = new Map<
    string,
    { expected: string; observed: string; count: number }
  >();
  for (const row of classified) {
    if (row.exclusion) continue;
    const expected = uniqueToolNames(row.trial.expectedToolCalls);
    const actual = uniqueToolNames(row.trial.actualToolCalls);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((name) => !actualSet.has(name));
    const unexpected = actual.filter((name) => !expectedSet.has(name));
    if (missing.length !== 1 || unexpected.length !== 1) continue;
    const expectedName = missing[0]!;
    const observedName = unexpected[0]!;
    const key = substitutionKey(expectedName, observedName);
    const existing = out.get(key);
    if (existing) existing.count += 1;
    else out.set(key, { expected: expectedName, observed: observedName, count: 1 });
  }
  return out;
}

function deriveEvidenceLabel(
  frozen: DescriptionExperimentFrozen,
  assignment: DescriptionExperimentAssignment
): DescriptionExperimentEvidenceLabel {
  return frozen.environmentReset === "per_trial_sandbox" &&
    assignment.overlapVerified
    ? "controlled"
    : "reproducible";
}

function regressionFromFlips(
  flips: readonly DescriptionExperimentCaseFlip[] | undefined
): DescriptionExperimentRegression {
  if (flips === undefined) {
    return {
      checked: false,
      otherCases: 0,
      regressed: [],
      status: "non_gateable",
      reason: "other cases were not replayed with this experiment",
    };
  }
  const regressed = [...flips]
    .filter(
      (flip) =>
        flip.originalStatus === "passed" && flip.rewriteStatus !== "passed"
    )
    .map((flip) => flip.aggregationKey)
    .sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
  return {
    checked: true,
    otherCases: flips.length,
    regressed,
    status: regressed.length === 0 ? "passed" : "failed",
  };
}

/**
 * Assemble one description-experiment report from the two arms' trials.
 *
 * Validates the produced document. Throws if the assembler disagrees
 * with its own schema — that is a producer bug, not a caller one.
 */
export function buildDescriptionExperimentReport(
  input: DescriptionExperimentReportInput
): DescriptionExperimentReport {
  const minSampleSize = input.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const outcomeSource = input.outcomeSource ?? "deterministic";
  const affected = new Set(input.affectedAggregationKeys);

  const originalAll = classifyArm(input.original, "original");
  const rewriteAll = classifyArm(input.rewrite, "rewrite");

  const originalAffected = originalAll.filter((row) =>
    affected.has(row.trial.aggregationKey)
  );
  const rewriteAffected = rewriteAll.filter((row) =>
    affected.has(row.trial.aggregationKey)
  );

  const pooled = comparisonFromSamples(
    sampleFromClassified(originalAffected),
    sampleFromClassified(rewriteAffected),
    minSampleSize
  );

  const keys = [...affected].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const perCase = keys.map((aggregationKey) => {
    const original = sampleFromClassified(
      originalAffected.filter((row) => row.trial.aggregationKey === aggregationKey)
    );
    const rewrite = sampleFromClassified(
      rewriteAffected.filter((row) => row.trial.aggregationKey === aggregationKey)
    );
    return {
      aggregationKey,
      ...comparisonFromSamples(original, rewrite, minSampleSize),
    };
  });

  const originalSubs = collectSubstitutions(originalAffected);
  const rewriteSubs = collectSubstitutions(rewriteAffected);
  const subKeys = new Set([...originalSubs.keys(), ...rewriteSubs.keys()]);
  const substitutions =
    subKeys.size === 0
      ? undefined
      : [...subKeys]
          .map((key) => {
            const original = originalSubs.get(key);
            const rewrite = rewriteSubs.get(key);
            return {
              expected: (original ?? rewrite)!.expected,
              observed: (original ?? rewrite)!.observed,
              original: original?.count ?? 0,
              rewrite: rewrite?.count ?? 0,
            };
          })
          .sort((left, right) => {
            if (left.expected !== right.expected) {
              return left.expected < right.expected ? -1 : 1;
            }
            return left.observed < right.observed
              ? -1
              : left.observed > right.observed
                ? 1
                : 0;
          });

  const report: DescriptionExperimentReport = {
    schemaVersion: DESCRIPTION_EXPERIMENT_SCHEMA_VERSION,
    toolName: input.toolName,
    population: "trial",
    primary: {
      outcomeSource,
      pooled,
      perCase,
    },
    secondary: {
      expectedToolNotCalled: {
        original: countExpectedNotCalled(originalAffected, input.toolName),
        rewrite: countExpectedNotCalled(rewriteAffected, input.toolName),
      },
      ...(substitutions ? { substitutions } : {}),
    },
    regression: regressionFromFlips(input.otherCaseFlips),
    frozen: input.frozen,
    assignment: input.assignment,
    evidenceLabel: deriveEvidenceLabel(input.frozen, input.assignment),
    reportOnly: true,
  };

  const parsed = descriptionExperimentReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `buildDescriptionExperimentReport produced an invalid document: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

// ── word diff ────────────────────────────────────────────────────────────────

export type DescriptionWordDiffToken = {
  type: "eq" | "add" | "del";
  text: string;
};

export type DescriptionWordDiff = {
  added: string[];
  removed: string[];
  tokens: DescriptionWordDiffToken[];
};

function wordsOf(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

/**
 * Small LCS word diff. No extra dependency — the experiment card only
 * needs added/removed words, not a patch format.
 */
export function diffDescriptionWords(
  original: string,
  rewrite: string
): DescriptionWordDiff {
  const left = wordsOf(original);
  const right = wordsOf(rewrite);
  const n = left.length;
  const m = right.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  );
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i]![j] =
        left[i - 1] === right[j - 1]
          ? (table[i - 1]![j - 1] ?? 0) + 1
          : Math.max(table[i - 1]![j] ?? 0, table[i]![j - 1] ?? 0);
    }
  }

  const tokens: DescriptionWordDiffToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      tokens.push({ type: "eq", text: left[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || (table[i]![j - 1] ?? 0) >= (table[i - 1]![j] ?? 0))) {
      tokens.push({ type: "add", text: right[j - 1]! });
      j -= 1;
    } else {
      tokens.push({ type: "del", text: left[i - 1]! });
      i -= 1;
    }
  }
  tokens.reverse();

  return {
    added: tokens.filter((token) => token.type === "add").map((token) => token.text),
    removed: tokens.filter((token) => token.type === "del").map((token) => token.text),
    tokens,
  };
}
