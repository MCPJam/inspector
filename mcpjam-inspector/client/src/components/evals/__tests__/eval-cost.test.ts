import { describe, expect, it } from "vitest";
import {
  COST_UNAVAILABLE,
  costUnavailableReason,
  formatCost,
  formatCostOrDash,
  isRunnerReportedCost,
  iterationCosts,
  sumIterationCost,
} from "../helpers";
import type { EvalIteration } from "../types";

/**
 * The one rule this whole surface rests on: a cost we did not observe is an
 * em dash, never `$0.00`.
 *
 * The backend deliberately omits `estimatedCostUsd` rather than writing a
 * zero (BYOK model, harness run, no tokens). If any formatter here coerced
 * that absence to a number, every downstream reading — the per-case p95, the
 * run total, the metric strip, a CI cost gate — would quietly treat unpriced
 * work as free.
 */

function iteration(usage?: EvalIteration["usage"]): any {
  return { usage };
}

describe("formatCost", () => {
  it("keeps sub-cent amounts visible instead of rounding them to zero", () => {
    // A single eval trial routinely costs a fraction of a cent; `$0.00` for it
    // is the same lie as `$0.00` for an unpriced one.
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(0.00001)).toBe("$0.0000");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(-0.25)).toBe("-$0.25");
  });

  it("renders an observed zero as zero", () => {
    // A cost that WAS observed and is genuinely zero is a real fact.
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("formatCostOrDash", () => {
  it("renders an absent cost as an em dash, never as $0.00", () => {
    expect(formatCostOrDash(undefined)).toBe(COST_UNAVAILABLE);
    expect(formatCostOrDash(null)).toBe(COST_UNAVAILABLE);
    expect(formatCostOrDash(0)).toBe("$0.00");
  });
});

describe("costUnavailableReason", () => {
  it("explains each absence in the reader's terms", () => {
    expect(
      costUnavailableReason({ status: "not_reported", reason: "no_pricing" }),
    ).toMatch(/not an mcpjam-billed model/i);
    expect(
      costUnavailableReason({
        status: "not_reported",
        reason: "harness_mixed_models",
      }),
    ).toMatch(/billed attribution/i);
    expect(
      costUnavailableReason({ status: "not_reported", reason: "no_tokens" }),
    ).toMatch(/no token usage/i);
  });

  it("says nothing when MCPJam priced the trial itself", () => {
    expect(
      costUnavailableReason({ status: "estimated", source: "gateway_pricing" }),
    ).toBeNull();
  });

  it("still explains a runner-reported cost, which is real but not ours", () => {
    // The number exists; what it is NOT is MCPJam's own measurement.
    expect(
      costUnavailableReason({
        status: "provider_reported",
        source: "sdk_runner",
      }),
    ).toMatch(/your runner/i);
  });

  it("has an answer for a trial with no basis at all", () => {
    expect(costUnavailableReason(undefined)).toMatch(/no cost was recorded/i);
  });
});

describe("isRunnerReportedCost", () => {
  it("flags only a customer runner's own figure", () => {
    expect(
      isRunnerReportedCost({
        status: "provider_reported",
        source: "sdk_runner",
      }),
    ).toBe(true);
    expect(
      isRunnerReportedCost({ status: "estimated", source: "gateway_pricing" }),
    ).toBe(false);
    expect(isRunnerReportedCost(undefined)).toBe(false);
  });
});

describe("sumIterationCost", () => {
  it("reports the total with the coverage that produced it", () => {
    const result = sumIterationCost([
      iteration({ estimatedCostUsd: 0.01 }),
      iteration({ estimatedCostUsd: 0.02 }),
    ]);
    expect(result.totalUsd).toBeCloseTo(0.03);
    expect(result).toMatchObject({ costedIterations: 2, totalIterations: 2 });
  });

  it("exposes a PARTIAL sum rather than passing it off as the total", () => {
    // Without the counts this is indistinguishable from a run that really
    // cost one cent — which is how a half-priced run reads as a cheap one.
    const result = sumIterationCost([
      iteration({ estimatedCostUsd: 0.01 }),
      iteration({
        costBasis: { status: "not_reported", reason: "no_pricing" },
      }),
      iteration(undefined),
    ]);
    expect(result.totalUsd).toBeCloseTo(0.01);
    expect(result).toMatchObject({ costedIterations: 1, totalIterations: 3 });
  });

  it("reports null, not 0, when nothing was priced", () => {
    const result = sumIterationCost([iteration(undefined), iteration({})]);
    expect(result.totalUsd).toBeNull();
    expect(result).toMatchObject({ costedIterations: 0, totalIterations: 2 });
  });

  it("handles an empty run without inventing a zero", () => {
    expect(sumIterationCost([])).toEqual({
      totalUsd: null,
      costedIterations: 0,
      totalIterations: 0,
    });
  });
});

describe("iterationCosts", () => {
  it("omits unpriced iterations rather than counting them as zero", () => {
    // Percentiles are computed over this list. A zero for each unpriced trial
    // would drag a p50 toward zero and make a run look cheaper the LESS of it
    // we managed to price.
    expect(
      iterationCosts([
        iteration({ estimatedCostUsd: 0.05 }),
        iteration(undefined),
        iteration({ estimatedCostUsd: 0.01 }),
      ]),
    ).toEqual([0.05, 0.01]);
  });
});
