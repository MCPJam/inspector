/**
 * `evaluateCompareGates` — the comparative half of the gate engine.
 *
 * The population matrix is the centre of this file. Most of the risk in a
 * comparison gate is not the arithmetic (pinned in compare-stats.test.ts) but
 * the question of whether the two runs measured the same thing at all: a gate
 * that compares whole-run rates across different populations reports
 * confident nonsense.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateCompareGates,
  type CompareGateInput,
} from "../src/compare-gates.js";
import type { GateInput, GatePolicy } from "../src/gates.js";

function side(
  passed: number,
  total: number,
  extra: Partial<GateInput> = {}
): GateInput {
  return {
    iterations: { passed, total },
    scoreIntegrity: "valid",
    ...extra,
  };
}

function input(overrides: Partial<CompareGateInput> = {}): CompareGateInput {
  return {
    base: side(56, 70),
    compare: side(48, 80),
    deterministicScoreRegressions: [],
    scoreDeltasAvailable: true,
    caseSetChanged: false,
    scenarioConfigChanged: false,
    evaluationConfigChanged: false,
    iterationWeightingEqual: true,
    ...overrides,
  };
}

function verdictFor(
  report: ReturnType<typeof evaluateCompareGates>,
  gate: string
) {
  const verdict = report.verdicts.find((row) => row.gate === gate);
  if (!verdict) throw new Error(`no verdict for gate "${gate}"`);
  return verdict;
}

describe("evaluateCompareGates — pass-rate regression", () => {
  it("fails on a significant, material drop", () => {
    // The oracle's 56/70 -> 48/80 row: CI entirely below zero.
    const report = evaluateCompareGates(input(), { passRateRegression: {} });
    expect(report.outcome).toBe("failed");
    expect(verdictFor(report, "passRateRegression").message).toContain(
      "-0.2000"
    );
  });

  it("passes when the drop is not significant", () => {
    const report = evaluateCompareGates(
      input({ base: side(8, 10), compare: side(7, 10) }),
      { passRateRegression: {} }
    );
    expect(report.outcome).toBe("passed");
  });

  it("passes on an improvement", () => {
    const report = evaluateCompareGates(
      input({ base: side(48, 80), compare: side(56, 70) }),
      { passRateRegression: {} }
    );
    expect(report.outcome).toBe("passed");
  });

  it("is incomplete, not passed, below the minimum sample size", () => {
    const report = evaluateCompareGates(
      input({ base: side(4, 4), compare: side(0, 4) }),
      { passRateRegression: {} }
    );
    expect(report.outcome).toBe("incomplete");
    const verdict = verdictFor(report, "passRateRegression");
    expect(verdict.status).toBe("non_gateable");
    // Names the actual sample sizes, so the fix is obvious from CI output.
    expect(verdict.message).toContain("base 4");
    expect(verdict.message).toContain("compare 4");
  });

  it("honours a custom minimum effect size", () => {
    const args = input({
      base: side(99_000, 100_000),
      compare: side(98_500, 100_000),
    });
    expect(evaluateCompareGates(args, { passRateRegression: {} }).outcome).toBe(
      "passed"
    );
    expect(
      evaluateCompareGates(args, {
        passRateRegression: { minEffectSize: 0.001 },
      }).outcome
    ).toBe("failed");
  });
});

describe("evaluateCompareGates — population matrix", () => {
  const POPULATION_BREAKERS: Array<{
    label: string;
    override: Partial<CompareGateInput>;
    expectedCondition: string;
  }> = [
    {
      label: "a case was added or removed",
      override: { caseSetChanged: true },
      expectedCondition: "caseSetChanged",
    },
    {
      label: "a scenario's own config changed",
      override: { scenarioConfigChanged: true },
      expectedCondition: "scenarioConfigChanged",
    },
    {
      label: "the run-level evaluation config changed",
      override: { evaluationConfigChanged: true },
      expectedCondition: "evaluationConfigChanged",
    },
    {
      label: "a shared case ran a different iteration count",
      override: { iterationWeightingEqual: false },
      expectedCondition: "iterationWeightingEqual",
    },
  ];

  it.each(POPULATION_BREAKERS)(
    "$label alone makes the statistical and p95 gates non-gateable",
    ({ override, expectedCondition }) => {
      const report = evaluateCompareGates(
        input({
          ...override,
          base: side(56, 70, { totals: { e2eP95Ms: 100 } }),
          compare: side(48, 80, { totals: { e2eP95Ms: 5000 } }),
        }),
        {
          passRateRegression: {},
          maximumP95LatencyIncreaseMs: 10,
        }
      );

      const statistical = verdictFor(report, "passRateRegression");
      const latency = verdictFor(report, "maximumP95LatencyIncreaseMs");
      expect(statistical.status).toBe("non_gateable");
      expect(latency.status).toBe("non_gateable");
      // The message must name WHICH condition failed: "not comparable" alone
      // is an unactionable CI line.
      expect(statistical.message).toContain(expectedCondition);
      expect(latency.message).toContain(expectedCondition);
      // Both gates would otherwise have FAILED loudly. Incomplete, not failed.
      expect(report.outcome).toBe("incomplete");
    }
  );

  it.each(POPULATION_BREAKERS)(
    "$label does NOT stop a deterministic regression from firing",
    ({ override }) => {
      const report = evaluateCompareGates(
        input({
          ...override,
          deterministicScoreRegressions: [
            { caseKey: "ck_a", scorerId: "tool-match" },
          ],
        }),
        { noDeterministicRegressions: true, passRateRegression: {} }
      );

      // Per-case regressions join by caseKey, so they survive a changed
      // population — and a real failure outranks the undecidable stat gate.
      expect(verdictFor(report, "noDeterministicRegressions").status).toBe(
        "failed"
      );
      expect(report.outcome).toBe("failed");
    }
  );

  it("evaluates everything when the population is clean", () => {
    const report = evaluateCompareGates(
      input({
        base: side(56, 70, { totals: { e2eP95Ms: 100 } }),
        compare: side(48, 80, { totals: { e2eP95Ms: 120 } }),
      }),
      {
        passRateRegression: {},
        maximumP95LatencyIncreaseMs: 50,
        noDeterministicRegressions: true,
      }
    );
    expect(
      report.verdicts.every((verdict) => verdict.status !== "non_gateable")
    ).toBe(true);
  });

  it("names every broken condition at once", () => {
    const report = evaluateCompareGates(
      input({ caseSetChanged: true, iterationWeightingEqual: false }),
      { passRateRegression: {} }
    );
    const message = verdictFor(report, "passRateRegression").message;
    expect(message).toContain("caseSetChanged");
    expect(message).toContain("iterationWeightingEqual");
  });
});

describe("evaluateCompareGates — deterministic regressions", () => {
  it("passes with no regressions", () => {
    const report = evaluateCompareGates(input(), {
      noDeterministicRegressions: true,
    });
    expect(report.outcome).toBe("passed");
  });

  it("names the offending case and scorer", () => {
    const report = evaluateCompareGates(
      input({
        deterministicScoreRegressions: [
          { caseKey: "ck_a", scorerId: "tool-match" },
          { caseKey: "ck_b", scorerId: "exact-output" },
        ],
      }),
      { noDeterministicRegressions: true }
    );
    const verdict = verdictFor(report, "noDeterministicRegressions");
    expect(verdict.status).toBe("failed");
    expect(verdict.message).toContain("ck_a/tool-match");
    expect(verdict.message).toContain("ck_b/exact-output");
  });

  it("is non-gateable when no per-case deltas were available", () => {
    const report = evaluateCompareGates(
      input({ scoreDeltasAvailable: false }),
      { noDeterministicRegressions: true }
    );
    expect(verdictFor(report, "noDeterministicRegressions").status).toBe(
      "non_gateable"
    );
    expect(report.outcome).toBe("incomplete");
  });
});

describe("evaluateCompareGates — integrity of BOTH sides", () => {
  const INTEGRITY_CASES: Array<{
    label: string;
    base: "valid" | "invalid" | undefined;
    compare: "valid" | "invalid" | undefined;
    gateable: boolean;
    expectedIntegrity: string;
  }> = [
    {
      label: "both valid",
      base: "valid",
      compare: "valid",
      gateable: true,
      expectedIntegrity: "valid",
    },
    {
      label: "base invalid",
      base: "invalid",
      compare: "valid",
      gateable: false,
      expectedIntegrity: "invalid",
    },
    {
      label: "compare invalid",
      base: "valid",
      compare: "invalid",
      gateable: false,
      expectedIntegrity: "invalid",
    },
    {
      label: "base absent",
      base: undefined,
      compare: "valid",
      gateable: false,
      expectedIntegrity: "unknown",
    },
    {
      label: "compare absent",
      base: "valid",
      compare: undefined,
      gateable: false,
      expectedIntegrity: "unknown",
    },
    {
      label: "both absent",
      base: undefined,
      compare: undefined,
      gateable: false,
      expectedIntegrity: "unknown",
    },
  ];

  it.each(INTEGRITY_CASES)(
    "$label -> deterministic gate gateable=$gateable",
    ({ base, compare, gateable, expectedIntegrity }) => {
      const report = evaluateCompareGates(
        input({
          base: side(56, 70, { scoreIntegrity: base }),
          compare: side(48, 80, { scoreIntegrity: compare }),
          deterministicScoreRegressions: [
            { caseKey: "ck_a", scorerId: "tool-match" },
          ],
        }),
        { noDeterministicRegressions: true }
      );
      const verdict = verdictFor(report, "noDeterministicRegressions");
      // A real regression is present. It must NOT be reported when the
      // evidence for it did not verify — that would be gating on garbage.
      expect(verdict.status).toBe(gateable ? "failed" : "non_gateable");
      expect(report.scoreIntegrity).toBe(expectedIntegrity);
    }
  );

  it("leaves the pass-rate gate decidable when integrity is absent", () => {
    // Pass rate is derived from run counters, not from score evidence, so it
    // survives an integrity failure. This is what makes a comparison usable
    // before the backend verifies scores at all.
    const report = evaluateCompareGates(
      input({
        base: side(56, 70, { scoreIntegrity: undefined }),
        compare: side(48, 80, { scoreIntegrity: undefined }),
      }),
      { passRateRegression: {} }
    );
    expect(verdictFor(report, "passRateRegression").status).toBe("failed");
  });
});

describe("evaluateCompareGates — p95 latency", () => {
  it("passes an increase within budget and fails one beyond it", () => {
    const withLatency = (baseMs: number, compareMs: number) =>
      input({
        base: side(56, 70, { totals: { e2eP95Ms: baseMs } }),
        compare: side(56, 70, { totals: { e2eP95Ms: compareMs } }),
      });
    expect(
      evaluateCompareGates(withLatency(100, 140), {
        maximumP95LatencyIncreaseMs: 50,
      }).outcome
    ).toBe("passed");
    expect(
      evaluateCompareGates(withLatency(100, 200), {
        maximumP95LatencyIncreaseMs: 50,
      }).outcome
    ).toBe("failed");
  });

  it("treats a latency DECREASE as passing", () => {
    expect(
      evaluateCompareGates(
        input({
          base: side(56, 70, { totals: { e2eP95Ms: 500 } }),
          compare: side(56, 70, { totals: { e2eP95Ms: 100 } }),
        }),
        { maximumP95LatencyIncreaseMs: 0 }
      ).outcome
    ).toBe("passed");
  });

  it("is non-gateable when either side has no p95", () => {
    for (const [baseMs, compareMs] of [
      [undefined, 100],
      [100, undefined],
    ] as const) {
      const report = evaluateCompareGates(
        input({
          base: side(56, 70, {
            totals: baseMs === undefined ? {} : { e2eP95Ms: baseMs },
          }),
          compare: side(56, 70, {
            totals: compareMs === undefined ? {} : { e2eP95Ms: compareMs },
          }),
        }),
        { maximumP95LatencyIncreaseMs: 50 }
      );
      expect(verdictFor(report, "maximumP95LatencyIncreaseMs").status).toBe(
        "non_gateable"
      );
    }
  });
});

describe("evaluateCompareGates — shape", () => {
  it("evaluates nothing for an empty policy", () => {
    const report = evaluateCompareGates(input(), {});
    expect(report.verdicts).toEqual([]);
    expect(report.outcome).toBe("passed");
  });

  it("a real failure outranks an undecidable gate", () => {
    const report = evaluateCompareGates(
      input({
        caseSetChanged: true,
        deterministicScoreRegressions: [
          { caseKey: "ck_a", scorerId: "tool-match" },
        ],
      }),
      { noDeterministicRegressions: true, passRateRegression: {} }
    );
    expect(report.outcome).toBe("failed");
  });

  it("flakiness is NOT a gate", () => {
    const policy: GatePolicy = {};
    // @ts-expect-error — there is deliberately no flakiness field on
    // GatePolicy. Flakiness is reported, never gated: the baseline run was
    // probably flaky too, so failing on it fails on noise the change did not
    // introduce.
    policy.maximumFlakyCases = 0;
    expect(evaluateCompareGates(input(), policy).verdicts).toEqual([]);
  });
});

describe("evaluateCompareGates — an empty comparison is never a pass", () => {
  it("floors the minimum sample at 1 even when the policy says 0", () => {
    // `--min-sample-size 0` would otherwise let two EMPTY runs reach the
    // statistic, come back `no_regression`, and exit 0 — a green gate over
    // nothing at all.
    const report = evaluateCompareGates(
      input({ base: side(0, 0), compare: side(0, 0) }),
      { passRateRegression: { minSampleSize: 0 } }
    );
    expect(verdictFor(report, "passRateRegression").status).toBe(
      "non_gateable"
    );
    expect(report.outcome).toBe("incomplete");
  });

  it("still honours a deliberately low, non-zero floor", () => {
    expect(
      evaluateCompareGates(input({ base: side(1, 1), compare: side(0, 1) }), {
        passRateRegression: { minSampleSize: 1 },
      }).verdicts[0].status
    ).not.toBe("non_gateable");
  });
});

describe("evaluateCompareGates — cost increase", () => {
  /**
   * The gate the whole cost effort exists for: "did my change make this more
   * expensive?" A percentage rather than an absolute delta, because an
   * absolute one goes stale on every prompt and model change — the exact
   * failure of the fixed per-trial token ceiling this replaces.
   *
   * Every non-gateable case below is a case where a number COULD be computed
   * and would mislead. That is the bar: refuse rather than answer wrongly.
   */
  const full = (costUsd: number) => ({
    costUsd,
    costCoverage: { costed: 4, total: 4 },
  });

  const policy: GatePolicy = { maximumCostIncreasePercent: 10 };

  it("passes an increase within the allowance", () => {
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: full(1.05) }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("passed");
    expect(verdict.message).toMatch(/\+5\.0%/);
  });

  it("fails an increase beyond it", () => {
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: full(1.5) }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("failed");
    expect(verdict.observed).toBeCloseTo(50);
  });

  it("refuses a side whose coverage is absent, rather than assuming it full", () => {
    // A base run answered by a deployment predating cost coverage carries a
    // cost and no coverage block. Treating that absence as full coverage
    // judges a regression against a partial sum from an older platform —
    // which is precisely what the field being optional is meant to prevent.
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: { costUsd: 1.0 } }),
        compare: side(4, 4, { totals: full(1.5) }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("non_gateable");
    expect(verdict.message).toMatch(/base run does not report how much/i);
  });

  it("refuses the compare side too, not only the base", () => {
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: { costUsd: 1.5 } }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("non_gateable");
    expect(verdict.message).toMatch(/compare run does not report how much/i);
  });

  it("passes a run that got cheaper", () => {
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: full(0.5) }),
      }),
      policy
    );
    expect(verdictFor(report, "maximumCostIncreasePercent").status).toBe(
      "passed"
    );
  });

  it("is NON-GATEABLE when either side has no cost", () => {
    // A BYOK or harness run reaches here. Reporting "cheaper" for a run
    // nobody priced is the failure mode.
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: { costUsd: undefined } as any }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("non_gateable");
    expect(verdict.message).toMatch(/no cost on the compare run/i);
  });

  it("is NON-GATEABLE when either side is only partly priced", () => {
    // The partial side reads as the cheaper run whichever way the real costs
    // went, so a comparison between them is worse than no comparison.
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, {
          totals: { costUsd: 1.0, costCoverage: { costed: 1, total: 4 } },
        }),
        compare: side(4, 4, { totals: full(1.05) }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("non_gateable");
    expect(verdict.message).toMatch(/partially measured on the base run/i);
  });

  it("is NON-GATEABLE when the baseline cost nothing", () => {
    // A percentage of zero is not a number. Treating it as an infinite
    // increase would fail every run whose baseline happened to be free.
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(0) }),
        compare: side(4, 4, { totals: full(0.5) }),
      }),
      policy
    );
    const verdict = verdictFor(report, "maximumCostIncreasePercent");
    expect(verdict.status).toBe("non_gateable");
    expect(verdict.message).toMatch(/base run cost nothing/i);
  });

  it("is NON-GATEABLE when the two runs are not comparable populations", () => {
    // The population rule applies in full: a cost comparison across a changed
    // case set compares two different suites, not two versions of one.
    const report = evaluateCompareGates(
      input({
        base: side(4, 4, { totals: full(1.0) }),
        compare: side(4, 4, { totals: full(2.0) }),
        caseSetChanged: true,
      }),
      policy
    );
    expect(verdictFor(report, "maximumCostIncreasePercent").status).toBe(
      "non_gateable"
    );
  });
});
