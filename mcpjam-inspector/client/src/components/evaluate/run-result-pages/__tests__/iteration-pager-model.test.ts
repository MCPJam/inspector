import { describe, expect, it } from "vitest";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../../evals/types";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import { pagerPosition } from "../iteration-pager-model";

function run(id: string, overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: "sonnet",
    runNumber: 1,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
    ...overrides,
  } as EvalSuiteRun;
}

function iteration(
  id: string,
  runId: string,
  title: string,
  result: string,
  iterationNumber?: number,
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: title.toLowerCase(),
    status: result === "pending" ? "running" : "completed",
    result,
    iterationNumber,
    actualToolCalls: [],
    tokensUsed: 0,
    startedAt: 1,
    updatedAt: 1,
    testCaseSnapshot: {
      title,
      model: "sonnet",
      provider: "anthropic",
      query: title,
      expectedToolCalls: [],
    },
  } as EvalIteration;
}

const one = run("one");
const two = run("two", { runNumber: 2, namedHostId: "cursor" });

const matrix = buildRunResultsMatrix<EvalSuiteRunListItem>({
  run: one,
  runs: [one, two],
  iterations: [
    iteration("a1", "one", "Alpha", "passed", 1),
    iteration("a2", "one", "Alpha", "failed", 2),
    iteration("a3", "one", "Alpha", "passed", 3),
    iteration("b1", "one", "Beta", "failed", 1),
    iteration("x1", "two", "Alpha", "passed", 1),
  ],
  hostNamesById: new Map(),
});
const column = (runId: string) =>
  matrix.targets.find((target) => target.run._id === runId)?.key ?? "";

describe("pagerPosition", () => {
  it("walks only the open test case's iterations, in the test case page's order", () => {
    // Failures first, then the rest in their original order.
    expect(pagerPosition(matrix, column("one"), "alpha", "a1")).toEqual({
      index: 1,
      total: 3,
      prev: { caseKey: "alpha", iterationId: "a2", label: "Iteration #2" },
      next: { caseKey: "alpha", iterationId: "a3", label: "Iteration #3" },
    });
  });

  it("has no neighbor past either end, even when other test cases follow", () => {
    const first = pagerPosition(matrix, column("one"), "alpha", "a2");
    const last = pagerPosition(matrix, column("one"), "alpha", "a3");
    expect(first?.prev).toBeUndefined();
    expect(last?.next).toBeUndefined();
    expect(pagerPosition(matrix, column("one"), "beta", "b1")).toEqual({
      index: 0,
      total: 1,
      prev: undefined,
      next: undefined,
    });
  });

  it("stays on the iteration's own client and model", () => {
    expect(pagerPosition(matrix, column("two"), "alpha", "x1")).toMatchObject({
      index: 0,
      total: 1,
    });
  });

  it("returns null for an iteration outside the test case, or an unknown column", () => {
    expect(pagerPosition(matrix, column("one"), "beta", "a1")).toBeNull();
    expect(pagerPosition(matrix, "nope", "alpha", "a1")).toBeNull();
  });
});
