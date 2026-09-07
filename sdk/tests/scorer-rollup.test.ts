/**
 * Scorer-rollup contract — wire shape, canonical identities, and parity.
 *
 * The fixture file is the shared corpus R2-B1 will load. This file runs the
 * ACTUAL helpers (`scorerRollupParityBlockers`, `scorerRollupsComparable`,
 * the fingerprint functions, and `evalScorerRollupSchema`) against every row.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_SCORER_ROLLUP_ENTRIES,
  SCORER_ROLLUP_FROZEN_EXECUTION_DIMENSIONS,
  SCORER_ROLLUP_PARITY_BLOCKERS,
  SCORER_ROLLUP_SCHEMA_VERSION,
  SCORER_ROLLUP_SOURCE_VERSION,
  countableOf,
  evalScorerRollupSchema,
  meanValueOf,
  passRateOf,
  scorerRollupConfiguredTrialFingerprint,
  scorerRollupConfiguredTrialSchema,
  scorerRollupEntryStructuralSchema,
  scorerRollupExecutionFingerprint,
  scorerRollupFrozenExecutionBlockers,
  scorerRollupObservedPopulationFingerprint,
  scorerRollupParityBlockers,
  scorerRollupsComparable,
  stampScorerRollupIdentities,
  type EvalScorerRollupV1,
  type ScorerRollupConfiguredTrialV1,
  type ScorerRollupExecutionIdentityV1,
  type ScorerRollupObservedWeightV1,
  type ScorerRollupParityBlocker,
} from "../src/contract/scorer-rollup.js";
import {
  scorerRollupParityBlockers as exportedParityBlockers,
  scorerRollupsComparable as exportedComparable,
} from "../src/contract/index.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/scorer-rollup-parity-fixtures.json"
);

type IdentityRow = {
  id: string;
  kind: "configuredTrials" | "observedPopulation" | "execution";
  equal: boolean;
  field?: string;
  a: unknown;
  b: unknown;
};

type CompareRow = {
  id: string;
  expectedBlockers: ScorerRollupParityBlocker[];
  skipSchema?: boolean;
  a?: Record<string, unknown>;
  b?: Record<string, unknown>;
};

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  base: Record<string, unknown>;
  identity: IdentityRow[];
  compare: CompareRow[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-merge with `null` meaning "drop this optional field". Arrays replace.
 */
function mergeOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!override) return { ...base };
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    const current = next[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = mergeOverride(current, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function documentFrom(
  override?: Record<string, unknown>,
  options: { skipSchema?: boolean } = {}
): EvalScorerRollupV1 {
  const merged = mergeOverride(fixtures.base, override);
  const stamped = stampScorerRollupIdentities(
    merged as unknown as Omit<
      EvalScorerRollupV1,
      "configuredTrialFingerprint" | "executionFingerprint"
    > & {
      entries: EvalScorerRollupV1["entries"];
    }
  );
  if (!options.skipSchema) {
    const parsed = evalScorerRollupSchema.safeParse(stamped);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) return parsed.data;
  }
  return stamped as EvalScorerRollupV1;
}

describe("scorer-rollup fixtures — required D10 cohorts", () => {
  it("covers every required identity and compare cohort", () => {
    const identityIds = new Set(fixtures.identity.map((row) => row.id));
    const compareIds = new Set(fixtures.compare.map((row) => row.id));
    for (const required of [
      "permute-configured-trials",
      "configured-caseId-changed",
      "configured-executionVariant-changed",
      "configured-configuredTrials-changed",
      "configured-effectivePassThreshold-changed",
      "permute-observed-weights",
      "observed-countable-changed",
      "observed-scored-changed",
      "observed-errors-changed",
      "observed-skipped-changed",
      "observed-notApplicable-changed",
      "observed-missing-changed",
      "observed-quarantined-changed",
      "permute-effective-models",
    ]) {
      expect(identityIds.has(required), required).toBe(true);
    }
    for (const required of [
      "comparable-pair",
      "same-environment-changed-model",
      "same-environment-changed-server",
      "same-environment-changed-host",
      "missing-frozen-host",
      "missing-frozen-model",
      "missing-frozen-server",
      "environment-id-alone-is-not-enough",
      "definition-changed",
      "observed-population-changed",
      "integrity-invalid",
      "integrity-missing",
      "provisional",
      "truncated",
      "missing-config-revision",
      "different-config-revision",
      "missing-case-set",
      "different-case-set",
    ]) {
      expect(compareIds.has(required), required).toBe(true);
    }
    expect(fixtures.identity.length + fixtures.compare.length).toBeGreaterThan(20);
  });
});

describe("scorer-rollup fixtures — canonical identity", () => {
  for (const row of fixtures.identity) {
    it(row.id, () => {
      if (row.kind === "configuredTrials") {
        const left = scorerRollupConfiguredTrialFingerprint(
          row.a as ScorerRollupConfiguredTrialV1[]
        );
        const right = scorerRollupConfiguredTrialFingerprint(
          row.b as ScorerRollupConfiguredTrialV1[]
        );
        expect(left === right).toBe(row.equal);
        return;
      }
      if (row.kind === "observedPopulation") {
        const left = scorerRollupObservedPopulationFingerprint(
          row.a as ScorerRollupObservedWeightV1[]
        );
        const right = scorerRollupObservedPopulationFingerprint(
          row.b as ScorerRollupObservedWeightV1[]
        );
        expect(left === right).toBe(row.equal);
        return;
      }
      const left = scorerRollupExecutionFingerprint(
        row.a as ScorerRollupExecutionIdentityV1
      );
      const right = scorerRollupExecutionFingerprint(
        row.b as ScorerRollupExecutionIdentityV1
      );
      expect(left === right).toBe(row.equal);
    });
  }
});

describe("scorer-rollup fixtures — scorerRollupParityBlockers", () => {
  for (const row of fixtures.compare) {
    it(row.id, () => {
      const left = documentFrom(row.a, { skipSchema: row.skipSchema });
      const right = documentFrom(row.b, { skipSchema: row.skipSchema });
      const blockers = scorerRollupParityBlockers(left, right);
      expect(blockers).toEqual(row.expectedBlockers);
      expect(scorerRollupsComparable(left, right)).toBe(
        row.expectedBlockers.length === 0
      );
    });
  }
});

describe("scorer-rollup schema and rates", () => {
  it("rejects caseKey on the configured-trial snapshot", () => {
    const parsed = scorerRollupConfiguredTrialSchema.safeParse({
      caseId: "cas_refund",
      caseKey: "Refund the customer",
      configuredTrials: 2,
      effectivePassThreshold: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an invented measured field on an entry", () => {
    const parsed = scorerRollupEntryStructuralSchema.safeParse({
      scorerId: "refund",
      definitionHash: "def_refund_1",
      idSource: "explicit",
      role: "gating",
      deterministic: true,
      passThreshold: 1,
      countable: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 0,
      notApplicable: 0,
      measured: 1,
      passRate: 1,
      meanValue: 1,
      observedPopulation: [],
      observedPopulationFingerprint: "x",
    });
    expect(parsed.success).toBe(false);
  });

  it("stores passRate null when countable is 0, never 0", () => {
    const stamped = documentFrom({
      runId: "run_empty",
      entries: [
        {
          scorerId: "refund",
          definitionHash: "def_refund_1",
          idSource: "explicit",
          role: "gating",
          deterministic: true,
          passThreshold: 1,
          countable: 0,
          passed: 0,
          failed: 0,
          errors: 0,
          skipped: 0,
          notApplicable: 2,
          passRate: null,
          meanValue: null,
          observedPopulation: [
            {
              caseId: "cas_refund",
              countable: 0,
              scored: 0,
              errors: 0,
              skipped: 0,
              notApplicable: 2,
            },
          ],
        },
      ],
    });
    expect(stamped.entries[0]?.passRate).toBeNull();
    expect(stamped.entries[0]?.meanValue).toBeNull();
    expect(passRateOf({ passed: 0, countable: 0 })).toBeNull();
    expect(meanValueOf([])).toBeNull();
  });

  it("keeps a measured zero pass rate as 0, not null", () => {
    expect(passRateOf({ passed: 0, countable: 4 })).toBe(0);
    expect(countableOf({ passed: 0, failed: 3, errors: 1, skipped: 0 })).toBe(4);
  });

  it("refuses a fingerprint that is not the snapshot digest", () => {
    const stamped = documentFrom();
    const parsed = evalScorerRollupSchema.safeParse({
      ...stamped,
      executionFingerprint: "not-the-snapshot",
    });
    expect(parsed.success).toBe(false);
  });

  it("caps entries at 200 and treats truncation as incomparable", () => {
    expect(MAX_SCORER_ROLLUP_ENTRIES).toBe(200);
    const stamped = documentFrom({
      truncation: { retained: 1, omitted: 1, total: 2 },
    });
    expect(stamped.truncation?.omitted).toBe(1);
    expect(scorerRollupsComparable(stamped, stamped)).toBe(false);
    expect(scorerRollupParityBlockers(stamped, stamped)).toContain("truncated");
  });

  it("does not use runGroupId as execution identity", () => {
    const left = documentFrom({ runGroupId: "grp_1" });
    const right = documentFrom({ runId: "run_b", runGroupId: "grp_other" });
    expect(scorerRollupParityBlockers(left, right)).toEqual([]);
    expect(left.runGroupId).not.toBe(right.runGroupId);
    expect(left.executionFingerprint).toBe(right.executionFingerprint);
  });

  it("names every required frozen execution dimension", () => {
    expect(SCORER_ROLLUP_FROZEN_EXECUTION_DIMENSIONS).toEqual([
      "hostHarness",
      "effectiveModels",
      "serverEnvironment",
    ]);
    expect(
      scorerRollupFrozenExecutionBlockers({ environmentId: "env_prod" })
    ).toEqual([
      "missingFrozenHostIdentity",
      "missingFrozenModelIdentity",
      "missingFrozenServerIdentity",
    ]);
  });

  it("keeps schema and source versions pinned", () => {
    expect(SCORER_ROLLUP_SCHEMA_VERSION).toBe(1);
    expect(SCORER_ROLLUP_SOURCE_VERSION).toBe(1);
    expect(SCORER_ROLLUP_PARITY_BLOCKERS).toContain("missingFrozenHostIdentity");
  });

  it("re-exports the parity helpers from @mcpjam/sdk/contract", () => {
    expect(exportedParityBlockers).toBe(scorerRollupParityBlockers);
    expect(exportedComparable).toBe(scorerRollupsComparable);
  });
});
