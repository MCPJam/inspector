import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EvalSuiteRun } from "../types";

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, { args: { runId: string } }>>,
  results: {} as Record<string, unknown>,
}));

vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, { args: { runId: string } }>) => {
    mocks.requests.push(queries);
    return Object.fromEntries(
      Object.keys(queries).map((key) => [key, mocks.results[key]]),
    );
  },
}));

import { runPageRunIds, useRunsIterations } from "../use-runs-iterations";

function run(partial: Partial<EvalSuiteRun>): EvalSuiteRun {
  return {
    status: "completed",
    suiteId: "suite",
    createdAt: 0,
    ...partial,
  } as unknown as EvalSuiteRun;
}

describe("useRunsIterations", () => {
  it("subscribes one read per requested run, and none when disabled", () => {
    mocks.requests = [];
    mocks.results = {
      a: { iterations: [{ _id: "i1", suiteRunId: "a" }] },
      b: undefined,
    };
    const { result } = renderHook(() => useRunsIterations(["a", "b", "a"]));
    expect(Object.keys(mocks.requests.at(-1) ?? {}).sort()).toEqual(["a", "b"]);
    expect(result.current.iterations.map((row) => row._id)).toEqual(["i1"]);
    expect(result.current.isLoading).toBe(true);

    renderHook(() => useRunsIterations(["a"], false));
    expect(mocks.requests.at(-1)).toEqual({});
  });

  it("reports a failed read without treating it as loading", () => {
    mocks.results = { gone: new Error("Suite run not found") };
    const { result } = renderHook(() => useRunsIterations(["gone"]));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.failedRunIds.has("gone")).toBe(true);
    expect(result.current.iterations).toEqual([]);
  });
});

describe("runPageRunIds", () => {
  it("reads the run's launch and the launch before it, never the suite", () => {
    const runs = [
      run({ _id: "old", runNumber: 1, createdAt: 1 }),
      run({ _id: "prev-a", runNumber: 2, runGroupId: "g1", createdAt: 2 }),
      run({ _id: "prev-b", runNumber: 2, runGroupId: "g1", createdAt: 2 }),
      run({ _id: "cur-a", runNumber: 3, runGroupId: "g2", createdAt: 3 }),
      run({ _id: "cur-b", runNumber: 3, runGroupId: "g2", createdAt: 3 }),
    ];
    const ids = runPageRunIds(runs[3], runs, null);
    expect(ids).toEqual(
      expect.arrayContaining(["cur-a", "cur-b", "prev-a", "prev-b"]),
    );
    expect(ids).not.toContain("old");
  });

  it("includes an explicit baseline", () => {
    const runs = [
      run({ _id: "base", runNumber: 1, createdAt: 1 }),
      run({ _id: "mid", runNumber: 2, createdAt: 2 }),
      run({ _id: "cur", runNumber: 3, createdAt: 3 }),
    ];
    expect(runPageRunIds(runs[2], runs, "base")).toContain("base");
  });
});
