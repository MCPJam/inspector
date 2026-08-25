/**
 * The exit-code matrix for `mcpjam cloud eval gate --baseline`.
 *
 * Mirrors `eval-compare-exit-code.test.ts` deliberately: same wire fixture
 * shape, same oracle-pinned regression numbers, same principle that no
 * infrastructure or comparability problem may ever map to 1. What this file
 * adds on top is the MERGE: `eval gate --baseline` folds a threshold
 * `GateReport` (from `evaluateGates`) together with a comparative one (from
 * `evaluateCompareGates`) into the single report the command actually emits,
 * and the merge must never let one family's verdict bury the other's.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompareGates, evaluateGates } from "@mcpjam/sdk";
import type { GateInput, GatePolicy, GateReport } from "@mcpjam/sdk";
import { compareGateInputFrom } from "../src/lib/eval-compare.js";
import {
  comparePolicyFromGateOptions,
  mergeGateReports,
} from "../src/lib/eval-gate.js";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  evalGateExitCode,
} from "../src/lib/eval-gate-exit-code.js";
import type {
  PlatformCaseScoreDelta,
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "@mcpjam/sdk/platform";

const ZERO = { base: null, compare: null, delta: null, percentDelta: null };

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

const REGRESSED_DELTA: PlatformCaseScoreDelta = {
  scorerId: "tool-match",
  gating: true,
  deterministic: true,
  definitionChanged: false,
  base: { status: "scored", value: 1, passed: true },
  compare: { status: "scored", value: 0, passed: false },
  value: ZERO,
};

function wire(args: {
  basePassed?: number;
  baseTotal?: number;
  comparePassed?: number;
  compareTotal?: number;
  cases?: PlatformRunCompareCase[];
}): PlatformRunCompare {
  const baseTotal = args.baseTotal ?? 70;
  const compareTotal = args.compareTotal ?? 80;
  return {
    suite: { id: "s1", name: "Suite" },
    baseline: { policy: "run", baseRunId: "run_base" },
    baseRun: {
      id: "run_base",
      runNumber: 1,
      result: "passed",
      createdAt: 1,
      completedAt: 2,
      summary: {
        total: baseTotal,
        passed: args.basePassed ?? 56,
        failed: baseTotal - (args.basePassed ?? 56),
        passRate: (args.basePassed ?? 56) / baseTotal,
      },
    },
    compareRun: {
      id: "run_compare",
      runNumber: 2,
      result: "failed",
      createdAt: 3,
      completedAt: 4,
      summary: {
        total: compareTotal,
        passed: args.comparePassed ?? 48,
        failed: compareTotal - (args.comparePassed ?? 48),
        passRate: (args.comparePassed ?? 48) / compareTotal,
      },
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
        scoredIterations: baseTotal,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: compareTotal,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: false,
      scorers: [],
    },
    cases: args.cases ?? [caseRow()],
  };
}

/** A run that comfortably clears any threshold gate on its own. */
const PASSING_THRESHOLD_INPUT: GateInput = {
  iterations: { total: 10, passed: 10 },
};

function thresholdReport(
  policy: GatePolicy,
  input: GateInput = PASSING_THRESHOLD_INPUT
): GateReport {
  return evaluateGates(input, policy);
}

function mergedExitCode(args: {
  thresholdPolicy?: GatePolicy;
  thresholdInput?: GateInput;
  compare: PlatformRunCompare;
  comparePolicy: GatePolicy;
}): number {
  const threshold = thresholdReport(
    args.thresholdPolicy ?? {},
    args.thresholdInput
  );
  const comparative = evaluateCompareGates(
    compareGateInputFrom(args.compare),
    args.comparePolicy
  );
  return evalGateExitCode(mergeGateReports(threshold, comparative));
}

test("1 — a baseline regression, with no threshold policy at all", () => {
  // The oracle's 56/70 -> 48/80 row, same numbers `eval-compare-exit-
  // code.test.ts` pins against statsmodels.
  assert.equal(
    mergedExitCode({
      compare: wire({}),
      comparePolicy: comparePolicyFromGateOptions({ baseline: "run_base" }),
    }),
    1
  );
});

test("3 — an incompatible case set is non_gateable, NOT a regression", () => {
  // Same regressed numbers as above; the case set churned, so the whole-run
  // rate is not comparable and must never read as 1.
  assert.equal(
    mergedExitCode({
      compare: wire({
        cases: [caseRow(), caseRow({ caseKey: "ck_new", status: "new_case" })],
      }),
      comparePolicy: comparePolicyFromGateOptions({ baseline: "run_base" }),
    }),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("3 — insufficient sample size reads as incomplete, not no_regression", () => {
  assert.equal(
    mergedExitCode({
      compare: wire({
        basePassed: 4,
        baseTotal: 4,
        comparePassed: 0,
        compareTotal: 4,
      }),
      comparePolicy: comparePolicyFromGateOptions({ baseline: "run_base" }),
    }),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("1 — a deterministic per-case regression, independent of the population rule", () => {
  assert.equal(
    mergedExitCode({
      compare: wire({
        basePassed: 56,
        comparePassed: 56,
        compareTotal: 70,
        cases: [caseRow({ scoreDeltas: [REGRESSED_DELTA] })],
      }),
      comparePolicy: comparePolicyFromGateOptions({
        baseline: "run_base",
        gateDeterministicRegressions: true,
      }),
    }),
    1
  );
});

test("1 — a threshold miss and a baseline regression fold into ONE report", () => {
  const failingThreshold: GateInput = { iterations: { total: 2, passed: 1 } };
  const threshold = thresholdReport({ minimumPassRate: 1 }, failingThreshold);
  const comparative = evaluateCompareGates(
    compareGateInputFrom(wire({})),
    comparePolicyFromGateOptions({ baseline: "run_base" })
  );
  const merged = mergeGateReports(threshold, comparative);
  assert.equal(evalGateExitCode(merged), 1);
  const gates = merged.verdicts.map((v) => v.gate);
  assert.ok(
    gates.includes("minimumPassRate"),
    "threshold verdict must survive the merge"
  );
  assert.ok(
    gates.includes("passRateRegression"),
    "comparative verdict must survive the merge"
  );
});

test("3 — the threshold passes but the comparison is non-gateable", () => {
  // Deterministic gate asked for, but no score deltas at all on the wire —
  // undecidable, not "nothing regressed".
  assert.equal(
    mergedExitCode({
      compare: wire({ basePassed: 56, comparePassed: 60, compareTotal: 70 }),
      comparePolicy: comparePolicyFromGateOptions({
        baseline: "run_base",
        gateDeterministicRegressions: true,
      }),
    }),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("0 — a passing threshold and a clean baseline comparison", () => {
  assert.equal(
    mergedExitCode({
      thresholdPolicy: { minimumPassRate: 1 },
      compare: wire({
        basePassed: 56,
        comparePassed: 60,
        compareTotal: 70,
        cases: [
          caseRow({
            scoreDeltas: [
              {
                ...REGRESSED_DELTA,
                compare: { status: "scored", value: 1, passed: true },
              },
            ],
          }),
        ],
      }),
      comparePolicy: comparePolicyFromGateOptions({
        baseline: "run_base",
        gateDeterministicRegressions: true,
      }),
    }),
    0
  );
});
