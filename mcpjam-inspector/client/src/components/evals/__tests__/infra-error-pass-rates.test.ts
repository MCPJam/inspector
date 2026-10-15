/**
 * A trial OUR infrastructure failed (`infraError`) is stored `failed` +
 * `failed`. It keeps its "Failed" label, but every pass rate the browser
 * computes must leave it out — numerator AND denominator — exactly as the
 * backend's legacy header, run metrics and v2 verdict do. One row set, every
 * client rate, one answer.
 */
import { describe, expect, it } from "vitest";
import {
  computeIterationResult,
  computeMeasuredIterationResult,
  evaluatePassCriteria,
} from "../pass-criteria";
import { runMetricsFromIterations } from "../run-metrics";
import { computeRunEffectiveStats } from "../suite-runs-list";
import { aggregateSuite } from "../helpers";
import { measuredResultCounts } from "../../evaluate/run-results-matrix-model";
import { pairingPassRate } from "../../evaluate/run-verdict-hero-deltas";
import type { EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

function iteration(
  id: string,
  partial: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: "run-1",
    testCaseId: "case-1",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 1,
    testCaseSnapshot: {
      title: "case",
      query: "q",
      provider: "anthropic",
      model: "claude",
      expectedToolCalls: [],
    },
    ...partial,
  } as unknown as EvalIteration;
}

const infra = iteration("infra", {
  status: "failed",
  result: "failed",
  error: "The AI provider is temporarily unavailable.",
  infraError: {
    class: "provider_unavailable",
    layer: "model",
    retryable: true,
    code: "provider_error",
    httpStatus: 503,
  },
});
const rows = [
  iteration("pass"),
  iteration("fail", { result: "failed" }),
  infra,
];
const run = {
  _id: "run-1",
  status: "completed",
  summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
} as unknown as EvalSuiteRun;

describe("infra-error rows in client pass rates", () => {
  it("keeps the Failed label but reads as unmeasured for rates", () => {
    expect(computeIterationResult(infra)).toBe("failed");
    expect(computeMeasuredIterationResult(infra)).toBe("infra_error");
    // A row without the marker is unchanged.
    expect(computeMeasuredIterationResult(rows[1]!)).toBe("failed");
  });

  it("every client rate over the same rows is 1 of 2", () => {
    expect(
      evaluatePassCriteria(run, rows, {
        type: "minimumPassRate",
        minimumPassRate: 50,
      }).details?.overallPassRate,
    ).toBe(50);

    expect(runMetricsFromIterations(rows).results).toMatchObject({
      passed: 1,
      failed: 1,
      infraError: 1,
    });

    expect(computeRunEffectiveStats(run, rows)).toEqual({
      effectivePassed: 1,
      effectiveTotal: 2,
      passRate: 50,
    });

    const aggregate = aggregateSuite({} as EvalSuite, [], rows);
    expect(aggregate.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(aggregate.byCase[0]).toMatchObject({ passed: 1, failed: 1 });

    const counts = measuredResultCounts(rows);
    expect(counts).toMatchObject({ passed: 1, failed: 1 });
    expect(pairingPassRate(counts)).toBe(50);
  });

  it("a run our infrastructure failed entirely falls back to the summary, never 0%", () => {
    const allInfra = [infra, { ...infra, _id: "infra-2" } as EvalIteration];
    const inconclusive = {
      ...run,
      result: "inconclusive",
      summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
    } as unknown as EvalSuiteRun;
    expect(computeRunEffectiveStats(inconclusive, allInfra)).toEqual({
      effectivePassed: 0,
      effectiveTotal: 0,
      passRate: null,
    });
  });
});
