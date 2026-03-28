import { describe, expect, it } from "vitest";
import { sortExploreCasesBySignal } from "../helpers";
import type { EvalCase, EvalIteration, SuiteAggregate } from "../types";

function makeCase(id: string, title: string, isNegative = false): EvalCase {
  return {
    _id: id,
    testSuiteId: "suite",
    createdBy: "u",
    title,
    query: "q",
    models: [],
    runs: 1,
    expectedToolCalls: [],
    isNegativeTest: isNegative,
  };
}

function makeIter(
  testCaseId: string,
  overrides: Partial<EvalIteration> & Pick<EvalIteration, "result" | "status">,
): EvalIteration {
  return {
    _id: `iter-${testCaseId}-${Math.random()}`,
    testCaseId,
    createdBy: "u",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  } as EvalIteration;
}

describe("sortExploreCasesBySignal", () => {
  it("orders failures before passes", () => {
    const a = makeCase("a", "Alpha");
    const b = makeCase("b", "Beta");
    const aggregate: SuiteAggregate = {
      filteredIterations: [],
      totals: {
        passed: 1,
        failed: 1,
        cancelled: 0,
        pending: 0,
        tokens: 0,
      },
      byCase: [
        {
          testCaseId: "a",
          title: "Alpha",
          provider: "",
          model: "",
          runs: 1,
          passed: 0,
          failed: 1,
          cancelled: 0,
          tokens: 0,
        },
        {
          testCaseId: "b",
          title: "Beta",
          provider: "",
          model: "",
          runs: 1,
          passed: 1,
          failed: 0,
          cancelled: 0,
          tokens: 0,
        },
      ],
    };
    const iterations: EvalIteration[] = [
      makeIter("a", {
        status: "completed",
        result: "failed",
      }),
      makeIter("b", {
        status: "completed",
        result: "passed",
      }),
    ];
    const sorted = sortExploreCasesBySignal([b, a], aggregate, iterations);
    expect(sorted.map((c) => c._id)).toEqual(["a", "b"]);
  });

  it("places pending iterations in the middle tier", () => {
    const pass = makeCase("p", "Pass");
    const pend = makeCase("w", "Wait");
    const aggregate: SuiteAggregate = {
      filteredIterations: [],
      totals: {
        passed: 0,
        failed: 0,
        cancelled: 0,
        pending: 1,
        tokens: 0,
      },
      byCase: [
        {
          testCaseId: "p",
          title: "Pass",
          provider: "",
          model: "",
          runs: 1,
          passed: 1,
          failed: 0,
          cancelled: 0,
          tokens: 0,
        },
        {
          testCaseId: "w",
          title: "Wait",
          provider: "",
          model: "",
          runs: 1,
          passed: 0,
          failed: 0,
          cancelled: 0,
          tokens: 0,
        },
      ],
    };
    const iterations: EvalIteration[] = [
      makeIter("p", {
        status: "completed",
        result: "passed",
      }),
      makeIter("w", {
        status: "running",
        result: "pending",
      }),
    ];
    const sorted = sortExploreCasesBySignal(
      [pend, pass],
      aggregate,
      iterations,
    );
    expect(sorted.map((c) => c._id)).toEqual(["w", "p"]);
  });
});
