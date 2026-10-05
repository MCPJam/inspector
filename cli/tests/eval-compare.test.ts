/**
 * Flag parsing and gate-input derivation for `mcpjam cloud eval compare`.
 *
 * The derivations are where a comparison quietly goes wrong: a definition
 * change counted as a regression, or unequal iteration weighting passing
 * unnoticed and reweighting the whole-run totals.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGateInputFrom,
  comparePolicyFromOptions,
  compareSampleFrom,
  compareTrialStatisticsFrom,
  deterministicRegressionsFrom,
  flakyInputFrom,
  iterationWeightingEqualFrom,
} from "../src/lib/eval-compare.js";
import type { EvalVerdictTrialStatistics } from "@mcpjam/sdk";
import type {
  PlatformCaseScoreDelta,
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "@mcpjam/sdk/platform";

const ZERO = { base: null, compare: null, delta: null, percentDelta: null };

function delta(
  overrides: Partial<PlatformCaseScoreDelta> = {}
): PlatformCaseScoreDelta {
  return {
    scorerId: "tool-match",
    gating: true,
    deterministic: true,
    definitionChanged: false,
    base: { status: "scored", value: 1, passed: true },
    compare: { status: "scored", value: 0, passed: false },
    value: ZERO,
    ...overrides,
  };
}

function caseRow(
  overrides: Partial<PlatformRunCompareCase> = {}
): PlatformRunCompareCase {
  return {
    caseKey: "ck_a",
    title: "Case A",
    status: "unchanged_passed",
    configChanged: false,
    evaluationConfigChanged: false,
    scoreDeltas: [],
    base: {
      outcome: "passed",
      iterationIds: ["b1"],
      representativeIterationId: "b1",
      error: null,
    },
    compare: {
      outcome: "passed",
      iterationIds: ["c1"],
      representativeIterationId: "c1",
      error: null,
    },
    ...overrides,
  };
}

function wire(
  cases: PlatformRunCompareCase[],
  overrides: Partial<PlatformRunCompare> = {}
): PlatformRunCompare {
  return {
    suite: { id: "s1", name: "Suite" },
    baseline: { policy: "previous_completed", baseRunId: "run_1" },
    baseRun: {
      id: "run_1",
      runNumber: 1,
      result: "passed",
      createdAt: 1,
      completedAt: 2,
      summary: { total: 10, passed: 10, failed: 0, passRate: 1 },
    },
    compareRun: {
      id: "run_2",
      runNumber: 2,
      result: "failed",
      createdAt: 3,
      completedAt: 4,
      summary: { total: 10, passed: 5, failed: 5, passRate: 0.5 },
    },
    passSummary: {
      passRatePercent: ZERO,
      total: ZERO,
      passed: ZERO,
      failed: ZERO,
    },
    metrics: {
      wallDurationMs: ZERO,
      totalTokens: ZERO,
      estimatedCostUsd: ZERO,
    },
    scoreContract: {
      base: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 10,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 10,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: false,
      scorers: [],
    },
    cases,
    ...overrides,
  };
}

// ── flag parsing ───────────────────────────────────────────────────────────

test("--min-effect-size-percent is the ONLY percent boundary", () => {
  const policy = comparePolicyFromOptions({
    gateRegressions: true,
    minEffectSizePercent: "1",
  });
  // 1 percent in, 0.01 fraction out. Everything downstream is fractions.
  assert.equal(policy.passRateRegression?.minEffectSize, 0.01);
});

test("--gate-regressions alone enables the gate with SDK defaults", () => {
  const policy = comparePolicyFromOptions({ gateRegressions: true });
  // An absent key would mean "do not evaluate" — the opposite of the flag.
  assert.deepEqual(policy.passRateRegression, {});
});

test("no comparative flags produces an empty policy", () => {
  assert.deepEqual(comparePolicyFromOptions({}), {});
});

test("tuning without the gate is a usage error, not a silent no-op", () => {
  assert.throws(
    () => comparePolicyFromOptions({ minSampleSize: "10" }),
    /pass --gate-regressions/
  );
  assert.throws(
    () => comparePolicyFromOptions({ minEffectSizePercent: "5" }),
    /pass --gate-regressions/
  );
});

test("a blank flag value is rejected rather than read as zero", () => {
  // `Number("")` is 0, and a silent 0 here removes the sample floor entirely.
  assert.throws(
    () =>
      comparePolicyFromOptions({ gateRegressions: true, minSampleSize: "" }),
    /non-negative integer/
  );
  assert.throws(
    () =>
      comparePolicyFromOptions({
        gateRegressions: true,
        minEffectSizePercent: "",
      }),
    /between 0 and 100/
  );
});

test("out-of-range and non-integer values are usage errors", () => {
  for (const bad of ["-1", "1.5", "abc"]) {
    assert.throws(
      () =>
        comparePolicyFromOptions({ gateRegressions: true, minSampleSize: bad }),
      /non-negative integer/,
      `--min-sample-size ${bad}`
    );
  }
  for (const bad of ["-1", "101", "abc"]) {
    assert.throws(
      () =>
        comparePolicyFromOptions({
          gateRegressions: true,
          minEffectSizePercent: bad,
        }),
      /between 0 and 100/,
      `--min-effect-size-percent ${bad}`
    );
  }
  assert.throws(
    () => comparePolicyFromOptions({ maxP95LatencyIncreaseMs: "-5" }),
    /non-negative integer/
  );
});

test("comparePolicyFromOptions: --max-cost-increase-percent stays a percentage", () => {
  // NOT divided by 100 like `--min-effect-size-percent`: the gate compares it
  // against a percentage it computes, so a fraction here would make `10` mean
  // a hundredfold-stricter 0.1%.
  assert.equal(
    comparePolicyFromOptions({ maxCostIncreasePercent: "10" })
      .maximumCostIncreasePercent,
    10
  );
});

test("comparePolicyFromOptions: --max-cost-increase-percent allows over 100", () => {
  // A run costing three times its baseline is a 200% increase; capping the
  // flag at 100 would make that threshold unexpressible.
  assert.equal(
    comparePolicyFromOptions({ maxCostIncreasePercent: "200" })
      .maximumCostIncreasePercent,
    200
  );
});

test("comparePolicyFromOptions: --max-cost-increase-percent rejects blank and negative", () => {
  for (const raw of ["", "-1", "abc"]) {
    assert.throws(
      () => comparePolicyFromOptions({ maxCostIncreasePercent: raw }),
      /--max-cost-increase-percent must be a non-negative number/,
      raw
    );
  }
});

test("the boolean gates map straight through", () => {
  const policy = comparePolicyFromOptions({
    gateDeterministicRegressions: true,
    maxP95LatencyIncreaseMs: "250",
  });
  assert.equal(policy.noDeterministicRegressions, true);
  assert.equal(policy.maximumP95LatencyIncreaseMs, 250);
});

// ── deterministic regressions ──────────────────────────────────────────────

test("counts only gating, deterministic, unchanged-definition true->false flips", () => {
  const cases = [
    caseRow({ caseKey: "ck_real", scoreDeltas: [delta()] }),
    // Advisory: information, not a gate.
    caseRow({
      caseKey: "ck_advisory",
      scoreDeltas: [delta({ gating: false })],
    }),
    // A judge disagreeing between runs is the judge being a judge.
    caseRow({
      caseKey: "ck_judge",
      scoreDeltas: [delta({ deterministic: false })],
    }),
    // Different definition: the two sides did not measure the same thing.
    caseRow({
      caseKey: "ck_redefined",
      scoreDeltas: [delta({ definitionChanged: true })],
    }),
    // Already failing — not a regression.
    caseRow({
      caseKey: "ck_already_red",
      scoreDeltas: [
        delta({ base: { status: "scored", value: 0, passed: false } }),
      ],
    }),
    // New on the compare side — no base row to have regressed from.
    caseRow({ caseKey: "ck_new", scoreDeltas: [delta({ base: null })] }),
  ];

  assert.deepEqual(deterministicRegressionsFrom(cases), [
    { caseKey: "ck_real", scorerId: "tool-match" },
  ]);
});

// ── iteration weighting ────────────────────────────────────────────────────

test("unequal iteration counts on a SHARED case break weighting", () => {
  assert.equal(iterationWeightingEqualFrom([caseRow()]), true);
  assert.equal(
    iterationWeightingEqualFrom([
      caseRow({
        compare: {
          outcome: "passed",
          iterationIds: ["c1", "c2", "c3"],
          representativeIterationId: "c1",
          error: null,
        },
      }),
    ]),
    false
  );
});

test("new and removed cases do NOT break weighting on their own", () => {
  // They have no counterpart to weigh against, and `caseSetChanged` already
  // reports them. Counting them here would double-report one fact.
  assert.equal(
    iterationWeightingEqualFrom([
      caseRow({
        status: "new_case",
        base: {
          outcome: "absent",
          iterationIds: [],
          representativeIterationId: null,
          error: null,
        },
      }),
      caseRow({
        status: "removed_case",
        compare: {
          outcome: "absent",
          iterationIds: [],
          representativeIterationId: null,
          error: null,
        },
      }),
    ]),
    true
  );
});

// ── full gate input ────────────────────────────────────────────────────────

test("derives every population signal from the wire", () => {
  const input = compareGateInputFrom(
    wire([
      caseRow({ caseKey: "ck_a", scoreDeltas: [delta()] }),
      caseRow({ caseKey: "ck_new", status: "new_case" }),
      caseRow({ caseKey: "ck_edited", configChanged: true }),
    ])
  );

  assert.equal(input.caseSetChanged, true);
  assert.equal(input.scenarioConfigChanged, true);
  assert.equal(input.evaluationConfigChanged, false);
  assert.equal(input.iterationWeightingEqual, true);
  assert.equal(input.scoreDeltasAvailable, true);
  assert.deepEqual(input.deterministicScoreRegressions, [
    { caseKey: "ck_a", scorerId: "tool-match" },
  ]);
  assert.deepEqual(input.base.iterations, { total: 10, passed: 10 });
  assert.deepEqual(input.compare.iterations, { total: 10, passed: 5 });
  assert.equal(input.base.scoreIntegrity, "valid");
});

test("a clean comparison reports no population problems", () => {
  const input = compareGateInputFrom(wire([caseRow()]));
  assert.equal(input.caseSetChanged, false);
  assert.equal(input.scenarioConfigChanged, false);
  assert.equal(input.evaluationConfigChanged, false);
  assert.equal(input.iterationWeightingEqual, true);
  // No score deltas anywhere: the deterministic gate must be undecidable, not
  // silently passing.
  assert.equal(input.scoreDeltasAvailable, false);
});

test("a null integrity verdict is passed through as absent, not as valid", () => {
  const input = compareGateInputFrom(
    wire([caseRow()], {
      scoreContract: {
        base: {
          evaluationConfigHash: null,
          scoreIntegrity: null,
          scoredIterations: 0,
          quarantinedIterations: 0,
        },
        compare: {
          evaluationConfigHash: null,
          scoreIntegrity: "valid",
          scoredIterations: 1,
          quarantinedIterations: 0,
        },
        evaluationConfigChanged: false,
        scorers: [],
      },
    })
  );
  assert.equal(input.base.scoreIntegrity, undefined);
  assert.equal(input.compare.scoreIntegrity, "valid");
});

test("p95 rides in only when supplied", () => {
  assert.equal(compareGateInputFrom(wire([])).base.totals, undefined);
  const withLatency = compareGateInputFrom(wire([]), {
    baseP95Ms: 100,
    compareP95Ms: 200,
  });
  assert.deepEqual(withLatency.base.totals, { e2eP95Ms: 100 });
  assert.deepEqual(withLatency.compare.totals, { e2eP95Ms: 200 });
});

// ── flakiness input ────────────────────────────────────────────────────────

test("flaky input keys on the case, falling back through the identity fields", () => {
  assert.deepEqual(
    flakyInputFrom([
      { id: "it_1", testCaseId: "tc1", title: "A", result: "passed" } as never,
      { id: "it_2", testCaseId: "tc1", title: "A", result: "failed" } as never,
      { id: "it_3", testCaseId: null, title: "B", result: "passed" } as never,
      { id: "it_4", testCaseId: null, title: null, result: "failed" } as never,
    ]),
    [
      { caseKey: "tc1", passed: true },
      { caseKey: "tc1", passed: false },
      { caseKey: "B", passed: true },
      // The unidentified row keys on its OWN id — a shared "unknown" bucket
      // would pool unrelated iterations and could invent a flake.
      { caseKey: "it_4", passed: false },
    ]
  );
});

test("a per-case evaluation config change breaks the population too", () => {
  // The run-level hash alone misses a suite that re-graded ONE case — the
  // whole-run rate would then mix two different measurements.
  const input = compareGateInputFrom(
    wire([caseRow({ evaluationConfigChanged: true })])
  );
  assert.equal(input.evaluationConfigChanged, true);
});

test("pending iterations are excluded from flakiness, not counted as failures", () => {
  // `result: null` mapped to `passed: false` would make a half-finished case
  // look like it both passed and failed — a fabricated flake.
  assert.deepEqual(
    flakyInputFrom([
      { id: "it_1", testCaseId: "tc1", title: "A", result: "passed" } as never,
      { id: "it_2", testCaseId: "tc1", title: "A", result: null } as never,
      { id: "it_3", testCaseId: "tc1", title: "A", result: "running" } as never,
    ]),
    [{ caseKey: "tc1", passed: true }]
  );
});

// ── the comparison's sample: eligible trials, one unit ──────────────────────

/**
 * A side's trial statistics, written out by hand (the values are what the
 * SDK's `evalVerdictTrialStatistics` produces for these counts; the contract
 * test pins that function bit for bit). Two case variants: 5 eligible trials
 * with 3 passing — pass@5 = 1 − C(2,5)/C(5,5) = 1, pass^5 = C(3,5)/C(5,5) = 0
 * — and 10 with 10.
 */
function trialStatistics(
  rows: Array<[eligible: number, passed: number]>
): EvalVerdictTrialStatistics {
  const cases = rows.map(([eligible, passed], index) => ({
    caseId: `c_${index}`,
    eligibleTrials: eligible,
    passedTrials: passed,
    k: eligible,
    passAtK: eligible === 0 ? null : passed > 0 ? 1 : 0,
    passHatK: eligible === 0 ? null : passed === eligible ? 1 : 0,
    passRateInterval: null,
  }));
  return {
    unit: "caseVariant",
    eligibleTrials: rows.reduce((sum, [eligible]) => sum + eligible, 0),
    passedTrials: rows.reduce((sum, [, passed]) => sum + passed, 0),
    cases,
  };
}

function withStatistics(
  base: EvalVerdictTrialStatistics | undefined,
  compare: EvalVerdictTrialStatistics | undefined
): PlatformRunCompare {
  const row = wire([caseRow()]);
  // `summary` here is case-variant counts (2 rows), the unit a per-case-graded
  // run's legacy summary is in — NOT the trial population.
  return {
    ...row,
    baseRun: {
      ...row.baseRun,
      summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
      ...(base ? { trialStatistics: base } : {}),
    },
    compareRun: {
      ...row.compareRun,
      summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
      ...(compare ? { trialStatistics: compare } : {}),
    },
  };
}

test("both sides graded per case: the sample is ELIGIBLE TRIALS, not summary.total", () => {
  const compare = withStatistics(
    trialStatistics([
      [5, 5],
      [10, 10],
    ]),
    trialStatistics([
      [5, 3],
      [10, 10],
    ])
  );
  const sample = compareSampleFrom(compare);
  assert.equal(sample.basis, "eligibleTrials");
  assert.deepEqual(sample.base, { total: 15, passed: 15 });
  assert.deepEqual(sample.compare, { total: 15, passed: 13 });

  // And the gate reads exactly that sample: 15 trials a side, which clears the
  // default minimum sample of 5 — the 2 case variants `summary.total` reports
  // would not.
  const input = compareGateInputFrom(compare);
  assert.deepEqual(input.base.iterations, { total: 15, passed: 15 });
  assert.deepEqual(input.compare.iterations, { total: 15, passed: 13 });
});

test("infrastructure failures are already out of the sample", () => {
  // 5 configured, 1 execution failure: the statistics carry 4 eligible trials,
  // and the comparison is sized by 4, not by the 5 that were configured.
  const compare = withStatistics(
    trialStatistics([[4, 4]]),
    trialStatistics([[4, 2]])
  );
  assert.deepEqual(compareSampleFrom(compare).compare, {
    total: 4,
    passed: 2,
  });
});

test("one side without trial statistics: BOTH fall back to the legacy summary", () => {
  // Never one of each — that would set a trial count against a case count.
  for (const compare of [
    withStatistics(trialStatistics([[5, 5]]), undefined),
    withStatistics(undefined, trialStatistics([[5, 3]])),
    withStatistics(undefined, undefined),
  ]) {
    const sample = compareSampleFrom(compare);
    assert.equal(sample.basis, "legacySummary");
    assert.deepEqual(sample.base, { total: 2, passed: 2 });
    assert.deepEqual(sample.compare, { total: 2, passed: 1 });
    const input = compareGateInputFrom(compare);
    assert.deepEqual(input.base.iterations, { total: 2, passed: 2 });
  }
});

test("a missing legacy summary still reads as an empty sample", () => {
  const row = wire([caseRow()]);
  const sample = compareSampleFrom({
    ...row,
    baseRun: { ...row.baseRun, summary: null },
  });
  assert.equal(sample.basis, "legacySummary");
  assert.deepEqual(sample.base, { total: 0, passed: 0 });
});

test("compare output carries both sides' statistics and the sample basis", () => {
  const base = trialStatistics([[5, 5]]);
  const next = trialStatistics([[5, 3]]);
  const report = compareTrialStatisticsFrom(withStatistics(base, next));
  assert.equal(report.sample.basis, "eligibleTrials");
  assert.deepEqual(report.base, base);
  assert.deepEqual(report.compare, next);
  // pass@k / pass^k are reported per case variant, at k = n.
  assert.equal(report.compare?.cases[0]?.k, 5);
  assert.equal(report.compare?.cases[0]?.passAtK, 1);
  assert.equal(report.compare?.cases[0]?.passHatK, 0);

  const legacy = compareTrialStatisticsFrom(wire([caseRow()]));
  assert.equal(legacy.base, null);
  assert.equal(legacy.compare, null);
  assert.equal(legacy.sample.basis, "legacySummary");
});
