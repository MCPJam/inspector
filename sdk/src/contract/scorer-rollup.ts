/**
 * The versioned **per-run scorer rollup** contract — one document that
 * records each scorer's countable denominators and the identities a trend
 * is allowed to compare.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * It is the CONTRACT and a set of PURE helpers. There is no network, no
 * Convex, no materializer, no UI derivation. R2-B1 mirrors these shapes
 * and calls the same identity / parity helpers; R2-B2 renders what the
 * backend returns.
 *
 * Two rules follow the same discipline as `./verdict-policy.ts` and
 * `./suite-gate.ts`:
 *
 *  1. **No `.default()` anywhere.** An omitted field stays omitted, so a
 *     payload is byte-stable through `canonicalJson`.
 *  2. **Every object declared here is `.strict()`.** Unknown fields are
 *     errors, matching Convex `v.object`. That is also what makes an
 *     invented `measured` field or a `caseKey` on the configured-trial
 *     snapshot unrepresentable.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * D4: per-scorer analytics are materialized per run, never a second stage
 * funnel. Each entry is keyed by `(scorerId, definitionHash)` and carries
 * explicit `countable` / `passed` / `failed` / `errors` / `skipped` /
 * `notApplicable` counts plus `passRate` and `meanValue`. There is no
 * `measured` field. Stage rates remain exclusively
 * `EvalStageAnalyticsV1`.
 *
 * D10: a trend is a claim that two runs measured the **same scorer** over
 * the **same configured and observed population**, under the **same
 * frozen execution**. {@link scorerRollupParityBlockers} is that claim.
 * Drawing two points on one sparkline IS the claim, so an incompatible
 * pair must stay two standalone observations.
 *
 * ── Identity, not approximation ──────────────────────────────────────────────
 *
 * Every digest is SHA-256 over the **full normalized snapshot** the
 * document already carries. {@link scorerRollupConfiguredTrialFingerprint}
 * hashes {@link normalizeScorerRollupConfiguredTrials}; the execution and
 * observed-population fingerprints do the same for their snapshots. The
 * refined schema refuses a fingerprint that does not match, so a later
 * materializer cannot hash an undocumented subset and still parse.
 *
 * `caseKey` is not a field of the configured-trial snapshot. Identity is
 * `caseId` plus `executionVariant`.
 *
 * `executionFingerprint` is built from frozen host/harness
 * configuration/version, the actual effective model/provider per variant,
 * server/environment configuration identity, and relevant execution
 * overrides. An `environmentId` or named host id ALONE is not proof of
 * equality and is never substituted for those frozen facts. If a required
 * dimension was not recorded, a named blocker is returned and the
 * standalone point stays visible.
 *
 * `runGroupId` is diagnostic context, not a substitute for execution
 * identity.
 *
 * ── Rates ────────────────────────────────────────────────────────────────────
 *
 * Rates are fractions in [0, 1] or `null`. `null` means unmeasured
 * (zero denominator), never `0`. A genuine measured `0/4` is `0`.
 */

import { z } from "zod";
import { canonicalDigest } from "./canonical.js";
import { predicateScopeSchema } from "../predicates/types.js";
import {
  evalStageAnalyticsMaterializationStateSchema,
  type EvalStageAnalyticsMaterializationState,
} from "./stage-analytics.js";
import { MAX_REPETITIONS } from "./suite-file.js";
import { scorerIdSourceSchema, scorerRoleSchema } from "./schemas.js";
import {
  evalExecutionVariantSchema,
  evalFractionSchema,
  type EvalExecutionVariant,
} from "./verdict-policy.js";

/** Rollup / wire version, as a literal. Absence is not v1. */
export const SCORER_ROLLUP_SCHEMA_VERSION = 1;
export type ScorerRollupSchemaVersion = typeof SCORER_ROLLUP_SCHEMA_VERSION;
export const scorerRollupSchemaVersionSchema = z.literal(
  SCORER_ROLLUP_SCHEMA_VERSION
);

/**
 * Identity / counting semantics version stamped on every document.
 *
 * Bumped only when comparison SEMANTICS change. A fixture corpus pins this
 * number so a silently rewritten helper cannot claim the same identities.
 */
export const SCORER_ROLLUP_SOURCE_VERSION = 1;
export type ScorerRollupSourceVersion = typeof SCORER_ROLLUP_SOURCE_VERSION;
export const scorerRollupSourceVersionSchema = z.literal(
  SCORER_ROLLUP_SOURCE_VERSION
);

/** The `$id` of the published JSON Schema for this contract (when generated). */
export const SCORER_ROLLUP_SCHEMA_ID =
  "https://mcpjam.com/schemas/scorer-rollup/v1.json";

/**
 * How many scorer entries one document may retain.
 *
 * A 500-check suite must not write an unbounded row. When the cap bites it
 * is RECORDED — see {@link EvalScorerRollupV1.truncation}. A truncated
 * document is not comparable.
 */
export const MAX_SCORER_ROLLUP_ENTRIES = 200;

const countSchema = z.number().int().min(0);
const configuredTrialsCountSchema = z.number().int().min(1).max(MAX_REPETITIONS);

// ── configured trial identity ────────────────────────────────────────────────

/**
 * One configured (case × variant) weight from the frozen
 * `verdictPolicySnapshot.expectedTrials`.
 *
 * `caseKey` is deliberately absent: hosted iteration rows may still carry
 * one, but this snapshot is `caseId` plus the canonical execution variant.
 * A later materializer that cannot prove that mapping fails comparison
 * rather than inventing a key.
 */
export const scorerRollupConfiguredTrialSchema = z
  .object({
    caseId: z.string().min(1),
    executionVariant: evalExecutionVariantSchema.optional(),
    configuredTrials: configuredTrialsCountSchema,
    effectivePassThreshold: evalFractionSchema,
  })
  .strict();
export type ScorerRollupConfiguredTrialV1 = z.infer<
  typeof scorerRollupConfiguredTrialSchema
>;

// ── observed population identity ─────────────────────────────────────────────

/**
 * One observed (case × variant) contribution for ONE scorer.
 *
 * Configured repetitions do not imply equal denominators. `countable` /
 * `scored` / `errors` / `skipped` / `notApplicable` and the missing /
 * quarantined exclusions are identity evidence: changing any of them
 * changes the population even when the authored trial plan did not.
 *
 * Missing and quarantined rows are preserved as counts. They do not
 * invent a scored value.
 */
export const scorerRollupObservedWeightSchema = z
  .object({
    caseId: z.string().min(1),
    executionVariant: evalExecutionVariantSchema.optional(),
    countable: countSchema,
    scored: countSchema,
    errors: countSchema,
    skipped: countSchema,
    notApplicable: countSchema,
    missing: countSchema.optional(),
    quarantined: countSchema.optional(),
  })
  .strict();
export type ScorerRollupObservedWeightV1 = z.infer<
  typeof scorerRollupObservedWeightSchema
>;

// ── execution identity ───────────────────────────────────────────────────────

/**
 * Frozen host / harness configuration. Kind or a named host id without
 * `version` and `configurationDigest` is not this object — omit it and
 * take the named blocker.
 */
export const scorerRollupHostHarnessIdentitySchema = z
  .object({
    kind: z.string().min(1),
    version: z.string().min(1),
    configurationDigest: z.string().min(1),
  })
  .strict();
export type ScorerRollupHostHarnessIdentityV1 = z.infer<
  typeof scorerRollupHostHarnessIdentitySchema
>;

/**
 * The model/provider that actually executed one variant.
 *
 * This is the effective pair, not the suite-file default and not today's
 * live environment row. `environmentId` is not a field here.
 */
export const scorerRollupEffectiveModelIdentitySchema = z
  .object({
    executionVariant: evalExecutionVariantSchema.optional(),
    model: z.string().min(1),
    provider: z.string().min(1).optional(),
    configurationDigest: z.string().min(1).optional(),
  })
  .strict();
export type ScorerRollupEffectiveModelIdentityV1 = z.infer<
  typeof scorerRollupEffectiveModelIdentitySchema
>;

/**
 * Frozen server / environment *configuration* identity.
 *
 * `environmentId` is a label. The load-bearing field is
 * `configurationDigest` over the frozen server/environment snapshot.
 * Re-reading today's environment row to fill a historical document is
 * forbidden — omit this object and take the named blocker.
 */
export const scorerRollupServerEnvironmentIdentitySchema = z
  .object({
    environmentId: z.string().min(1).optional(),
    configurationDigest: z.string().min(1),
  })
  .strict();
export type ScorerRollupServerEnvironmentIdentityV1 = z.infer<
  typeof scorerRollupServerEnvironmentIdentitySchema
>;

/**
 * Immutable execution identity for one run.
 *
 * `environmentId` and `namedHostId` are diagnostic context. They travel
 * WITH the frozen facts and never INSTEAD OF them. {@link
 * scorerRollupExecutionFingerprint} hashes this whole object after
 * {@link normalizeScorerRollupExecutionIdentity}; it does not collapse
 * to `environmentId || namedHostId`.
 */
export const scorerRollupExecutionIdentitySchema = z
  .object({
    environmentId: z.string().min(1).optional(),
    namedHostId: z.string().min(1).optional(),
    hostHarness: scorerRollupHostHarnessIdentitySchema.optional(),
    effectiveModels: z
      .array(scorerRollupEffectiveModelIdentitySchema)
      .optional(),
    serverEnvironment: scorerRollupServerEnvironmentIdentitySchema.optional(),
    executionOverridesDigest: z.string().min(1).optional(),
  })
  .strict();
export type ScorerRollupExecutionIdentityV1 = z.infer<
  typeof scorerRollupExecutionIdentitySchema
>;

/**
 * Frozen execution dimensions a comparison requires to be PRESENT.
 *
 * An unknown identity is not a matching one: two runs that both record
 * only `environmentId` compare equal under a naive `a === b` while
 * sharing no frozen host, model, or server configuration at all.
 */
export const SCORER_ROLLUP_FROZEN_EXECUTION_DIMENSIONS = [
  "hostHarness",
  "effectiveModels",
  "serverEnvironment",
] as const;
export type ScorerRollupFrozenExecutionDimension =
  (typeof SCORER_ROLLUP_FROZEN_EXECUTION_DIMENSIONS)[number];

// ── truncation ───────────────────────────────────────────────────────────────

export const scorerRollupTruncationSchema = z
  .object({
    retained: z.number().int().min(0).max(MAX_SCORER_ROLLUP_ENTRIES),
    omitted: z.number().int().min(1),
    total: z.number().int().min(1),
  })
  .strict();
export type ScorerRollupTruncationV1 = z.infer<
  typeof scorerRollupTruncationSchema
>;

// ── entry ────────────────────────────────────────────────────────────────────

/**
 * One scorer's rollup inside the run document.
 *
 * Keyed conceptually by `(scorerId, definitionHash)`. `countable` is the
 * pass-rate denominator and excludes `notApplicable` only. `meanValue`
 * is over scored values; it is `null` when nothing was scored. There is
 * no `measured` field.
 */
export const scorerRollupEntryStructuralSchema = z
  .object({
    scorerId: z.string().min(1),
    definitionHash: z.string().min(1),
    idSource: scorerIdSourceSchema,
    role: scorerRoleSchema,
    deterministic: z.boolean(),
    passThreshold: evalFractionSchema,
    scope: predicateScopeSchema.optional(),
    /** Sanitized criterion text when one exists. Never a raw predicate. */
    criterion: z.string().min(1).optional(),
    countable: countSchema,
    passed: countSchema,
    failed: countSchema,
    errors: countSchema,
    skipped: countSchema,
    notApplicable: countSchema,
    passRate: evalFractionSchema.nullable(),
    meanValue: evalFractionSchema.nullable(),
    observedPopulation: z.array(scorerRollupObservedWeightSchema),
    observedPopulationFingerprint: z.string().min(1),
  })
  .strict();
export type ScorerRollupEntryV1 = z.infer<
  typeof scorerRollupEntryStructuralSchema
>;

// ── document ─────────────────────────────────────────────────────────────────

export const evalScorerRollupStructuralSchema = z
  .object({
    schemaVersion: scorerRollupSchemaVersionSchema,
    sourceVersion: scorerRollupSourceVersionSchema,
    suiteId: z.string().min(1),
    runId: z.string().min(1),
    /**
     * Diagnostic grouping context (a matrix, a schedule).
     *
     * NOT a substitute for {@link EvalScorerRollupV1.executionFingerprint}.
     * Two runs that share a group and differ on frozen host/model/server
     * facts are not comparable; two runs that differ on group and agree
     * on every required identity still are.
     */
    runGroupId: z.string().min(1).optional(),
    /**
     * Authored-configuration revision frozen at run start.
     *
     * Absent BLOCKS parity rather than being assumed compatible.
     */
    configRevision: z.string().min(1).optional(),
    /**
     * Digest over the comparable case set this scorer document claims.
     *
     * Distinct from the stage-analytics inclusion set: this fingerprint
     * is the scorer's declared contributor population, not the funnel's
     * included-trial set. Absent BLOCKS parity.
     */
    caseSetFingerprint: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    runCompletedAt: z.number().int().min(0).optional(),
    sourceIterationCount: countSchema,
    sourceMaxUpdatedAt: z.number().int().min(0).optional(),
    generation: z.number().int().min(0).optional(),
    materializationState: evalStageAnalyticsMaterializationStateSchema,
    /**
     * Score-integrity verdict for the source run. Absent is not valid.
     */
    scoreIntegrity: z.enum(["valid", "invalid"]).optional(),
    configuredTrials: z.array(scorerRollupConfiguredTrialSchema),
    configuredTrialFingerprint: z.string().min(1),
    execution: scorerRollupExecutionIdentitySchema,
    executionFingerprint: z.string().min(1),
    entries: z
      .array(scorerRollupEntryStructuralSchema)
      .max(MAX_SCORER_ROLLUP_ENTRIES),
    /**
     * Present ONLY when the entry cap bit. A truncated array with no
     * such record reads as "these are all the scorers".
     */
    truncation: scorerRollupTruncationSchema.optional(),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
  })
  .strict();

export const evalScorerRollupSchema =
  evalScorerRollupStructuralSchema.superRefine((row, ctx) => {
    const expectedConfigured = scorerRollupConfiguredTrialFingerprint(
      row.configuredTrials
    );
    if (row.configuredTrialFingerprint !== expectedConfigured) {
      ctx.addIssue({
        code: "custom",
        path: ["configuredTrialFingerprint"],
        message:
          "configuredTrialFingerprint is not the digest of the normalized configuredTrials snapshot",
      });
    }

    const expectedExecution = scorerRollupExecutionFingerprint(row.execution);
    if (row.executionFingerprint !== expectedExecution) {
      ctx.addIssue({
        code: "custom",
        path: ["executionFingerprint"],
        message:
          "executionFingerprint is not the digest of the normalized execution snapshot",
      });
    }

    const seen = new Set<string>();
    for (const [index, entry] of row.entries.entries()) {
      const key = scorerRollupEntryKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index],
          message: `duplicate scorer entry ${key}: entries are keyed by (scorerId, definitionHash)`,
        });
      }
      seen.add(key);

      if (
        entry.passed + entry.failed + entry.errors + entry.skipped !==
        entry.countable
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "countable"],
          message:
            `countable ${entry.countable} is not passed ${entry.passed} + ` +
            `failed ${entry.failed} + errors ${entry.errors} + skipped ${entry.skipped}`,
        });
      }

      const expectedRate = passRateOf(entry);
      if (entry.passRate !== expectedRate) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "passRate"],
          message:
            entry.countable === 0
              ? "passRate must be null when countable is 0 (unmeasured is not 0)"
              : `passRate ${entry.passRate} is not ${entry.passed}/${entry.countable} (${expectedRate})`,
        });
      }

      if (entry.passed + entry.failed === 0 && entry.meanValue !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "meanValue"],
          message:
            "meanValue must be null when no observation was scored (unmeasured is not 0)",
        });
      }

      const expectedObserved = scorerRollupObservedPopulationFingerprint(
        entry.observedPopulation
      );
      if (entry.observedPopulationFingerprint !== expectedObserved) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "observedPopulationFingerprint"],
          message:
            "observedPopulationFingerprint is not the digest of the normalized observedPopulation snapshot",
        });
      }
    }

    if (row.truncation) {
      if (row.truncation.retained !== row.entries.length) {
        ctx.addIssue({
          code: "custom",
          path: ["truncation", "retained"],
          message:
            `truncation.retained ${row.truncation.retained} does not match ` +
            `${row.entries.length} stored entries`,
        });
      }
      if (row.truncation.retained + row.truncation.omitted !== row.truncation.total) {
        ctx.addIssue({
          code: "custom",
          path: ["truncation", "total"],
          message:
            `truncation.total ${row.truncation.total} is not retained ` +
            `${row.truncation.retained} + omitted ${row.truncation.omitted}`,
        });
      }
    }
  });
export type EvalScorerRollupV1 = z.infer<typeof evalScorerRollupStructuralSchema>;

export type ScorerRollupScoreIntegrity = NonNullable<
  EvalScorerRollupV1["scoreIntegrity"]
>;
export type { EvalStageAnalyticsMaterializationState as ScorerRollupMaterializationState };

// ── rates ────────────────────────────────────────────────────────────────────

/**
 * Pass-rate denominator: everything that is not `not_applicable`.
 *
 * Named `countable` on purpose. There is no `measured` field on this
 * contract; a consumer that wants "how many were scored" reads
 * `passed + failed`.
 */
export function countableOf(counts: {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}): number {
  return counts.passed + counts.failed + counts.errors + counts.skipped;
}

/**
 * `passed / countable`, or `null` when `countable` is 0.
 *
 * A zero denominator is unmeasured, never a rate of `0`.
 */
export function passRateOf(counts: {
  passed: number;
  countable: number;
}): number | null {
  if (counts.countable === 0) return null;
  return counts.passed / counts.countable;
}

/**
 * Mean of scored values, or `null` when nothing was scored.
 *
 * Unmeasured is `null`, never `0`.
 */
export function meanValueOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function scorerRollupEntryKey(entry: {
  scorerId: string;
  definitionHash: string;
}): string {
  return `${entry.scorerId}\0${entry.definitionHash}`;
}

// ── normalize / digest ───────────────────────────────────────────────────────

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function variantSortKey(variant: EvalExecutionVariant | undefined): string {
  if (!variant) return "";
  return `${variant.provider ?? ""}\0${variant.model}`;
}

function normalizeVariant(
  variant: EvalExecutionVariant | undefined
): EvalExecutionVariant | undefined {
  if (!variant) return undefined;
  const normalized: EvalExecutionVariant = { model: variant.model };
  if (variant.provider !== undefined) normalized.provider = variant.provider;
  return normalized;
}

function compareCaseVariant(
  left: { caseId: string; executionVariant?: EvalExecutionVariant },
  right: { caseId: string; executionVariant?: EvalExecutionVariant }
): number {
  const byCase = compareStrings(left.caseId, right.caseId);
  if (byCase !== 0) return byCase;
  return compareStrings(
    variantSortKey(left.executionVariant),
    variantSortKey(right.executionVariant)
  );
}

/**
 * Full canonical configured-trial snapshot.
 *
 * Sorted by `caseId`, then execution variant, then the remaining identity
 * fields so a permutation of the input cannot change the digest. Duplicates
 * are kept: collapsing two rows that share a case/variant would hide a
 * real identity difference.
 */
export function normalizeScorerRollupConfiguredTrials(
  rows: readonly ScorerRollupConfiguredTrialV1[]
): ScorerRollupConfiguredTrialV1[] {
  return rows
    .map((row) => {
      const normalized: ScorerRollupConfiguredTrialV1 = {
        caseId: row.caseId,
        configuredTrials: row.configuredTrials,
        effectivePassThreshold: row.effectivePassThreshold,
      };
      const variant = normalizeVariant(row.executionVariant);
      if (variant) normalized.executionVariant = variant;
      return normalized;
    })
    .sort((left, right) => {
      const byIdentity = compareCaseVariant(left, right);
      if (byIdentity !== 0) return byIdentity;
      if (left.configuredTrials !== right.configuredTrials) {
        return left.configuredTrials - right.configuredTrials;
      }
      return left.effectivePassThreshold - right.effectivePassThreshold;
    });
}

/** @see normalizeScorerRollupConfiguredTrials */
export function scorerRollupConfiguredTrialIdentity(
  rows: readonly ScorerRollupConfiguredTrialV1[]
): ScorerRollupConfiguredTrialV1[] {
  return normalizeScorerRollupConfiguredTrials(rows);
}

export function scorerRollupConfiguredTrialFingerprint(
  rows: readonly ScorerRollupConfiguredTrialV1[]
): string {
  return canonicalDigest(normalizeScorerRollupConfiguredTrials(rows));
}

/**
 * Full canonical observed-population snapshot for one scorer.
 *
 * Same sort discipline as configured trials. Optional `missing` /
 * `quarantined` stay omitted when absent so `0` and absent remain
 * distinguishable at the wire layer and digest identically only when
 * both sides omitted them (canonical JSON drops `undefined`).
 */
export function normalizeScorerRollupObservedPopulation(
  rows: readonly ScorerRollupObservedWeightV1[]
): ScorerRollupObservedWeightV1[] {
  return rows
    .map((row) => {
      const normalized: ScorerRollupObservedWeightV1 = {
        caseId: row.caseId,
        countable: row.countable,
        scored: row.scored,
        errors: row.errors,
        skipped: row.skipped,
        notApplicable: row.notApplicable,
      };
      const variant = normalizeVariant(row.executionVariant);
      if (variant) normalized.executionVariant = variant;
      if (row.missing !== undefined) normalized.missing = row.missing;
      if (row.quarantined !== undefined) normalized.quarantined = row.quarantined;
      return normalized;
    })
    .sort((left, right) => {
      const byIdentity = compareCaseVariant(left, right);
      if (byIdentity !== 0) return byIdentity;
      if (left.countable !== right.countable) return left.countable - right.countable;
      if (left.scored !== right.scored) return left.scored - right.scored;
      if (left.errors !== right.errors) return left.errors - right.errors;
      if (left.skipped !== right.skipped) return left.skipped - right.skipped;
      if (left.notApplicable !== right.notApplicable) {
        return left.notApplicable - right.notApplicable;
      }
      const leftMissing = left.missing ?? -1;
      const rightMissing = right.missing ?? -1;
      if (leftMissing !== rightMissing) return leftMissing - rightMissing;
      return (left.quarantined ?? -1) - (right.quarantined ?? -1);
    });
}

/** @see normalizeScorerRollupObservedPopulation */
export function scorerRollupObservedPopulationIdentity(
  rows: readonly ScorerRollupObservedWeightV1[]
): ScorerRollupObservedWeightV1[] {
  return normalizeScorerRollupObservedPopulation(rows);
}

export function scorerRollupObservedPopulationFingerprint(
  rows: readonly ScorerRollupObservedWeightV1[]
): string {
  return canonicalDigest(normalizeScorerRollupObservedPopulation(rows));
}

function normalizeEffectiveModel(
  row: ScorerRollupEffectiveModelIdentityV1
): ScorerRollupEffectiveModelIdentityV1 {
  const normalized: ScorerRollupEffectiveModelIdentityV1 = { model: row.model };
  const variant = normalizeVariant(row.executionVariant);
  if (variant) normalized.executionVariant = variant;
  if (row.provider !== undefined) normalized.provider = row.provider;
  if (row.configurationDigest !== undefined) {
    normalized.configurationDigest = row.configurationDigest;
  }
  return normalized;
}

/**
 * Full canonical execution snapshot.
 *
 * Diagnostic labels (`environmentId`, `namedHostId`) stay on the object
 * when present — they are part of the documented identity — but they do
 * not replace `hostHarness`, `effectiveModels`, or `serverEnvironment`.
 * Models are sorted so input order cannot change the digest.
 */
export function normalizeScorerRollupExecutionIdentity(
  execution: ScorerRollupExecutionIdentityV1
): ScorerRollupExecutionIdentityV1 {
  const normalized: ScorerRollupExecutionIdentityV1 = {};
  if (execution.environmentId !== undefined) {
    normalized.environmentId = execution.environmentId;
  }
  if (execution.namedHostId !== undefined) {
    normalized.namedHostId = execution.namedHostId;
  }
  if (execution.hostHarness) {
    normalized.hostHarness = {
      kind: execution.hostHarness.kind,
      version: execution.hostHarness.version,
      configurationDigest: execution.hostHarness.configurationDigest,
    };
  }
  if (execution.effectiveModels) {
    normalized.effectiveModels = execution.effectiveModels
      .map(normalizeEffectiveModel)
      .sort((left, right) => {
        const byVariant = compareStrings(
          variantSortKey(left.executionVariant),
          variantSortKey(right.executionVariant)
        );
        if (byVariant !== 0) return byVariant;
        const byProvider = compareStrings(left.provider ?? "", right.provider ?? "");
        if (byProvider !== 0) return byProvider;
        const byModel = compareStrings(left.model, right.model);
        if (byModel !== 0) return byModel;
        return compareStrings(
          left.configurationDigest ?? "",
          right.configurationDigest ?? ""
        );
      });
  }
  if (execution.serverEnvironment) {
    const server: ScorerRollupServerEnvironmentIdentityV1 = {
      configurationDigest: execution.serverEnvironment.configurationDigest,
    };
    if (execution.serverEnvironment.environmentId !== undefined) {
      server.environmentId = execution.serverEnvironment.environmentId;
    }
    normalized.serverEnvironment = server;
  }
  if (execution.executionOverridesDigest !== undefined) {
    normalized.executionOverridesDigest = execution.executionOverridesDigest;
  }
  return normalized;
}

/** @see normalizeScorerRollupExecutionIdentity */
export function scorerRollupExecutionIdentity(
  execution: ScorerRollupExecutionIdentityV1
): ScorerRollupExecutionIdentityV1 {
  return normalizeScorerRollupExecutionIdentity(execution);
}

export function scorerRollupExecutionFingerprint(
  execution: ScorerRollupExecutionIdentityV1
): string {
  return canonicalDigest(normalizeScorerRollupExecutionIdentity(execution));
}

/**
 * Stamp every digest from the snapshots the document already carries.
 *
 * The snapshots are the authority. A caller-supplied fingerprint is
 * overwritten so a later materializer cannot persist an undocumented
 * approximation.
 */
export function stampScorerRollupIdentities<
  T extends {
    configuredTrials: ScorerRollupConfiguredTrialV1[];
    execution: ScorerRollupExecutionIdentityV1;
    entries: Array<
      Omit<ScorerRollupEntryV1, "observedPopulationFingerprint"> & {
        observedPopulationFingerprint?: string;
      }
    >;
  },
>(
  document: T
): T & {
  configuredTrialFingerprint: string;
  executionFingerprint: string;
  entries: ScorerRollupEntryV1[];
} {
  return {
    ...document,
    configuredTrialFingerprint: scorerRollupConfiguredTrialFingerprint(
      document.configuredTrials
    ),
    executionFingerprint: scorerRollupExecutionFingerprint(document.execution),
    entries: document.entries.map((entry) => ({
      ...entry,
      observedPopulationFingerprint: scorerRollupObservedPopulationFingerprint(
        entry.observedPopulation
      ),
    })),
  };
}

// ── comparability ────────────────────────────────────────────────────────────

export const SCORER_ROLLUP_PARITY_BLOCKERS = [
  "missingConfigIdentity",
  "differentConfigIdentity",
  "missingCaseSetIdentity",
  "differentCaseSetIdentity",
  "differentConfiguredTrialIdentity",
  "missingObservedPopulationIdentity",
  "differentObservedPopulationIdentity",
  "missingFrozenHostIdentity",
  "missingFrozenModelIdentity",
  "missingFrozenServerIdentity",
  "differentExecutionIdentity",
  "missingScoreIntegrity",
  "invalidScoreIntegrity",
  "differentDefinition",
  "missingScorer",
  "provisional",
  "truncated",
  "differentSchemaVersion",
  "differentSourceVersion",
] as const;
export type ScorerRollupParityBlocker =
  (typeof SCORER_ROLLUP_PARITY_BLOCKERS)[number];

export function isScorerRollupParityBlocker(
  value: unknown
): value is ScorerRollupParityBlocker {
  return (
    typeof value === "string" &&
    (SCORER_ROLLUP_PARITY_BLOCKERS as readonly string[]).includes(value)
  );
}

function hasFrozenHost(
  execution: ScorerRollupExecutionIdentityV1
): boolean {
  return execution.hostHarness !== undefined;
}

function hasFrozenModels(
  execution: ScorerRollupExecutionIdentityV1
): boolean {
  return (execution.effectiveModels?.length ?? 0) > 0;
}

function hasFrozenServer(
  execution: ScorerRollupExecutionIdentityV1
): boolean {
  return execution.serverEnvironment !== undefined;
}

/**
 * Named blockers for frozen execution dimensions that were not recorded
 * on ONE document.
 *
 * The standalone point stays visible; only comparison is refused.
 * `environmentId` / `namedHostId` never satisfy a required dimension.
 */
export function scorerRollupFrozenExecutionBlockers(
  execution: ScorerRollupExecutionIdentityV1
): ScorerRollupParityBlocker[] {
  const blockers: ScorerRollupParityBlocker[] = [];
  if (!hasFrozenHost(execution)) blockers.push("missingFrozenHostIdentity");
  if (!hasFrozenModels(execution)) blockers.push("missingFrozenModelIdentity");
  if (!hasFrozenServer(execution)) blockers.push("missingFrozenServerIdentity");
  return blockers;
}

export type ScorerRollupParityKey = {
  scorerId: string;
  definitionHash?: string;
};

function pushUnique(
  blockers: ScorerRollupParityBlocker[],
  blocker: ScorerRollupParityBlocker
): void {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function compareOptionalIdentity(
  left: string | undefined,
  right: string | undefined,
  missing: ScorerRollupParityBlocker,
  different: ScorerRollupParityBlocker,
  blockers: ScorerRollupParityBlocker[]
): void {
  if (left === undefined || right === undefined) {
    pushUnique(blockers, missing);
    return;
  }
  if (left !== right) pushUnique(blockers, different);
}

/**
 * Why two rollup documents cannot share a trend line.
 *
 * Returns the blockers; empty means yes, they measured comparable things.
 * Every required identity must be PRESENT AND EQUAL. An unknown identity
 * is not a matching one.
 *
 * When `key` is omitted, every entry on either side is compared by
 * `scorerId` (definition drift is `differentDefinition`; a scorer present
 * on only one side is `missingScorer`). When `key` is supplied, only that
 * scorer is joined — the rest of the document-level identities still apply.
 */
export function scorerRollupParityBlockers(
  a: EvalScorerRollupV1,
  b: EvalScorerRollupV1,
  key?: ScorerRollupParityKey
): ScorerRollupParityBlocker[] {
  const blockers: ScorerRollupParityBlocker[] = [];

  if (a.schemaVersion !== b.schemaVersion) {
    pushUnique(blockers, "differentSchemaVersion");
  }
  if (a.sourceVersion !== b.sourceVersion) {
    pushUnique(blockers, "differentSourceVersion");
  }

  compareOptionalIdentity(
    a.configRevision,
    b.configRevision,
    "missingConfigIdentity",
    "differentConfigIdentity",
    blockers
  );
  compareOptionalIdentity(
    a.caseSetFingerprint,
    b.caseSetFingerprint,
    "missingCaseSetIdentity",
    "differentCaseSetIdentity",
    blockers
  );

  if (a.configuredTrialFingerprint !== b.configuredTrialFingerprint) {
    pushUnique(blockers, "differentConfiguredTrialIdentity");
  }

  for (const blocker of scorerRollupFrozenExecutionBlockers(a.execution)) {
    pushUnique(blockers, blocker);
  }
  for (const blocker of scorerRollupFrozenExecutionBlockers(b.execution)) {
    pushUnique(blockers, blocker);
  }
  if (a.executionFingerprint !== b.executionFingerprint) {
    pushUnique(blockers, "differentExecutionIdentity");
  }

  if (a.scoreIntegrity === undefined || b.scoreIntegrity === undefined) {
    pushUnique(blockers, "missingScoreIntegrity");
  } else if (a.scoreIntegrity !== "valid" || b.scoreIntegrity !== "valid") {
    pushUnique(blockers, "invalidScoreIntegrity");
  }

  if (
    a.materializationState === "provisional" ||
    b.materializationState === "provisional"
  ) {
    pushUnique(blockers, "provisional");
  }
  if (a.truncation !== undefined || b.truncation !== undefined) {
    pushUnique(blockers, "truncated");
  }

  const leftEntries = key
    ? a.entries.filter((entry) => entry.scorerId === key.scorerId)
    : a.entries;
  const rightEntries = key
    ? b.entries.filter((entry) => entry.scorerId === key.scorerId)
    : b.entries;

  if (key && (leftEntries.length === 0 || rightEntries.length === 0)) {
    pushUnique(blockers, "missingScorer");
  }

  const rightById = new Map<string, ScorerRollupEntryV1[]>();
  for (const entry of rightEntries) {
    const list = rightById.get(entry.scorerId) ?? [];
    list.push(entry);
    rightById.set(entry.scorerId, list);
  }
  const seenIds = new Set<string>();
  for (const entry of leftEntries) {
    seenIds.add(entry.scorerId);
    const matches = rightById.get(entry.scorerId) ?? [];
    if (matches.length === 0) {
      pushUnique(blockers, "missingScorer");
      continue;
    }
    if (key?.definitionHash && entry.definitionHash !== key.definitionHash) {
      continue;
    }
    const sameDefinition = matches.find(
      (candidate) => candidate.definitionHash === entry.definitionHash
    );
    if (!sameDefinition) {
      pushUnique(blockers, "differentDefinition");
      continue;
    }
    if (!entry.observedPopulationFingerprint || !sameDefinition.observedPopulationFingerprint) {
      pushUnique(blockers, "missingObservedPopulationIdentity");
    } else if (
      entry.observedPopulationFingerprint !==
      sameDefinition.observedPopulationFingerprint
    ) {
      pushUnique(blockers, "differentObservedPopulationIdentity");
    }
  }
  for (const entry of rightEntries) {
    if (!seenIds.has(entry.scorerId) && !key) {
      pushUnique(blockers, "missingScorer");
    }
  }
  if (
    key?.definitionHash &&
    leftEntries.some((entry) => entry.definitionHash === key.definitionHash) &&
    rightEntries.every((entry) => entry.definitionHash !== key.definitionHash)
  ) {
    pushUnique(blockers, "differentDefinition");
  }

  return SCORER_ROLLUP_PARITY_BLOCKERS.filter((blocker) =>
    blockers.includes(blocker)
  );
}

export function scorerRollupsComparable(
  a: EvalScorerRollupV1,
  b: EvalScorerRollupV1,
  key?: ScorerRollupParityKey
): boolean {
  return scorerRollupParityBlockers(a, b, key).length === 0;
}
