/**
 * Loader + fixture-derivation helpers for the shared grading-policy corpus.
 *
 * A plain module, not a test file, following the precedent of
 * `./eval-verdict-policy-fixtures.ts`: importing one test file from another
 * re-registers its `describe`s in the importer and reports every case twice.
 *
 * The strip rule lives here for the reason the fixture's `__readme` spells out:
 * every object in this contract is closed, so a payload still carrying
 * `__label` would be rejected for the wrong reason.
 *
 * ── These derivations are FIXTURE DERIVATIONS, not shipped producers ─────────
 *
 * {@link deriveSuiteWideRate}, {@link deriveFailingCases} and
 * {@link LEGACY_SUMMARY_PRODUCERS} restate arithmetic that already ships in
 * `convex/testSuites.ts`, `convex/sdkEvals.ts` and
 * `sdk/src/eval-run-reporter.ts`. They exist ONLY so the corpus's expected
 * outputs are proven self-consistent with the runs they claim to summarize,
 * rather than being hand-typed numbers nobody re-checks — the same role
 * `deriveCaseCounts` plays for the verdict-policy corpus.
 *
 * Nothing here is exported from the SDK, and nothing in `src/` may import it. A
 * decision algorithm living in a contract package is precisely the outcome the
 * grading-policy contract exists to prevent: `contract/grading-policy.ts`
 * describes the RULES a producer is handed and decides nothing.
 */

import fixtures from "../fixtures/eval-grading-policy-parity-fixtures.json" with { type: "json" };
import type {
  EvalGradingPolicyEdit,
  EvalIterationRule,
  EvalPassCriterion,
  ResolvedEvalGradingPolicy,
} from "../../src/contract/grading-policy.js";

/** `testIteration.result`'s real vocabulary. There is no evaluator-error member. */
export type FixtureIterationResult =
  "pending" | "passed" | "failed" | "cancelled" | "timed_out";

export type FixtureIteration = {
  caseRef: string;
  result: FixtureIterationResult;
  executionVariant?: { model: string; provider?: string };
  /**
   * A required evaluator errored on this iteration. Read only by the per-case
   * contract's validity phase; invisible to every suite-wide producer, which
   * sees only `result`.
   */
  evaluatorError?: true;
};

export type PolicySourceRef =
  | { source: "suiteFile"; value: Record<string, unknown> }
  | { source: "hostedSuite"; value: Record<string, unknown> }
  | { source: "runReporting"; value: Record<string, unknown> };

export type NormalizationRow = {
  __label: string;
  __why: string;
  input: PolicySourceRef;
  expected: ResolvedEvalGradingPolicy;
};

export type RejectRow = {
  __label: string;
  __why: string;
  kind: "hostedSuite" | "policy";
  value: Record<string, unknown>;
};

export type IterationResolutionRow = {
  __label: string;
  __why: string;
  rule: EvalIterationRule;
  args: { caseIterations?: number; runOverride?: number; replay?: boolean };
  expected: number;
};

export type ThresholdConversionRow = { fraction: number; percent: number };

export type ScopeCheck = {
  criterion: EvalPassCriterion;
  expectedRate?: number;
  expected: "passed" | "failed";
  expectedFailingCases?: Array<{
    caseRef: string;
    executionVariant?: { model: string; provider?: string };
  }>;
};

export type ScopeRow = {
  __label: string;
  __why: string;
  run: { iterations: FixtureIteration[] };
  checks: ScopeCheck[];
  perCaseNote?: string;
};

export type LegacySummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  result: "passed" | "failed";
};

export type LegacyProducerName =
  "hostedFinalization" | "sdkIngestion" | "localFallback";

export type HistoricalSummaryRow = {
  __label: string;
  __why: string;
  run: string;
  minimumPassRate: number;
  expected: Record<LegacyProducerName, LegacySummary>;
};

export type EditRow = {
  __label: string;
  __why: string;
  policy: PolicySourceRef;
  edit: EvalGradingPolicyEdit;
  expected:
    | { ok: true; settings: Record<string, unknown>; changed: string[] }
    | { ok: false; refusal: string };
};

/**
 * An edit the planner must THROW on, rather than refuse.
 *
 * A refusal is "this policy cannot express that operation" and a caller renders
 * it; a throw is "that edit is malformed", which is a programming error.
 */
export type RejectedEditRow = {
  __label: string;
  __why: string;
  policy: PolicySourceRef;
  edit: Record<string, unknown>;
};

export type GradingPolicyFixtures = {
  __readme: string;
  normalization: NormalizationRow[];
  reject: RejectRow[];
  iterationResolution: IterationResolutionRow[];
  thresholdConversion: ThresholdConversionRow[];
  scope: ScopeRow[];
  runs: Record<string, FixtureIteration[]>;
  historicalSummaries: HistoricalSummaryRow[];
  edits: EditRow[];
  rejectedEdits: RejectedEditRow[];
};

export const gradingPolicyFixtures =
  fixtures as unknown as GradingPolicyFixtures;

/**
 * Drop every `__`-prefixed annotation, recursively.
 *
 * Recursive because a nested annotation would survive a shallow strip and be
 * rejected by the first `.strict()` object it reached — which is the failure
 * mode the fixture's load rule warns about.
 */
export function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("__")) continue;
    out[key] = stripAnnotations(inner);
  }
  return out as unknown as T;
}

// ── fixture derivation ───────────────────────────────────────────────────────
const TERMINAL: readonly FixtureIterationResult[] = [
  "passed",
  "failed",
  "timed_out",
];

/** `iterationGroupKeyForSummary`: the case, with the execution variant IGNORED. */
function caseBucketKey(iteration: FixtureIteration): string {
  return iteration.caseRef;
}

/**
 * The suite-wide rate a criterion measures over a run.
 *
 * Fixture derivation: it restates the shipped denominators so the corpus's
 * `expectedRate` is checked rather than asserted.
 */
export function deriveSuiteWideRate(
  criterion: Extract<EvalPassCriterion, { scope: "suiteWide" }>,
  iterations: readonly FixtureIteration[]
): number {
  if (criterion.population === "iterations") {
    const total = iterations.length;
    if (total === 0) return criterion.emptyPopulationRate;
    return iterations.filter((row) => row.result === "passed").length / total;
  }
  const buckets = new Map<string, FixtureIteration[]>();
  for (const row of iterations) {
    const key = caseBucketKey(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  let passed = 0;
  let failed = 0;
  for (const rows of buckets.values()) {
    const terminal = rows.filter((row) => TERMINAL.includes(row.result));
    if (terminal.length === 0) continue;
    if (
      terminal.some(
        (row) => row.result === "failed" || row.result === "timed_out"
      )
    ) {
      failed += 1;
    } else {
      passed += 1;
    }
  }
  const total = passed + failed;
  if (total === 0) return criterion.emptyPopulationRate;
  return passed / total;
}

/**
 * The case-execution variants a PER-CASE criterion fails a run on.
 *
 * Keyed on (caseRef, executionVariant), which is the identity the per-case
 * contract aggregates under — deliberately unlike the variant-collapsing case
 * bucket above, because that difference is one of the things this corpus pins.
 * Eligibility here is "produced a task verdict", i.e. `passed` or `failed`;
 * `timed_out`, `pending` and `cancelled` are excluded rather than counted as
 * failures, matching `EVAL_TRIAL_EXCLUSION_REASONS`.
 */
export function deriveFailingCases(
  criterion: Extract<EvalPassCriterion, { scope: "perCase" }>,
  iterations: readonly FixtureIteration[]
): Array<{
  caseRef: string;
  executionVariant?: { model: string; provider?: string };
}> {
  const groups = new Map<
    string,
    {
      caseRef: string;
      executionVariant?: { model: string; provider?: string };
      passed: number;
      eligible: number;
    }
  >();
  for (const row of iterations) {
    const variant = row.executionVariant;
    const key = `${row.caseRef}\u0000${variant?.provider ?? ""}\u0000${
      variant?.model ?? ""
    }`;
    const entry = groups.get(key) ?? {
      caseRef: row.caseRef,
      ...(variant ? { executionVariant: variant } : {}),
      passed: 0,
      eligible: 0,
    };
    if (row.result === "passed" || row.result === "failed") {
      entry.eligible += 1;
      if (row.result === "passed") entry.passed += 1;
    }
    groups.set(key, entry);
  }
  const failing: Array<{
    caseRef: string;
    executionVariant?: { model: string; provider?: string };
  }> = [];
  for (const entry of groups.values()) {
    if (entry.eligible === 0) continue;
    if (entry.passed / entry.eligible >= criterion.threshold) continue;
    failing.push({
      caseRef: entry.caseRef,
      ...(entry.executionVariant
        ? { executionVariant: entry.executionVariant }
        : {}),
    });
  }
  return failing;
}

/**
 * The three shipped legacy suite-wide producers, restated for derivation.
 *
 * Each one is named for the module it reproduces, and the differences between
 * them are the whole reason the corpus carries all three.
 */
export const LEGACY_SUMMARY_PRODUCERS: Record<
  LegacyProducerName,
  (rows: readonly FixtureIteration[], minimumPassRate: number) => LegacySummary
> = {
  /** `convex/testSuites.ts` run finalization. Population: iterations. Empty: 1. */
  hostedFinalization(rows, minimumPassRate) {
    const total = rows.length;
    const passed = rows.filter((row) => row.result === "passed").length;
    const failed = rows.filter(
      (row) => row.result === "failed" || row.result === "timed_out"
    ).length;
    const passRate = total > 0 ? passed / total : 1;
    return {
      total,
      passed,
      failed,
      passRate,
      result: passRate * 100 >= minimumPassRate ? "passed" : "failed",
    };
  },
  /**
   * `convex/sdkEvals.ts` `computeEvalRunSummaryFromIterations`. Population:
   * cases, variant-collapsed, absent cases dropped. Empty: 0.
   */
  sdkIngestion(rows, minimumPassRate) {
    const buckets = new Map<string, FixtureIteration[]>();
    for (const row of rows) {
      const key = caseBucketKey(row);
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    let passed = 0;
    let failed = 0;
    for (const iters of buckets.values()) {
      const terminal = iters.filter((row) => TERMINAL.includes(row.result));
      if (terminal.length === 0) continue;
      if (
        terminal.some(
          (row) => row.result === "failed" || row.result === "timed_out"
        )
      ) {
        failed += 1;
      } else {
        passed += 1;
      }
    }
    const total = passed + failed;
    const passRate = total > 0 ? passed / total : 0;
    return {
      total,
      passed,
      failed,
      passRate,
      result: passRate * 100 >= minimumPassRate ? "passed" : "failed",
    };
  },
  /**
   * `sdk/src/eval-run-reporter.ts` `buildLocalFallbackResult`. Population: the
   * results the reporter was handed, one per iteration; `failed` is the
   * REMAINDER rather than a classification. Empty: 0.
   */
  localFallback(rows, minimumPassRate) {
    const total = rows.length;
    const passed = rows.filter((row) => row.result === "passed").length;
    const failed = total - passed;
    const passRate = total > 0 ? passed / total : 0;
    return {
      total,
      passed,
      failed,
      passRate,
      result: passRate * 100 >= minimumPassRate ? "passed" : "failed",
    };
  },
};
