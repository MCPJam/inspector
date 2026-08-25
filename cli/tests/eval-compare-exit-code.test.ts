/**
 * The exit-code matrix for `mcpjam cloud eval compare`.
 *
 * This is the contract CI actually depends on, so it is pinned END TO END —
 * from a wire DTO through the real derivation and the real gate engine to the
 * real exit-code mapper — rather than by asserting on a hand-built GateReport.
 * A matrix built from stub reports would pass while the derivation that feeds
 * it was wrong.
 *
 * The rule that matters most: NO infrastructure condition maps to 1. A CI job
 * that fails a release on a flaked request and calls it a regression teaches
 * people to ignore the gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompareGates } from "@mcpjam/sdk";
import type { GatePolicy } from "@mcpjam/sdk";
import {
  compareGateInputFrom,
  comparePolicyFromOptions,
} from "../src/lib/eval-compare.js";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  EVAL_GATE_USAGE_EXIT_CODE,
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
  baseIntegrity?: "valid" | "invalid" | null;
  compareIntegrity?: "valid" | "invalid" | null;
  evaluationConfigChanged?: boolean;
}): PlatformRunCompare {
  const baseTotal = args.baseTotal ?? 70;
  const compareTotal = args.compareTotal ?? 80;
  return {
    suite: { id: "s1", name: "Suite" },
    baseline: { policy: "previous_completed", baseRunId: "run_1" },
    baseRun: {
      id: "run_1",
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
      id: "run_2",
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
    metrics: { wallDurationMs: ZERO, totalTokens: ZERO, estimatedCostUsd: ZERO },
    scoreContract: {
      base: {
        evaluationConfigHash: "cfg",
        scoreIntegrity:
          args.baseIntegrity === undefined ? "valid" : args.baseIntegrity,
        scoredIterations: baseTotal,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg",
        scoreIntegrity:
          args.compareIntegrity === undefined ? "valid" : args.compareIntegrity,
        scoredIterations: compareTotal,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: args.evaluationConfigChanged ?? false,
      scorers: [],
    },
    cases: args.cases ?? [caseRow()],
  };
}

function exitCodeFor(
  compare: PlatformRunCompare,
  policy: GatePolicy,
  latency: { baseP95Ms?: number; compareP95Ms?: number } = {}
): number {
  return evalGateExitCode(
    evaluateCompareGates(compareGateInputFrom(compare, latency), policy)
  );
}

/** A gating scorer that held: present evidence, no flip. */
const HELD_DELTA: PlatformCaseScoreDelta = {
  ...REGRESSED_DELTA,
  compare: { status: "scored", value: 1, passed: true },
};

test("0 — everything passes", () => {
  assert.equal(
    exitCodeFor(
      wire({
        basePassed: 56,
        comparePassed: 60,
        compareTotal: 70,
        // Score deltas must be PRESENT for the deterministic gate to be
        // decidable at all — see the companion test below.
        cases: [caseRow({ scoreDeltas: [HELD_DELTA] })],
      }),
      comparePolicyFromOptions({
        gateRegressions: true,
        gateDeterministicRegressions: true,
      })
    ),
    0
  );
});

test("3 — no per-case score deltas leaves the deterministic gate undecidable", () => {
  // A comparison with no score evidence cannot say "nothing regressed"; it can
  // only say it does not know. Passing here would be the fail-open.
  assert.equal(
    exitCodeFor(
      wire({ basePassed: 56, comparePassed: 60, compareTotal: 70 }),
      comparePolicyFromOptions({ gateDeterministicRegressions: true })
    ),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("1 — a statistically significant pass-rate regression", () => {
  // The oracle's 56/70 -> 48/80 row: the whole interval is below zero.
  assert.equal(
    exitCodeFor(wire({}), comparePolicyFromOptions({ gateRegressions: true })),
    1
  );
});

test("1 — a deterministic gating regression", () => {
  assert.equal(
    exitCodeFor(
      wire({
        basePassed: 56,
        comparePassed: 56,
        compareTotal: 70,
        cases: [caseRow({ scoreDeltas: [REGRESSED_DELTA] })],
      }),
      comparePolicyFromOptions({ gateDeterministicRegressions: true })
    ),
    1
  );
});

test("1 — a p95 latency breach", () => {
  assert.equal(
    exitCodeFor(
      wire({ basePassed: 56, comparePassed: 56, compareTotal: 70 }),
      comparePolicyFromOptions({ maxP95LatencyIncreaseMs: "100" }),
      { baseP95Ms: 500, compareP95Ms: 900 }
    ),
    1
  );
});

test("2 — a malformed flag never reaches the network", () => {
  // Thrown by the parser, before any request. Asserting the CODE, not just
  // that it throws: a usage error mapped to 3 would send a CI operator
  // looking for an outage that never happened.
  try {
    comparePolicyFromOptions({
      gateRegressions: true,
      minEffectSizePercent: "nope",
    });
    assert.fail("expected a usage error");
  } catch (error) {
    assert.equal(
      (error as { exitCode?: number }).exitCode,
      EVAL_GATE_USAGE_EXIT_CODE
    );
  }
});

test("3 — insufficient sample is incomplete, not a pass and not a failure", () => {
  assert.equal(
    exitCodeFor(
      wire({
        basePassed: 4,
        baseTotal: 4,
        comparePassed: 0,
        compareTotal: 4,
      }),
      comparePolicyFromOptions({ gateRegressions: true })
    ),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("3 — EVERY population-mismatch condition, with --gate-regressions", () => {
  const MISMATCHES: Array<{ label: string; compare: PlatformRunCompare }> = [
    {
      label: "case churn",
      compare: wire({
        cases: [caseRow(), caseRow({ caseKey: "ck_new", status: "new_case" })],
      }),
    },
    {
      label: "scenario config change",
      compare: wire({ cases: [caseRow({ configChanged: true })] }),
    },
    {
      label: "evaluation config change",
      compare: wire({ evaluationConfigChanged: true }),
    },
    {
      label: "unequal iteration weighting",
      compare: wire({
        cases: [
          caseRow({
            compare: {
              outcome: "passed",
              iterationIds: ["c1", "c2"],
              representativeIterationId: "c1",
              error: null,
            },
          }),
        ],
      }),
    },
  ];

  for (const { label, compare } of MISMATCHES) {
    assert.equal(
      exitCodeFor(compare, comparePolicyFromOptions({ gateRegressions: true })),
      EVAL_GATE_INCOMPLETE_EXIT_CODE,
      // Each of these would otherwise exit 1 on the very same numbers. The
      // point is that a changed population must never read as a regression.
      `${label} must be incomplete, not a regression`
    );
  }
});

test("1 — a population mismatch does NOT mask a deterministic regression", () => {
  // Per-case regressions join by caseKey, so they survive a changed
  // population. A real failure outranks an undecidable gate.
  assert.equal(
    exitCodeFor(
      wire({
        cases: [
          caseRow({ scoreDeltas: [REGRESSED_DELTA] }),
          caseRow({ caseKey: "ck_new", status: "new_case" }),
        ],
      }),
      comparePolicyFromOptions({
        gateRegressions: true,
        gateDeterministicRegressions: true,
      })
    ),
    1
  );
});

test("3 — either side's integrity invalid, with --gate-deterministic-regressions", () => {
  for (const sides of [
    { baseIntegrity: "invalid" as const },
    { compareIntegrity: "invalid" as const },
    { baseIntegrity: null },
    { compareIntegrity: null },
  ]) {
    assert.equal(
      exitCodeFor(
        wire({
          ...sides,
          basePassed: 56,
          comparePassed: 56,
          compareTotal: 70,
          cases: [caseRow({ scoreDeltas: [REGRESSED_DELTA] })],
        }),
        comparePolicyFromOptions({ gateDeterministicRegressions: true })
      ),
      EVAL_GATE_INCOMPLETE_EXIT_CODE,
      // A real regression is present, and it must NOT be reported when the
      // evidence for it did not verify.
      JSON.stringify(sides)
    );
  }
});

test("3 — a missing p95 makes the latency gate incomplete, not passing", () => {
  assert.equal(
    exitCodeFor(
      wire({ basePassed: 56, comparePassed: 56, compareTotal: 70 }),
      comparePolicyFromOptions({ maxP95LatencyIncreaseMs: "100" }),
      { baseP95Ms: 500 }
    ),
    EVAL_GATE_INCOMPLETE_EXIT_CODE
  );
});

test("no policy at all exits 0 — a comparison with nothing to gate on", () => {
  assert.equal(exitCodeFor(wire({}), comparePolicyFromOptions({})), 0);
});
