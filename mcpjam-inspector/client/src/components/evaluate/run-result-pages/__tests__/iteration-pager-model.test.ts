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
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: title.toLowerCase(),
    status: result === "pending" ? "running" : "completed",
    result,
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

function matrixOf(iterations: EvalIteration[]) {
  return buildRunResultsMatrix<EvalSuiteRunListItem>({
    run: one,
    runs: [one, two],
    iterations,
    hostNamesById: new Map(),
  });
}

const iterations = [
  iteration("a1", "one", "Alpha", "passed"),
  iteration("a2", "one", "Alpha", "failed"),
  iteration("b1", "one", "Beta", "passed"),
  iteration("c1", "one", "Charlie", "failed"),
  iteration("c2", "one", "Charlie", "failed"),
  iteration("x1", "two", "Alpha", "passed"),
  iteration("x2", "two", "Beta", "failed"),
];
const matrix = matrixOf(iterations);
const column = (runId: string) =>
  matrix.targets.find((target) => target.run._id === runId)?.key ?? "";
/** Follows `next` from `start`, which must be the walk's first entry. */
const walk = (runId: string, start: string, filters = {}) => {
  const seen: string[] = [];
  for (let id: string | undefined = start; id;) {
    seen.push(id);
    id = pagerPosition(matrix, column(runId), id, filters)?.next?.iterationId;
  }
  return seen;
};

describe("pagerPosition", () => {
  it("walks one column in grid row order, each cell failures first", () => {
    // Rows: Charlie (two failures), then Alpha and Beta (one each) by title.
    expect(walk("one", "c1")).toEqual(["c1", "c2", "a2", "a1", "b1"]);
    expect(pagerPosition(matrix, column("one"), "a2")).toEqual({
      index: 2,
      total: 5,
      prev: { caseKey: "charlie", caseTitle: "Charlie", iterationId: "c2" },
      next: { caseKey: "alpha", caseTitle: "Alpha", iterationId: "a1" },
    });
  });

  it("has no neighbor past either end", () => {
    const first = pagerPosition(matrix, column("one"), "c1");
    const last = pagerPosition(matrix, column("one"), "b1");
    expect(first?.prev).toBeUndefined();
    expect(last?.next).toBeUndefined();
  });

  it("walks a sibling run's column on its own", () => {
    expect(walk("two", "x1")).toEqual(["x1", "x2"]);
  });

  it("applies search to rows and status to this column's own cell", () => {
    const failed = { status: "failed" };
    // Beta failed on the sibling column only, so it is not walked here.
    expect(walk("one", "c1", failed)).toEqual(["c1", "c2", "a2", "a1"]);
    expect(
      pagerPosition(matrix, column("one"), "c2", {
        ...failed,
        search: " CHAR ",
      }),
    ).toMatchObject({ index: 1, total: 2, next: undefined });
    expect(pagerPosition(matrix, column("two"), "x2", failed)).toMatchObject({
      index: 0,
      total: 1,
    });
  });

  it("walks everything when the open iteration is outside the filters", () => {
    expect(
      pagerPosition(matrix, column("one"), "b1", { status: "failed" }),
    ).toMatchObject({ index: 4, total: 5 });
  });

  it("follows the new order when a live result reorders the rows", () => {
    const live = matrixOf([
      ...iterations.filter((item) => item._id !== "b1"),
      iteration("b1", "one", "Beta", "failed"),
      iteration("b2", "one", "Beta", "failed"),
    ]);
    const key = live.targets[0]?.key ?? "";
    expect(pagerPosition(live, key, "b1")).toMatchObject({
      index: 0,
      next: { iterationId: "b2" },
    });
  });

  it("returns null for an unknown iteration or column", () => {
    expect(pagerPosition(matrix, column("one"), "nope")).toBeNull();
    expect(pagerPosition(matrix, "nope", "a1")).toBeNull();
  });
});
