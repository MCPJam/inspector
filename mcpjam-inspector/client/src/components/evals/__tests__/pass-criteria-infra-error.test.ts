import { describe, expect, it } from "vitest";
import {
  computeIterationResult,
  computeMeasuredIterationResult,
  evaluatePassCriteria,
  isInfraErrorIteration,
} from "../pass-criteria";
import { aggregateSuite } from "../helpers";
import type { EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

const infraError = {
  class: "rate_limited" as const,
  layer: "model" as const,
  retryable: true,
  httpStatus: 429,
};

function iteration(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it",
    suiteRunId: "run-1",
    testCaseId: "case-1",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 10,
    actualToolCalls: [],
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

const infraRow = iteration({
  status: "failed",
  result: "failed",
  infraError,
});

describe("infra-error rows (E1) in client pass rates", () => {
  it("keeps the Failed label but measures nothing", () => {
    expect(isInfraErrorIteration(infraRow)).toBe(true);
    // The label path is unchanged — no new UI.
    expect(computeIterationResult(infraRow)).toBe("failed");
    // The rate path leaves it out.
    expect(computeMeasuredIterationResult(infraRow)).toBe("infra_error");
    expect(computeMeasuredIterationResult(iteration({}))).toBe("passed");
  });

  it("evaluatePassCriteria excludes infra rows from the rate", () => {
    const evaluation = evaluatePassCriteria(
      { _id: "run-1" } as unknown as EvalSuiteRun,
      [iteration({}), infraRow],
      { type: "minimumPassRate", minimumPassRate: 100 },
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.details?.overallPassRate).toBe(100);
  });

  it("aggregateSuite counts an infra row in no bucket", () => {
    const aggregate = aggregateSuite(
      {} as EvalSuite,
      [],
      [iteration({}), iteration({ result: "failed" }), infraRow],
    );
    expect(aggregate.totals).toMatchObject({ passed: 1, failed: 1 });
  });
});
