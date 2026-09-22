import { describe, expect, it } from "vitest";
import {
  aggregateSuite,
  computeIterationSummary,
  sortExploreCasesBySignal,
} from "../helpers";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  SuiteAggregate,
} from "../types";

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
  overrides: Partial<EvalIteration> & Pick<EvalIteration, "result" | "status">
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
      iterations
    );
    expect(sorted.map((c) => c._id)).toEqual(["w", "p"]);
  });
});

describe("aggregateSuite model labels", () => {
  it("marks mixed model snapshots instead of using the first one", () => {
    const testCase = makeCase("case-1", "Matrix case");
    const iterations = [
      makeIter("case-1", {
        testCaseSnapshot: {
          title: "Matrix case",
          query: "q",
          provider: "openai",
          model: "gpt-5",
          expectedToolCalls: [],
        },
        result: "passed",
        status: "completed",
        resultSource: "reported",
      }),
      makeIter("case-1", {
        testCaseSnapshot: {
          title: "Matrix case",
          query: "q",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          expectedToolCalls: [],
        },
        result: "failed",
        status: "completed",
        resultSource: "reported",
      }),
    ];
    const aggregate = aggregateSuite(
      { _id: "suite" } as EvalSuite,
      [testCase],
      iterations
    );
    expect(aggregate.byCase[0]).toMatchObject({
      provider: "multiple",
      model: "multiple",
      passed: 1,
      failed: 1,
    });
  });

  it("marks a snapshot row mixed with a PRE-SNAPSHOT row as mixed", () => {
    // The legacy iteration carries no snapshot, so it is labelled from the
    // case's current model — a different model from the snapshot's. Keying only
    // the snapshot-bearing rows would see one key and stamp the whole case
    // "gpt-5" while the counters fold in an iteration that ran claude.
    const testCase = {
      ...makeCase("case-1", "Matrix case"),
      models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
    } as EvalCase;
    const aggregate = aggregateSuite(
      { _id: "suite" } as EvalSuite,
      [testCase],
      [
        makeIter("case-1", {
          testCaseSnapshot: {
            title: "Matrix case",
            query: "q",
            provider: "openai",
            model: "gpt-5",
            expectedToolCalls: [],
          },
          result: "passed",
          status: "completed",
          resultSource: "reported",
        }),
        makeIter("case-1", {
          result: "failed",
          status: "completed",
          resultSource: "reported",
        }),
      ]
    );
    expect(aggregate.byCase[0]).toMatchObject({
      provider: "multiple",
      model: "multiple",
      passed: 1,
      failed: 1,
    });
  });

  it("stays single-model when a pre-snapshot row agrees with the snapshot", () => {
    // Same fallback, same key: a legacy row whose case model matches the
    // snapshot is not a mix, and must keep its real label rather than
    // degrading to "multiple" just for lacking a snapshot.
    const testCase = {
      ...makeCase("case-1", "Matrix case"),
      models: [{ provider: "openai", model: "gpt-5" }],
    } as EvalCase;
    const aggregate = aggregateSuite(
      { _id: "suite" } as EvalSuite,
      [testCase],
      [
        makeIter("case-1", {
          testCaseSnapshot: {
            title: "Matrix case",
            query: "q",
            provider: "openai",
            model: "gpt-5",
            expectedToolCalls: [],
          },
          result: "passed",
          status: "completed",
          resultSource: "reported",
        }),
        makeIter("case-1", {
          result: "passed",
          status: "completed",
          resultSource: "reported",
        }),
      ]
    );
    expect(aggregate.byCase[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      passed: 2,
    });
  });
});

describe("computeIterationSummary", () => {
  it("counts timed-out status without an explicit result as failed", () => {
    const summary = computeIterationSummary([
      {
        _id: "iter-timeout",
        testCaseId: "case",
        createdBy: "u",
        createdAt: 1,
        updatedAt: 2,
        iterationNumber: 1,
        actualToolCalls: [],
        tokensUsed: 0,
        status: "timed_out",
      } as EvalIteration,
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.pending).toBe(0);
  });
});
