/**
 * The statistics are the one genuinely novel surface in Tranche 2, so they are
 * pinned against an EXTERNAL oracle (statsmodels) rather than against a second
 * reading of the implementation. See `fixtures/newcombe-oracle.json`.
 *
 * Three layers, in order of how much they'd catch:
 *   1. exact bounds vs the oracle (catches a wrong formula)
 *   2. invariants (catches a formula that happens to fit six points)
 *   3. the verdict table (catches the policy wrapped around the maths)
 */
import { describe, expect, it } from "vitest";
import {
  assessPassRateRegression,
  detectFlakyCases,
  newcombeDifferenceInterval,
  wilsonInterval,
  Z_95,
} from "../src/compare-stats.js";
import oracle from "./fixtures/newcombe-oracle.json" with { type: "json" };

type OracleCase = {
  base: { passed: number; total: number };
  compare: { passed: number; total: number };
  delta: string;
  lower: string;
  upper: string;
};

const CASES = oracle.cases as OracleCase[];

describe("newcombeDifferenceInterval — external oracle", () => {
  it("pins the oracle's provenance in the fixture", () => {
    // If this drifts, the numbers below stopped being independent evidence.
    expect(oracle.__meta.statsmodelsVersion).toBe("0.14.6");
    expect(oracle.__meta.oracle).toContain('method="newcomb"');
    expect(CASES).toHaveLength(6);
  });

  it.each(CASES)(
    "base $base.passed/$base.total vs compare $compare.passed/$compare.total",
    ({ base, compare, delta, lower, upper }) => {
      const interval = newcombeDifferenceInterval({ base, compare });
      expect(interval.delta.toFixed(12)).toBe(delta);
      expect(interval.lower.toFixed(12)).toBe(lower);
      expect(interval.upper.toFixed(12)).toBe(upper);
    }
  );
});

describe("newcombeDifferenceInterval — invariants", () => {
  it.each(CASES)(
    "brackets its own delta and stays inside [-1,1] ($base.passed/$base.total vs $compare.passed/$compare.total)",
    ({ base, compare }) => {
      const { delta, lower, upper } = newcombeDifferenceInterval({
        base,
        compare,
      });
      expect(lower).toBeLessThanOrEqual(delta);
      expect(delta).toBeLessThanOrEqual(upper);
      expect(lower).toBeGreaterThanOrEqual(-1);
      expect(upper).toBeLessThanOrEqual(1);
    }
  );

  it.each(CASES)(
    "swapping the sides negates and mirrors the bounds ($base.passed/$base.total vs $compare.passed/$compare.total)",
    ({ base, compare }) => {
      const forward = newcombeDifferenceInterval({ base, compare });
      const reversed = newcombeDifferenceInterval({
        base: compare,
        compare: base,
      });
      // This is the property the pinned argument order protects: get it
      // backwards and every bound sign-reverses while still looking plausible.
      expect(reversed.delta).toBeCloseTo(-forward.delta, 12);
      expect(reversed.lower).toBeCloseTo(-forward.upper, 12);
      expect(reversed.upper).toBeCloseTo(-forward.lower, 12);
    }
  );

  it("straddles zero for identical inputs", () => {
    const interval = newcombeDifferenceInterval({
      base: { passed: 7, total: 10 },
      compare: { passed: 7, total: 10 },
    });
    expect(interval.delta).toBe(0);
    expect(interval.lower).toBeLessThan(0);
    expect(interval.upper).toBeGreaterThan(0);
  });

  it("tightens as n grows at a fixed rate", () => {
    const widths = [10, 100, 1000, 10_000].map((n) => {
      const { lower, upper } = newcombeDifferenceInterval({
        base: { passed: n * 0.8, total: n },
        compare: { passed: n * 0.7, total: n },
      });
      return upper - lower;
    });
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThan(widths[i - 1]);
    }
  });

  it("agrees with a Wald interval at large n, where Wald is trustworthy", () => {
    // Independent cross-check with a DIFFERENT method. Wald is unusable at the
    // small n and extreme rates this module exists for, but at n = 5000 and
    // mid-range rates the two must nearly coincide — if they do not, the
    // Newcombe implementation is wrong in a way six oracle rows might miss.
    const base = { passed: 4000, total: 5000 };
    const compare = { passed: 3800, total: 5000 };
    const pBase = base.passed / base.total;
    const pCompare = compare.passed / compare.total;
    const standardError = Math.sqrt(
      (pBase * (1 - pBase)) / base.total +
        (pCompare * (1 - pCompare)) / compare.total
    );
    const waldLower = pCompare - pBase - Z_95 * standardError;
    const waldUpper = pCompare - pBase + Z_95 * standardError;

    const interval = newcombeDifferenceInterval({ base, compare });
    expect(Math.abs(interval.lower - waldLower)).toBeLessThan(1e-3);
    expect(Math.abs(interval.upper - waldUpper)).toBeLessThan(1e-3);
  });
});

describe("wilsonInterval", () => {
  it("stays informative at p = 1, where Wald collapses to zero width", () => {
    const interval = wilsonInterval(10, 10);
    expect(interval.point).toBe(1);
    expect(interval.lower).toBeGreaterThan(0.6);
    expect(interval.lower).toBeLessThan(1);
    expect(interval.upper).toBe(1);
  });

  it("stays informative at p = 0", () => {
    const interval = wilsonInterval(0, 10);
    expect(interval.point).toBe(0);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeGreaterThan(0);
    expect(interval.upper).toBeLessThan(0.4);
  });

  it("reports no information for an empty sample rather than dividing by zero", () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 });
  });
});

describe("assessPassRateRegression", () => {
  it("calls a large, significant, material drop a regression", () => {
    // The oracle's 56/70 -> 48/80 row: upper is -0.0524, entirely below zero.
    const result = assessPassRateRegression({
      base: { passed: 56, total: 70 },
      compare: { passed: 48, total: 80 },
    });
    expect(result.verdict).toBe("regression");
    expect(result.upper.toFixed(12)).toBe("-0.052431472402");
  });

  it("does NOT call a small-sample drop a regression", () => {
    // 8/10 -> 9/10 sits well inside the noise floor at this n.
    expect(
      assessPassRateRegression({
        base: { passed: 8, total: 10 },
        compare: { passed: 9, total: 10 },
      }).verdict
    ).toBe("no_regression");
  });

  it("reports insufficient_data below the minimum sample size", () => {
    const result = assessPassRateRegression({
      base: { passed: 4, total: 4 },
      compare: { passed: 0, total: 4 },
    });
    // A 100-point drop, and STILL not gateable: 4 iterations cannot decide it.
    // Reporting `no_regression` here would be a lie in the other direction.
    expect(result.verdict).toBe("insufficient_data");
    expect(result.reason).toContain("at least 5");
    expect(result.delta).toBe(-1);
  });

  it("checks the minimum sample on EACH side, not on the total", () => {
    expect(
      assessPassRateRegression({
        base: { passed: 100, total: 100 },
        compare: { passed: 0, total: 4 },
      }).verdict
    ).toBe("insufficient_data");
  });

  it("withholds `regression` when the effect is significant but immaterial", () => {
    // n large enough that a 0.5-point drift is statistically real.
    const result = assessPassRateRegression({
      base: { passed: 99_000, total: 100_000 },
      compare: { passed: 98_500, total: 100_000 },
      minEffectSize: 0.01,
    });
    expect(result.upper).toBeLessThan(0);
    expect(result.delta).toBeCloseTo(-0.005, 10);
    // Real, and not worth failing anyone's build over.
    expect(result.verdict).toBe("no_regression");
  });

  it("honours a lowered minimum effect size", () => {
    expect(
      assessPassRateRegression({
        base: { passed: 99_000, total: 100_000 },
        compare: { passed: 98_500, total: 100_000 },
        minEffectSize: 0.001,
      }).verdict
    ).toBe("regression");
  });

  it("never reports a regression for an IMPROVEMENT", () => {
    expect(
      assessPassRateRegression({
        base: { passed: 48, total: 80 },
        compare: { passed: 56, total: 70 },
      }).verdict
    ).toBe("no_regression");
  });
});

describe("detectFlakyCases", () => {
  it("reports only cases that both passed and failed within the run", () => {
    expect(
      detectFlakyCases([
        { caseKey: "wobbly", passed: true },
        { caseKey: "wobbly", passed: false },
        { caseKey: "wobbly", passed: true },
        { caseKey: "solid", passed: true },
        { caseKey: "solid", passed: true },
        { caseKey: "broken", passed: false },
        { caseKey: "broken", passed: false },
      ])
    ).toEqual([{ caseKey: "wobbly", total: 3, passed: 2, failed: 1 }]);
  });

  it("is empty for a single-iteration run, which cannot show instability", () => {
    expect(
      detectFlakyCases([
        { caseKey: "a", passed: true },
        { caseKey: "b", passed: false },
      ])
    ).toEqual([]);
  });

  it("sorts by caseKey so the report is stable", () => {
    const flaky = detectFlakyCases([
      { caseKey: "zeta", passed: true },
      { caseKey: "zeta", passed: false },
      { caseKey: "alpha", passed: true },
      { caseKey: "alpha", passed: false },
    ]);
    expect(flaky.map((row) => row.caseKey)).toEqual(["alpha", "zeta"]);
  });
});
