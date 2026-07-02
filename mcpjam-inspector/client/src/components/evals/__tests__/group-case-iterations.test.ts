import { describe, it, expect } from "vitest";
import {
  groupCaseIterations,
  caseRunBatchKey,
} from "../runs/group-case-iterations";
import type { EvalIteration } from "../types";

function makeIteration(over: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it",
    createdBy: "u1",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 0,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...over,
  } as EvalIteration;
}

describe("group-case-iterations", () => {
  it("groups suite-run iterations by suiteRunId", () => {
    const iters = [
      makeIteration({ _id: "a", suiteRunId: "run1", iterationNumber: 1, createdAt: 10 }),
      makeIteration({ _id: "b", suiteRunId: "run1", iterationNumber: 2, createdAt: 11 }),
    ];
    const batches = groupCaseIterations(iters);
    expect(batches).toHaveLength(1);
    expect(batches[0].key).toBe("suite:run1");
    expect(batches[0].iterations.map((i) => i._id)).toEqual(["a", "b"]);
  });

  it("groups quick-run iterations by metadata.compareRunId", () => {
    const iters = [
      makeIteration({ _id: "a", metadata: { compareRunId: "c1" }, createdAt: 5 }),
      makeIteration({ _id: "b", metadata: { compareRunId: "c1" }, createdAt: 6 }),
    ];
    const batches = groupCaseIterations(iters);
    expect(batches).toHaveLength(1);
    expect(batches[0].key).toBe("compare:c1");
  });

  it("keeps iterations with no batch key standalone (by id)", () => {
    const iters = [
      makeIteration({ _id: "a", createdAt: 1 }),
      makeIteration({ _id: "b", createdAt: 2 }),
    ];
    const batches = groupCaseIterations(iters);
    expect(batches).toHaveLength(2);
    expect(caseRunBatchKey(iters[0])).toBe("solo:a");
  });

  it("orders iterations by iterationNumber and batches newest-first", () => {
    const iters = [
      makeIteration({ _id: "old", suiteRunId: "r1", iterationNumber: 2, createdAt: 100 }),
      makeIteration({ _id: "older", suiteRunId: "r1", iterationNumber: 1, createdAt: 90 }),
      makeIteration({ _id: "new", suiteRunId: "r2", iterationNumber: 1, createdAt: 200 }),
    ];
    const batches = groupCaseIterations(iters);
    expect(batches.map((b) => b.key)).toEqual(["suite:r2", "suite:r1"]);
    // within r1, iterationNumber asc
    expect(batches[1].iterations.map((i) => i._id)).toEqual(["older", "old"]);
  });

  it("returns empty for no iterations", () => {
    expect(groupCaseIterations([])).toEqual([]);
  });
});
