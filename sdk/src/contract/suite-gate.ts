/**
 * The versioned **suite quality-gate** contract — what a stored suite policy
 * asks of a run, and how that answer composes with the existing flag gate.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * It is the CONTRACT and a PURE evaluator. There is no network, no Convex,
 * no CLI flag parsing. B1/B1b mirror these shapes and call the same
 * evaluator; B2 wires the CLI. Existing `evaluateGates` /
 * `evaluateCompareGates` flag behaviour is deliberately untouched.
 *
 * Two rules follow the same discipline as `./verdict-policy.ts`:
 *
 *  1. **No `.default()` anywhere.** An omitted field stays omitted, so a
 *     payload is byte-stable through `canonicalJson`. A stored `false` is
 *     dropped on normalize; a stored `0` is kept, because numeric zero is
 *     an active threshold.
 *  2. **Every object declared here is `.strict()`.** Unknown fields are
 *     errors, matching Convex `v.object`, which the backend mirror uses.
 *
 * ── Conditions ──────────────────────────────────────────────────────────────
 *
 * Absolute and comparative conditions are independent.
 *
 *   - `noGatingScoreErrors` needs only the subject run. It uses the same
 *     integrity / definition-hash join as `evaluateGates`: a gating row is
 *     one whose joined definition has `role: "gating"`. Generated ids are
 *     still inspected here.
 *   - `maximumPassRateDrop`, `noDeterministicRegressions` and
 *     `maximumP95LatencyIncreaseMs` each need a baseline and a compatible
 *     population. `previous_completed` is typed but rejected on every
 *     authoring write until a later capability enables it.
 *
 * `maximumPassRateDrop` is an observed-rate threshold on EACH gating
 * scorer, not the statistical `passRateRegression` CI test. It fails when
 * `basePassRate - subjectPassRate` is STRICTLY greater than the configured
 * fraction; equality passes. Missing, new, removed or changed gating
 * evidence is `non_gateable`, never silently filtered. Generated scorer ids
 * block this identity-dependent comparison without being dropped from the
 * absolute error check.
 *
 * Overall condition precedence: failed > non_gateable > passed. No active
 * conditions is `not_configured`, whether or not a baseline selector remains
 * stored. Unavailable or unfinished subject evidence never becomes a
 * measurement of failure.
 *
 * ── CI composition ──────────────────────────────────────────────────────────
 *
 * {@link composeSuiteGateWithBaseReport} first applies the existing waiver
 * rules to the flag/base report, then folds the suite-gate report as a
 * SEPARATE, unwaived section. A run's waiver never waives the suite policy.
 */

import { z } from "zod";
import { canonicalDigest } from "./canonical.js";
import { definitionHash } from "./derive.js";
import {
  resolvedScoreDefinitionSchema,
  scoreStatusSchema,
  scorerIdSourceSchema,
  scorerRoleSchema,
} from "./schemas.js";
import type {
  ResolvedScoreDefinition,
  ScorerIdSource,
  ScorerRole,
} from "./types.js";
import { evalExecutionVariantSchema } from "./verdict-policy.js";

/** Report / evaluator version, as a literal. Absence is not v1. */
export const SUITE_GATE_SCHEMA_VERSION = 1;
export type SuiteGateSchemaVersion = typeof SUITE_GATE_SCHEMA_VERSION;
export const suiteGateSchemaVersionSchema = z.literal(SUITE_GATE_SCHEMA_VERSION);

/**
 * Evaluator version stamped on every report.
 *
 * Bumped only when evaluation SEMANTICS change. A fixture corpus pins this
 * number so a silently rewritten helper cannot claim the same reports.
 */
export const SUITE_GATE_EVALUATOR_VERSION = 1;
export type SuiteGateEvaluatorVersion = typeof SUITE_GATE_EVALUATOR_VERSION;
export const suiteGateEvaluatorVersionSchema = z.literal(
  SUITE_GATE_EVALUATOR_VERSION
);

/** The `$id` of the published JSON Schema for this contract (when generated). */
export const SUITE_GATE_SCHEMA_ID =
  "https://mcpjam.com/schemas/suite-gate/v1.json";

// ── policy ───────────────────────────────────────────────────────────────────

/**
 * Where a comparative condition looks for its baseline.
 *
 * `previous_completed` is reserved. The type exists so a later capability
 * can enable it without a schema fork; every public/direct write rejects it
 * today. A historical row that already stored it is `non_gateable` at
 * evaluate time, never silently ignored.
 */
export const SUITE_GATE_BASELINE_KINDS = [
  "run",
  "commit_sha",
  "previous_completed",
] as const;
export type SuiteGateBaselineKind = (typeof SUITE_GATE_BASELINE_KINDS)[number];

export const suiteGateBaselineSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), runId: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("commit_sha"), commitSha: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("previous_completed") }).strict(),
]);
export type SuiteGateBaselineSelectorV1 = z.infer<
  typeof suiteGateBaselineSelectorSchema
>;

/**
 * Stored suite quality-gate policy.
 *
 * Numeric fields are FRACTIONS in [0,1] (`maximumPassRateDrop`) or
 * nonnegative milliseconds (`maximumP95LatencyIncreaseMs`). Percent-shaped
 * `3` meaning "3%" is a usage error, not 3 percentage points.
 */
export const suiteGatePolicySchema = z
  .object({
    baseline: suiteGateBaselineSelectorSchema.optional(),
    maximumPassRateDrop: z.number().min(0).max(1).optional(),
    noDeterministicRegressions: z.boolean().optional(),
    maximumP95LatencyIncreaseMs: z.number().min(0).optional(),
    noGatingScoreErrors: z.boolean().optional(),
  })
  .strict();
export type SuiteGatePolicyV1 = z.infer<typeof suiteGatePolicySchema>;

export const SUITE_GATE_CONDITION_NAMES = [
  "noGatingScoreErrors",
  "maximumPassRateDrop",
  "noDeterministicRegressions",
  "maximumP95LatencyIncreaseMs",
] as const;
export type SuiteGateConditionName =
  (typeof SUITE_GATE_CONDITION_NAMES)[number];

export function isSuiteGateConditionName(
  value: unknown
): value is SuiteGateConditionName {
  return (
    typeof value === "string" &&
    (SUITE_GATE_CONDITION_NAMES as readonly string[]).includes(value)
  );
}

export const SUITE_GATE_COMPARATIVE_CONDITIONS = [
  "maximumPassRateDrop",
  "noDeterministicRegressions",
  "maximumP95LatencyIncreaseMs",
] as const satisfies ReadonlyArray<SuiteGateConditionName>;
Object.freeze(SUITE_GATE_COMPARATIVE_CONDITIONS);

/**
 * Which evidence fields each condition actually reads.
 *
 * A producer that omits a listed field makes that condition
 * `non_gateable` rather than inventing a measurement. Comparative
 * conditions also require a resolved baseline run and the population
 * flags listed under `baseline`.
 */
export const SUITE_GATE_CONDITION_REQUIRED_FIELDS = {
  noGatingScoreErrors: [
    "subject.final",
    "subject.scoreIntegrity",
    "subject.evaluationConfig.definitions",
    "subject.scores",
  ],
  maximumPassRateDrop: [
    "subject.final",
    "subject.scoreIntegrity",
    "subject.evaluationConfig.definitions",
    "subject.scorerSummaries|subject.scores",
    "baseline.resolved",
    "baseline.run.final",
    "baseline.run.scoreIntegrity",
    "baseline.run.evaluationConfig.definitions",
    "baseline.run.scorerSummaries|baseline.run.scores",
    "baseline.caseSetChanged",
    "baseline.scenarioConfigChanged",
    "baseline.evaluationConfigChanged",
    "baseline.iterationWeightingEqual",
    "baseline.configuredWeightsMatch|baseline.configuredWeights",
    "baseline.observedWeightsMatch|baseline.observedWeights",
  ],
  noDeterministicRegressions: [
    "subject.final",
    "subject.scoreIntegrity",
    "subject.evaluationConfig.definitions",
    "baseline.resolved",
    "baseline.run.final",
    "baseline.run.scoreIntegrity",
    "baseline.scoreDeltasAvailable",
    "baseline.deterministicScoreRegressions",
    "baseline.caseSetChanged",
    "baseline.scenarioConfigChanged",
    "baseline.evaluationConfigChanged",
    "baseline.iterationWeightingEqual",
  ],
  maximumP95LatencyIncreaseMs: [
    "subject.final",
    "subject.e2eP95Ms",
    "baseline.resolved",
    "baseline.run.final",
    "baseline.run.e2eP95Ms",
    "baseline.caseSetChanged",
    "baseline.scenarioConfigChanged",
    "baseline.evaluationConfigChanged",
    "baseline.iterationWeightingEqual",
  ],
} as const;

// ── non-gateable reasons ─────────────────────────────────────────────────────

export const SUITE_GATE_NON_GATEABLE_REASONS = [
  "POLICY_MALFORMED",
  "PREVIOUS_COMPLETED_UNSUPPORTED",
  "COMPARATIVE_WITHOUT_BASELINE",
  "BASELINE_UNRESOLVED",
  "EVIDENCE_MALFORMED",
  "EVIDENCE_NOT_FINAL",
  "EVIDENCE_LIMIT_REACHED",
  "INCOMPLETE_CAPTURE",
  "INTEGRITY_UNVERIFIED",
  "NO_EVALUATION_CONFIG",
  "EMPTY_COUNTABLE_EVIDENCE",
  "GENERATED_SCORER_ID",
  "SCORER_MISSING",
  "SCORER_ADDED",
  "SCORER_REMOVED",
  "SCORER_CHANGED",
  "POPULATION_INCOMPATIBLE",
  "CONFIGURED_WEIGHTS_MISMATCH",
  "OBSERVED_WEIGHTS_MISMATCH",
  "QUARANTINED",
  "LATENCY_UNMEASURED",
  "SCORE_DELTAS_UNAVAILABLE",
] as const;
export type SuiteGateNonGateableReason =
  (typeof SUITE_GATE_NON_GATEABLE_REASONS)[number];
export const suiteGateNonGateableReasonSchema = z.enum(
  SUITE_GATE_NON_GATEABLE_REASONS
);

export function isSuiteGateNonGateableReason(
  value: unknown
): value is SuiteGateNonGateableReason {
  return (
    typeof value === "string" &&
    (SUITE_GATE_NON_GATEABLE_REASONS as readonly string[]).includes(value)
  );
}

// ── evidence ─────────────────────────────────────────────────────────────────

export const suiteGateScoreRowSchema = z
  .object({
    scorerId: z.string().min(1),
    definitionHash: z.string().min(1),
    status: scoreStatusSchema,
    passed: z.boolean().optional(),
  })
  .strict();
export type SuiteGateScoreRowV1 = z.infer<typeof suiteGateScoreRowSchema>;

/**
 * Per-scorer observed rates. `passRate` is `passed / countable`, or `null`
 * when `countable` is 0 — a zero denominator is not a rate of 0.
 */
export const suiteGateScorerSummarySchema = z
  .object({
    scorerId: z.string().min(1),
    definitionHash: z.string().min(1),
    idSource: scorerIdSourceSchema,
    role: scorerRoleSchema,
    deterministic: z.boolean(),
    countable: z.number().int().min(0),
    passed: z.number().int().min(0),
    passRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type SuiteGateScorerSummaryV1 = z.infer<
  typeof suiteGateScorerSummarySchema
>;

export const suiteGatePopulationWeightSchema = z
  .object({
    caseId: z.string().min(1),
    executionVariant: evalExecutionVariantSchema.optional(),
    trials: z.number().int().min(0),
    quarantined: z.boolean().optional(),
  })
  .strict();
export type SuiteGatePopulationWeightV1 = z.infer<
  typeof suiteGatePopulationWeightSchema
>;

export const suiteGateDeterministicRegressionSchema = z
  .object({
    caseKey: z.string().min(1),
    scorerId: z.string().min(1),
  })
  .strict();
export type SuiteGateDeterministicRegressionV1 = z.infer<
  typeof suiteGateDeterministicRegressionSchema
>;

export const suiteGateEvaluationConfigSchema = z
  .object({
    hash: z.string().min(1).optional(),
    definitions: z.array(resolvedScoreDefinitionSchema),
  })
  .strict();
export type SuiteGateEvaluationConfigV1 = z.infer<
  typeof suiteGateEvaluationConfigSchema
>;

export const suiteGateRunEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    /**
     * False when the run is still `running` / `grading` or a relevant
     * source is unsettled. Comparative AND absolute conditions that need
     * this run become `EVIDENCE_NOT_FINAL`, never a measured failure.
     */
    final: z.boolean(),
    scoreIntegrity: z.enum(["valid", "invalid"]).optional(),
    evaluationConfig: suiteGateEvaluationConfigSchema.optional(),
    scores: z.array(suiteGateScoreRowSchema).optional(),
    scorerSummaries: z.array(suiteGateScorerSummarySchema).optional(),
    e2eP95Ms: z.number().min(0).optional(),
    /** False when iteration/score pages were truncated or missing. */
    captureComplete: z.boolean().optional(),
    evidenceLimitReached: z.boolean().optional(),
  })
  .strict();
export type SuiteGateRunEvidenceV1 = z.infer<typeof suiteGateRunEvidenceSchema>;

export const suiteGateBaselineEvidenceSchema = z
  .object({
    selector: suiteGateBaselineSelectorSchema,
    resolved: z.boolean(),
    run: suiteGateRunEvidenceSchema.optional(),
    caseSetChanged: z.boolean().optional(),
    scenarioConfigChanged: z.boolean().optional(),
    evaluationConfigChanged: z.boolean().optional(),
    iterationWeightingEqual: z.boolean().optional(),
    configuredWeightsMatch: z.boolean().optional(),
    observedWeightsMatch: z.boolean().optional(),
    scoreDeltasAvailable: z.boolean().optional(),
    deterministicScoreRegressions: z
      .array(suiteGateDeterministicRegressionSchema)
      .optional(),
    configuredWeights: z
      .object({
        subject: z.array(suiteGatePopulationWeightSchema),
        baseline: z.array(suiteGatePopulationWeightSchema),
      })
      .strict()
      .optional(),
    observedWeights: z
      .object({
        subject: z.array(suiteGatePopulationWeightSchema),
        baseline: z.array(suiteGatePopulationWeightSchema),
      })
      .strict()
      .optional(),
    quarantined: z.boolean().optional(),
  })
  .strict();
export type SuiteGateBaselineEvidenceV1 = z.infer<
  typeof suiteGateBaselineEvidenceSchema
>;

export const suiteGateEvidenceSchema = z
  .object({
    subject: suiteGateRunEvidenceSchema,
    baseline: suiteGateBaselineEvidenceSchema.optional(),
  })
  .strict();
export type SuiteGateEvidenceV1 = z.infer<typeof suiteGateEvidenceSchema>;

// ── report ───────────────────────────────────────────────────────────────────

export const SUITE_GATE_CONDITION_STATUSES = [
  "passed",
  "failed",
  "non_gateable",
] as const;
export type SuiteGateConditionStatus =
  (typeof SUITE_GATE_CONDITION_STATUSES)[number];

export const SUITE_GATE_OUTCOMES = [
  "passed",
  "failed",
  "non_gateable",
  "not_configured",
] as const;
export type SuiteGateOutcomeV1 = (typeof SUITE_GATE_OUTCOMES)[number];

export const suiteGateConditionVerdictSchema = z
  .object({
    condition: z.enum(SUITE_GATE_CONDITION_NAMES),
    status: z.enum(SUITE_GATE_CONDITION_STATUSES),
    message: z.string().min(1),
    reason: suiteGateNonGateableReasonSchema.optional(),
    observed: z.number().optional(),
    threshold: z.number().optional(),
    scorerId: z.string().min(1).optional(),
  })
  .strict();
export type SuiteGateConditionVerdictV1 = z.infer<
  typeof suiteGateConditionVerdictSchema
>;

export const suiteGateReportSchema = z
  .object({
    schemaVersion: suiteGateSchemaVersionSchema,
    evaluatorVersion: suiteGateEvaluatorVersionSchema,
    policy: suiteGatePolicySchema,
    policyHash: z.string().min(1),
    outcome: z.enum(SUITE_GATE_OUTCOMES),
    conditions: z.array(suiteGateConditionVerdictSchema),
    policyError: z
      .object({
        reason: suiteGateNonGateableReasonSchema,
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SuiteGateReportV1 = z.infer<typeof suiteGateReportSchema>;

// ── normalize / validate ─────────────────────────────────────────────────────

export function hasComparativeSuiteGateConditions(
  policy: SuiteGatePolicyV1
): boolean {
  return (
    policy.maximumPassRateDrop !== undefined ||
    policy.noDeterministicRegressions === true ||
    policy.maximumP95LatencyIncreaseMs !== undefined
  );
}

export function suiteGateActiveConditions(
  policy: SuiteGatePolicyV1
): SuiteGateConditionName[] {
  const active: SuiteGateConditionName[] = [];
  if (policy.noGatingScoreErrors === true) active.push("noGatingScoreErrors");
  if (policy.maximumPassRateDrop !== undefined) {
    active.push("maximumPassRateDrop");
  }
  if (policy.noDeterministicRegressions === true) {
    active.push("noDeterministicRegressions");
  }
  if (policy.maximumP95LatencyIncreaseMs !== undefined) {
    active.push("maximumP95LatencyIncreaseMs");
  }
  return active;
}

/**
 * Drop inactive fields. `false` booleans disappear; numeric `0` stays.
 * A leftover baseline selector is kept even when no condition is active —
 * `not_configured` is about conditions, not about stored provenance.
 */
export function normalizeSuiteGatePolicy(
  policy: SuiteGatePolicyV1
): SuiteGatePolicyV1 {
  const normalized: SuiteGatePolicyV1 = {};
  if (policy.baseline !== undefined) normalized.baseline = policy.baseline;
  if (policy.maximumPassRateDrop !== undefined) {
    normalized.maximumPassRateDrop = policy.maximumPassRateDrop;
  }
  if (policy.noDeterministicRegressions === true) {
    normalized.noDeterministicRegressions = true;
  }
  if (policy.maximumP95LatencyIncreaseMs !== undefined) {
    normalized.maximumP95LatencyIncreaseMs = policy.maximumP95LatencyIncreaseMs;
  }
  if (policy.noGatingScoreErrors === true) {
    normalized.noGatingScoreErrors = true;
  }
  return normalized;
}

export function suiteGatePolicyHash(policy: SuiteGatePolicyV1): string {
  return canonicalDigest(normalizeSuiteGatePolicy(policy));
}

export type SuiteGatePolicyParseResult =
  | { ok: true; policy: SuiteGatePolicyV1; hash: string }
  | { ok: false; reason: SuiteGateNonGateableReason; message: string };

function policyParseError(
  reason: SuiteGateNonGateableReason,
  message: string
): SuiteGatePolicyParseResult {
  return { ok: false, reason, message };
}

/**
 * Authoring / public-write validation.
 *
 * Rejects `previous_completed` and active comparative conditions that have
 * no selector. A caller that wants to store "baseline only, no conditions"
 * is accepted — that is a stored selector, not a gate.
 */
export function parseSuiteGatePolicyForAuthoring(
  input: unknown
): SuiteGatePolicyParseResult {
  const parsed = suiteGatePolicySchema.safeParse(input);
  if (!parsed.success) {
    return policyParseError(
      "POLICY_MALFORMED",
      parsed.error.issues[0]?.message ?? "suite gate policy is malformed"
    );
  }
  const policy = normalizeSuiteGatePolicy(parsed.data);
  if (policy.baseline?.kind === "previous_completed") {
    return policyParseError(
      "PREVIOUS_COMPLETED_UNSUPPORTED",
      'baseline kind "previous_completed" is reserved and cannot be written yet'
    );
  }
  if (hasComparativeSuiteGateConditions(policy) && policy.baseline === undefined) {
    return policyParseError(
      "COMPARATIVE_WITHOUT_BASELINE",
      "comparative suite-gate conditions require a baseline selector"
    );
  }
  return { ok: true, policy, hash: suiteGatePolicyHash(policy) };
}

/**
 * Read-time validation. Same shape rules, but a reserved or historically
 * incomplete policy is returned as a failed parse so the evaluator can
 * stamp `non_gateable` instead of dropping the row.
 *
 * `previous_completed` parses as a valid SHAPE here — the evaluator then
 * refuses the comparative conditions it would have enabled. A structurally
 * invalid payload (bad fraction, unknown key) is `POLICY_MALFORMED`.
 */
export function parseSuiteGatePolicyForRead(
  input: unknown
): SuiteGatePolicyParseResult {
  const parsed = suiteGatePolicySchema.safeParse(input);
  if (!parsed.success) {
    return policyParseError(
      "POLICY_MALFORMED",
      parsed.error.issues[0]?.message ?? "suite gate policy is malformed"
    );
  }
  const policy = normalizeSuiteGatePolicy(parsed.data);
  return { ok: true, policy, hash: suiteGatePolicyHash(policy) };
}

// ── evaluator ────────────────────────────────────────────────────────────────

function emptyReport(
  policy: SuiteGatePolicyV1,
  outcome: SuiteGateOutcomeV1,
  extras: Partial<SuiteGateReportV1> = {}
): SuiteGateReportV1 {
  return {
    schemaVersion: SUITE_GATE_SCHEMA_VERSION,
    evaluatorVersion: SUITE_GATE_EVALUATOR_VERSION,
    policy,
    policyHash: suiteGatePolicyHash(policy),
    outcome,
    conditions: extras.conditions ?? [],
    ...(extras.policyError ? { policyError: extras.policyError } : {}),
  };
}

function foldConditionStatuses(
  statuses: SuiteGateConditionStatus[]
): SuiteGateConditionStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "non_gateable")) {
    return "non_gateable";
  }
  return "passed";
}

function foldOutcome(
  conditions: SuiteGateConditionVerdictV1[]
): SuiteGateOutcomeV1 {
  if (conditions.length === 0) return "not_configured";
  const status = foldConditionStatuses(conditions.map((row) => row.status));
  return status === "failed"
    ? "failed"
    : status === "non_gateable"
      ? "non_gateable"
      : "passed";
}

function nonGateable(
  condition: SuiteGateConditionName,
  reason: SuiteGateNonGateableReason,
  message: string,
  extras: Partial<SuiteGateConditionVerdictV1> = {}
): SuiteGateConditionVerdictV1 {
  return { condition, status: "non_gateable", message, reason, ...extras };
}

function subjectBlockingReason(
  run: SuiteGateRunEvidenceV1
): SuiteGateConditionVerdictV1["reason"] | null {
  if (run.final === false) return "EVIDENCE_NOT_FINAL";
  if (run.evidenceLimitReached === true) return "EVIDENCE_LIMIT_REACHED";
  if (run.captureComplete === false) return "INCOMPLETE_CAPTURE";
  return null;
}

function blockingMessage(reason: SuiteGateNonGateableReason): string {
  switch (reason) {
    case "EVIDENCE_NOT_FINAL":
      return "subject evidence is not final, so this condition cannot be measured";
    case "EVIDENCE_LIMIT_REACHED":
      return "evidence exceeded the read budget, so this condition cannot be measured";
    case "INCOMPLETE_CAPTURE":
      return "score or iteration capture is incomplete, so this condition cannot be measured";
    default:
      return reason;
  }
}

function integrityGateable(
  integrity: SuiteGateRunEvidenceV1["scoreIntegrity"]
): boolean {
  // Same tri-state as `evaluateGates`: absent is not valid.
  return integrity === "valid";
}

function integrityMessage(
  integrity: SuiteGateRunEvidenceV1["scoreIntegrity"],
  side: "subject" | "baseline"
): string {
  return integrity === "invalid"
    ? `the ${side} run's score evidence did not verify at ingest`
    : `the ${side} run carries no score-integrity verdict, so its scores cannot be trusted to gate (absent evidence is not valid evidence)`;
}

function definitionsOf(
  run: SuiteGateRunEvidenceV1 | undefined
): ResolvedScoreDefinition[] {
  return run?.evaluationConfig?.definitions ?? [];
}

function summariesFor(
  run: SuiteGateRunEvidenceV1
): SuiteGateScorerSummaryV1[] {
  if (run.scorerSummaries) return run.scorerSummaries;
  const definitions = definitionsOf(run);
  const byHash = new Map(
    definitions.map((definition) => [definitionHash(definition), definition])
  );
  const buckets = new Map<
    string,
    { definition: ResolvedScoreDefinition; countable: number; passed: number }
  >();
  for (const score of run.scores ?? []) {
    const definition = byHash.get(score.definitionHash);
    if (!definition) continue;
    const bucket = buckets.get(score.definitionHash) ?? {
      definition,
      countable: 0,
      passed: 0,
    };
    if (score.status !== "not_applicable") {
      bucket.countable += 1;
      if (score.passed === true) bucket.passed += 1;
    }
    buckets.set(score.definitionHash, bucket);
  }
  return [...buckets.values()].map(({ definition, countable, passed }) => ({
    scorerId: definition.scorerId,
    definitionHash: definitionHash(definition),
    idSource: definition.idSource,
    role: definition.role,
    deterministic: definition.deterministic,
    countable,
    passed,
    passRate: countable > 0 ? passed / countable : null,
  }));
}

function weightsEqual(
  left: SuiteGatePopulationWeightV1[] | undefined,
  right: SuiteGatePopulationWeightV1[] | undefined
): boolean {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  const keyOf = (row: SuiteGatePopulationWeightV1): string =>
    JSON.stringify({
      caseId: row.caseId,
      executionVariant: row.executionVariant ?? null,
      trials: row.trials,
    });
  const rightKeys = new Map(right.map((row) => [keyOf(row), row]));
  for (const row of left) {
    const match = rightKeys.get(keyOf(row));
    if (!match) return false;
  }
  return true;
}

function weightsQuarantined(
  weights: SuiteGatePopulationWeightV1[] | undefined
): boolean {
  return (weights ?? []).some((row) => row.quarantined === true);
}

function populationIncompatible(
  baseline: SuiteGateBaselineEvidenceV1
): SuiteGateNonGateableReason | null {
  if (baseline.quarantined === true) return "QUARANTINED";
  if (
    weightsQuarantined(baseline.observedWeights?.subject) ||
    weightsQuarantined(baseline.observedWeights?.baseline)
  ) {
    return "QUARANTINED";
  }
  if (
    baseline.caseSetChanged === true ||
    baseline.scenarioConfigChanged === true ||
    baseline.evaluationConfigChanged === true ||
    baseline.iterationWeightingEqual === false
  ) {
    return "POPULATION_INCOMPATIBLE";
  }
  if (baseline.configuredWeightsMatch === false) {
    return "CONFIGURED_WEIGHTS_MISMATCH";
  }
  if (
    baseline.configuredWeights &&
    !weightsEqual(
      baseline.configuredWeights.subject,
      baseline.configuredWeights.baseline
    )
  ) {
    return "CONFIGURED_WEIGHTS_MISMATCH";
  }
  if (baseline.observedWeightsMatch === false) {
    return "OBSERVED_WEIGHTS_MISMATCH";
  }
  if (
    baseline.observedWeights &&
    !weightsEqual(
      baseline.observedWeights.subject,
      baseline.observedWeights.baseline
    )
  ) {
    return "OBSERVED_WEIGHTS_MISMATCH";
  }
  return null;
}

function evaluateNoGatingScoreErrors(
  subject: SuiteGateRunEvidenceV1
): SuiteGateConditionVerdictV1 {
  const condition = "noGatingScoreErrors";
  const blocked = subjectBlockingReason(subject);
  if (blocked) {
    return nonGateable(condition, blocked, blockingMessage(blocked));
  }
  const definitions = definitionsOf(subject);
  if (definitions.length === 0) {
    return nonGateable(
      condition,
      "NO_EVALUATION_CONFIG",
      "this run carries no evaluation config, so its scores cannot be resolved to definitions (whether each one gates is unknown)"
    );
  }
  if (!integrityGateable(subject.scoreIntegrity)) {
    return nonGateable(
      condition,
      "INTEGRITY_UNVERIFIED",
      integrityMessage(subject.scoreIntegrity, "subject")
    );
  }
  if (subject.scores === undefined) {
    return nonGateable(
      condition,
      "INCOMPLETE_CAPTURE",
      "no score rows are available for this run"
    );
  }
  // Joined by definitionHash, like `evaluateGates`. Generated ids stay in
  // this walk — they are gating definitions, and dropping them would
  // silently ignore an errored generated scorer.
  const byHash = new Map(
    definitions.map((definition) => [definitionHash(definition), definition])
  );
  const errored = subject.scores.filter(
    (score) =>
      score.status === "error" &&
      byHash.get(score.definitionHash)?.role === "gating"
  );
  return {
    condition,
    status: errored.length === 0 ? "passed" : "failed",
    message:
      errored.length === 0
        ? "no gating scorer errored"
        : `${errored.length} gating score(s) errored: ` +
          `${[...new Set(errored.map((score) => score.scorerId))].join(", ")}`,
    observed: errored.length,
  };
}

type GatingIdentity = {
  scorerId: string;
  definitionHash: string;
  idSource: ScorerIdSource;
  role: ScorerRole;
};

function gatingIdentities(run: SuiteGateRunEvidenceV1): GatingIdentity[] {
  const fromDefinitions = definitionsOf(run)
    .filter((definition) => definition.role === "gating")
    .map((definition) => ({
      scorerId: definition.scorerId,
      definitionHash: definitionHash(definition),
      idSource: definition.idSource,
      role: definition.role,
    }));
  if (fromDefinitions.length > 0) return fromDefinitions;
  return summariesFor(run)
    .filter((summary) => summary.role === "gating")
    .map((summary) => ({
      scorerId: summary.scorerId,
      definitionHash: summary.definitionHash,
      idSource: summary.idSource,
      role: summary.role,
    }));
}

function evaluatePassRateDrop(
  policy: SuiteGatePolicyV1,
  evidence: SuiteGateEvidenceV1
): SuiteGateConditionVerdictV1 {
  const condition = "maximumPassRateDrop";
  const threshold = policy.maximumPassRateDrop as number;
  const blocked = subjectBlockingReason(evidence.subject);
  if (blocked) {
    return nonGateable(condition, blocked, blockingMessage(blocked), {
      threshold,
    });
  }
  const baselineBlock = comparativeBaselineBlock(policy, evidence, threshold);
  if (baselineBlock) return baselineBlock;
  const baseline = evidence.baseline as SuiteGateBaselineEvidenceV1;
  const baseRun = baseline.run as SuiteGateRunEvidenceV1;
  if (!integrityGateable(evidence.subject.scoreIntegrity)) {
    return nonGateable(
      condition,
      "INTEGRITY_UNVERIFIED",
      integrityMessage(evidence.subject.scoreIntegrity, "subject"),
      { threshold }
    );
  }
  if (!integrityGateable(baseRun.scoreIntegrity)) {
    return nonGateable(
      condition,
      "INTEGRITY_UNVERIFIED",
      integrityMessage(baseRun.scoreIntegrity, "baseline"),
      { threshold }
    );
  }

  const subjectSummaries = summariesFor(evidence.subject);
  const baseSummaries = summariesFor(baseRun);
  const subjectById = new Map(
    subjectSummaries.map((summary) => [summary.scorerId, summary])
  );
  const baseById = new Map(
    baseSummaries.map((summary) => [summary.scorerId, summary])
  );
  const subjectIds = new Set(gatingIdentities(evidence.subject).map((row) => row.scorerId));
  const baseIds = new Set(gatingIdentities(baseRun).map((row) => row.scorerId));
  const identities = [
    ...gatingIdentities(evidence.subject),
    ...gatingIdentities(baseRun).filter((row) => !subjectIds.has(row.scorerId)),
  ];

  const partials: SuiteGateConditionVerdictV1[] = [];
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.scorerId)) continue;
    seen.add(identity.scorerId);
    if (identity.idSource === "generated") {
      partials.push(
        nonGateable(
          condition,
          "GENERATED_SCORER_ID",
          `scorer "${identity.scorerId}" has a generated, positional id — it renumbers when the scorer list changes, so a per-scorer drop cannot be gated on`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    const inSubject = subjectIds.has(identity.scorerId);
    const inBase = baseIds.has(identity.scorerId);
    if (inSubject && !inBase) {
      partials.push(
        nonGateable(
          condition,
          "SCORER_ADDED",
          `gating scorer "${identity.scorerId}" is new on the subject run`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    if (!inSubject && inBase) {
      partials.push(
        nonGateable(
          condition,
          "SCORER_REMOVED",
          `gating scorer "${identity.scorerId}" is missing from the subject run`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    const subjectSummary = subjectById.get(identity.scorerId);
    const baseSummary = baseById.get(identity.scorerId);
    if (!subjectSummary || !baseSummary) {
      partials.push(
        nonGateable(
          condition,
          "SCORER_MISSING",
          `gating scorer "${identity.scorerId}" has no countable summary on one side`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    if (subjectSummary.definitionHash !== baseSummary.definitionHash) {
      partials.push(
        nonGateable(
          condition,
          "SCORER_CHANGED",
          `gating scorer "${identity.scorerId}" changed definition between baseline and subject`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    if (
      subjectSummary.passRate === null ||
      baseSummary.passRate === null ||
      subjectSummary.countable === 0 ||
      baseSummary.countable === 0
    ) {
      partials.push(
        nonGateable(
          condition,
          "EMPTY_COUNTABLE_EVIDENCE",
          `gating scorer "${identity.scorerId}" has no countable evidence on one side`,
          { threshold, scorerId: identity.scorerId }
        )
      );
      continue;
    }
    const drop =
      (baseSummary.passed * subjectSummary.countable -
        subjectSummary.passed * baseSummary.countable) /
      (baseSummary.countable * subjectSummary.countable);
    // Compare in integer space so 100/100 -> 97/100 against 0.03 is
    // equality, not a float that lands a hair over the fraction.
    // (bP/bC - sP/sC) > t  iff  (bP*sC - sP*bC) > t*bC*sC
    const exceeds =
      baseSummary.passed * subjectSummary.countable -
        subjectSummary.passed * baseSummary.countable >
      threshold * baseSummary.countable * subjectSummary.countable;
    partials.push({
      condition,
      status: exceeds ? "failed" : "passed",
      message:
        `"${identity.scorerId}" pass rate ${baseSummary.passRate} -> ` +
        `${subjectSummary.passRate} (drop ${drop})`,
      observed: drop,
      threshold,
      scorerId: identity.scorerId,
    });
  }

  if (partials.length === 0) {
    return nonGateable(
      condition,
      "EMPTY_COUNTABLE_EVIDENCE",
      "no gating scorer evidence is available to compare pass rates",
      { threshold }
    );
  }
  const status = foldConditionStatuses(partials.map((row) => row.status));
  const representative =
    partials.find((row) => row.status === status) ?? partials[0];
  return {
    ...representative,
    message:
      status === "passed"
        ? partials.length === 1
          ? representative.message
          : `${partials.length} gating scorer(s) stayed within the pass-rate drop`
        : representative.message,
  };
}

function comparativeBaselineBlock(
  policy: SuiteGatePolicyV1,
  evidence: SuiteGateEvidenceV1,
  threshold?: number,
  condition: SuiteGateConditionName = "maximumPassRateDrop"
): SuiteGateConditionVerdictV1 | null {
  const extras = threshold === undefined ? {} : { threshold };
  if (policy.baseline === undefined) {
    return nonGateable(
      condition,
      "COMPARATIVE_WITHOUT_BASELINE",
      "comparative suite-gate conditions require a baseline selector",
      extras
    );
  }
  if (policy.baseline.kind === "previous_completed") {
    return nonGateable(
      condition,
      "PREVIOUS_COMPLETED_UNSUPPORTED",
      'baseline kind "previous_completed" is reserved and cannot be resolved yet',
      extras
    );
  }
  const baseline = evidence.baseline;
  if (!baseline || baseline.resolved !== true || !baseline.run) {
    return nonGateable(
      condition,
      "BASELINE_UNRESOLVED",
      "no comparable baseline is available for this condition",
      extras
    );
  }
  const baseBlocked = subjectBlockingReason(baseline.run);
  if (baseBlocked) {
    return nonGateable(
      condition,
      baseBlocked,
      `baseline ${blockingMessage(baseBlocked)}`,
      extras
    );
  }
  const population = populationIncompatible(baseline);
  if (population) {
    return nonGateable(
      condition,
      population,
      population === "POPULATION_INCOMPATIBLE"
        ? "the two runs do not cover the same population, so rates are not comparable"
        : population === "QUARANTINED"
          ? "quarantined cases remain in the population, so the comparison is not comparable"
          : population === "CONFIGURED_WEIGHTS_MISMATCH"
            ? "configured case/variant trial weights do not match"
            : "observed case/variant trial weights do not match",
      extras
    );
  }
  return null;
}

function evaluateDeterministicRegressions(
  policy: SuiteGatePolicyV1,
  evidence: SuiteGateEvidenceV1
): SuiteGateConditionVerdictV1 {
  const condition = "noDeterministicRegressions";
  const blocked = subjectBlockingReason(evidence.subject);
  if (blocked) {
    return nonGateable(condition, blocked, blockingMessage(blocked));
  }
  const baselineBlock = comparativeBaselineBlock(
    policy,
    evidence,
    undefined,
    condition
  );
  if (baselineBlock) return { ...baselineBlock, condition };
  const baseline = evidence.baseline as SuiteGateBaselineEvidenceV1;
  const baseRun = baseline.run as SuiteGateRunEvidenceV1;
  if (!integrityGateable(evidence.subject.scoreIntegrity)) {
    return nonGateable(
      condition,
      "INTEGRITY_UNVERIFIED",
      integrityMessage(evidence.subject.scoreIntegrity, "subject")
    );
  }
  if (!integrityGateable(baseRun.scoreIntegrity)) {
    return nonGateable(
      condition,
      "INTEGRITY_UNVERIFIED",
      integrityMessage(baseRun.scoreIntegrity, "baseline")
    );
  }
  if (
    gatingIdentities(evidence.subject).some((row) => row.idSource === "generated") ||
    gatingIdentities(baseRun).some((row) => row.idSource === "generated")
  ) {
    return nonGateable(
      condition,
      "GENERATED_SCORER_ID",
      "a gating scorer has a generated, positional id, so a per-scorer regression cannot be gated on"
    );
  }
  if (baseline.scoreDeltasAvailable !== true) {
    return nonGateable(
      condition,
      "SCORE_DELTAS_UNAVAILABLE",
      "this comparison carries no per-case score deltas, so a deterministic regression cannot be identified"
    );
  }
  const regressions = baseline.deterministicScoreRegressions ?? [];
  return {
    condition,
    status: regressions.length === 0 ? "passed" : "failed",
    message:
      regressions.length === 0
        ? "no deterministic gating scorer regressed"
        : `${regressions.length} deterministic gating regression(s): ` +
          regressions
            .map((row) => `${row.caseKey}/${row.scorerId}`)
            .join(", "),
    observed: regressions.length,
  };
}

function evaluateLatencyIncrease(
  policy: SuiteGatePolicyV1,
  evidence: SuiteGateEvidenceV1
): SuiteGateConditionVerdictV1 {
  const condition = "maximumP95LatencyIncreaseMs";
  const threshold = policy.maximumP95LatencyIncreaseMs as number;
  const blocked = subjectBlockingReason(evidence.subject);
  if (blocked) {
    return nonGateable(condition, blocked, blockingMessage(blocked), {
      threshold,
    });
  }
  const baselineBlock = comparativeBaselineBlock(
    policy,
    evidence,
    threshold,
    condition
  );
  if (baselineBlock) return baselineBlock;
  const baseRun = evidence.baseline?.run as SuiteGateRunEvidenceV1;
  const baseMs = baseRun.e2eP95Ms;
  const subjectMs = evidence.subject.e2eP95Ms;
  if (baseMs === undefined || subjectMs === undefined) {
    return nonGateable(
      condition,
      "LATENCY_UNMEASURED",
      `no p95 latency on ${baseMs === undefined ? "the baseline" : "the subject"} run, so an increase cannot be measured`,
      { threshold }
    );
  }
  const increase = subjectMs - baseMs;
  return {
    condition,
    status: increase <= threshold ? "passed" : "failed",
    message:
      `p95 e2e latency ${baseMs}ms -> ${subjectMs}ms ` +
      `(${increase >= 0 ? "+" : ""}${increase}ms)`,
    observed: increase,
    threshold,
  };
}

/**
 * Evaluate a stored suite policy against already-gathered evidence.
 *
 * PURE. The caller (B1b's DB helper, later the CLI) is responsible for
 * resolving a baseline and proving the evidence snapshot is complete. This
 * function never fetches.
 *
 * A malformed policy or evidence document is `non_gateable` with
 * `policyError` set — it is never treated as `not_configured`.
 */
export function evaluateSuiteGateEvidence(input: {
  policy: unknown;
  evidence: unknown;
}): SuiteGateReportV1 {
  const parsedPolicy = parseSuiteGatePolicyForRead(input.policy);
  if (!parsedPolicy.ok) {
    return emptyReport(
      {},
      "non_gateable",
      {
        policyError: {
          reason: parsedPolicy.reason,
          message: parsedPolicy.message,
        },
      }
    );
  }
  const policy = parsedPolicy.policy;
  const parsedEvidence = suiteGateEvidenceSchema.safeParse(input.evidence);
  if (!parsedEvidence.success) {
    return emptyReport(policy, "non_gateable", {
      policyError: {
        reason: "EVIDENCE_MALFORMED",
        message:
          parsedEvidence.error.issues[0]?.message ??
          "suite gate evidence is malformed",
      },
    });
  }
  const evidence = parsedEvidence.data;
  const active = suiteGateActiveConditions(policy);
  if (active.length === 0) {
    return emptyReport(policy, "not_configured");
  }

  const conditions: SuiteGateConditionVerdictV1[] = [];
  if (active.includes("noGatingScoreErrors")) {
    conditions.push(evaluateNoGatingScoreErrors(evidence.subject));
  }
  if (active.includes("maximumPassRateDrop")) {
    conditions.push(evaluatePassRateDrop(policy, evidence));
  }
  if (active.includes("noDeterministicRegressions")) {
    conditions.push(evaluateDeterministicRegressions(policy, evidence));
  }
  if (active.includes("maximumP95LatencyIncreaseMs")) {
    conditions.push(evaluateLatencyIncrease(policy, evidence));
  }

  return {
    schemaVersion: SUITE_GATE_SCHEMA_VERSION,
    evaluatorVersion: SUITE_GATE_EVALUATOR_VERSION,
    policy,
    policyHash: parsedPolicy.hash,
    outcome: foldOutcome(conditions),
    conditions,
  };
}

// ── CI composition ───────────────────────────────────────────────────────────

export const SUITE_GATE_COMPOSED_OUTCOMES = [
  "passed",
  "failed",
  "incomplete",
  "waived",
  "usage_error",
  "unavailable",
] as const;
export type SuiteGateComposedOutcome =
  (typeof SUITE_GATE_COMPOSED_OUTCOMES)[number];

/**
 * The flag/base report as composition sees it.
 *
 * Structural subset of `GateReport` plus `unavailable` for a missing or
 * nonterminal base. Kept here so `@mcpjam/sdk/contract` does not import
 * `gates.ts` (and the adapters that file pulls in).
 */
export type SuiteGateBaseReportInput = {
  outcome:
    | "passed"
    | "failed"
    | "incomplete"
    | "usage_error"
    | "waived"
    | "unavailable";
  waiver?: SuiteGateWaiverInput;
};

export type SuiteGateWaiverInput = {
  id: string;
  reason: string;
  expiresAt: number;
  createdAt: number;
  createdBy: string;
  createdByEmail: string | null;
  policySnapshot: { minimumPassRate: number } | null;
};

export type SuiteGateComposedReportV1 = {
  outcome: SuiteGateComposedOutcome;
  base: SuiteGateBaseReportInput;
  suite: SuiteGateReportV1;
};

function waiverInForce(
  waiver: SuiteGateWaiverInput,
  now: number
): boolean {
  return waiver.expiresAt > now;
}

/**
 * Same rules as `applyGateWaiver` in `gates.ts`: only a measured `failed`
 * becomes `waived`; incomplete / usage_error / passed keep their outcome
 * and merely attach the waiver.
 */
function applyBaseWaiver(
  base: SuiteGateBaseReportInput,
  waiver: SuiteGateWaiverInput | null | undefined,
  now: number
): SuiteGateBaseReportInput {
  if (!waiver || !waiverInForce(waiver, now)) return base;
  if (base.outcome !== "failed") return { ...base, waiver };
  return { ...base, outcome: "waived", waiver };
}

function composeOutcomes(
  base: SuiteGateBaseReportInput["outcome"],
  suite: SuiteGateOutcomeV1
): SuiteGateComposedOutcome {
  if (base === "unavailable") return "unavailable";
  if (base === "usage_error") return "usage_error";
  if (base === "failed") return "failed";
  if (base === "incomplete") return "incomplete";
  // passed | waived
  if (suite === "failed") return "failed";
  if (suite === "non_gateable") return "incomplete";
  return base;
}

/**
 * Compose the existing flag/base report with the suite-gate report.
 *
 * Order is load-bearing:
 *
 *   1. Apply the run's waiver to the BASE report only.
 *   2. Fold the suite-gate report as a separate, unwaived section.
 *
 * A waived or passed base plus a failed suite condition fails; plus
 * `non_gateable` is incomplete; plus `passed` / `not_configured` preserves
 * the base result, including the waived label. An unwaived measured base
 * failure stays failed. An unavailable base stays unavailable and cannot
 * be greened.
 */
export function composeSuiteGateWithBaseReport(input: {
  base: SuiteGateBaseReportInput;
  suite: SuiteGateReportV1;
  waiver?: SuiteGateWaiverInput | null;
  now?: number;
}): SuiteGateComposedReportV1 {
  const base = applyBaseWaiver(input.base, input.waiver, input.now ?? Date.now());
  return {
    outcome: composeOutcomes(base.outcome, input.suite.outcome),
    base,
    suite: input.suite,
  };
}
