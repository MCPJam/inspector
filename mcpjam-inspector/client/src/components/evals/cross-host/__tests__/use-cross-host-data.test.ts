import { describe, it, expect } from "vitest";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../../types";

// Exercise the data-shaping logic directly by calling the hook's memoized
// computation via a thin helper that skips the React useMemo wrapper.
// The hook is a thin useMemo shell; the real logic is the closure body.

function makeCase(id: string, title = `Case ${id}`): EvalCase {
  return {
    _id: id,
    testSuiteId: "s1",
    createdBy: "u1",
    title,
    query: "q",
    models: [{ model: "gpt-4o", provider: "openai" }],
    runs: 1,
    expectedToolCalls: [],
  };
}

function makeRun(
  id: string,
  namedHostId?: string,
  createdAt = Date.now(),
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "s1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "r1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "passed",
    createdAt,
    ...(namedHostId ? { namedHostId } : {}),
  } as EvalSuiteRun;
}

function makeIteration(
  id: string,
  opts: {
    suiteRunId?: string;
    testCaseId?: string;
    result?: "passed" | "failed" | "pending";
  } = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: opts.suiteRunId,
    testCaseId: opts.testCaseId,
    createdBy: "u1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    iterationNumber: 1,
    status: "completed",
    result: opts.result ?? "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 100,
  } as EvalIteration;
}

function makeSuite(
  attachments: Array<{ namedHostId: string; hostName: string | null }> = [],
): EvalSuite {
  return {
    _id: "s1",
    createdBy: "u1",
    name: "My Suite",
    description: "",
    configRevision: "r1",
    environment: { servers: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostAttachments: attachments.map((a) => ({
      namedHostId: a.namedHostId,
      hostName: a.hostName,
      enabledOptionalServerIds: [],
      resolvedServerNames: [],
    })),
  };
}

// Import the hook's computation inline by re-implementing the shape logic here.
// The real test target is `use-cross-host-data.ts`; this mirrors the logic to
// avoid requiring a React test renderer for pure data-shaping.
import {
  buildCellTrendSeries,
  useCrossHostData,
} from "../use-cross-host-data";
import { renderHook } from "@testing-library/react";

describe("useCrossHostData", () => {
  it("returns empty state when no host attachments and no iterations", () => {
    const { result } = renderHook(() =>
      useCrossHostData(makeSuite(), [], [], []),
    );
    expect(result.current.hasHostAttachments).toBe(false);
    expect(result.current.hasAnyData).toBe(false);
    expect(result.current.hostColumns).toHaveLength(0);
    expect(result.current.caseRows).toHaveLength(0);
  });

  it("returns host columns from attachments even with no run data", () => {
    const suite = makeSuite([
      { namedHostId: "h1", hostName: "Claude" },
      { namedHostId: "h2", hostName: "Cursor" },
    ]);
    const { result } = renderHook(() =>
      useCrossHostData(suite, [], [], []),
    );
    expect(result.current.hasHostAttachments).toBe(true);
    expect(result.current.hasAnyData).toBe(false);
    expect(result.current.hostColumns).toHaveLength(2);
    expect(result.current.hostColumns[0].hostId).toBe("h1");
    expect(result.current.hostColumns[1].isHistorical).toBe(false);
  });

  it("populates matrix from runs and iterations", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1"), makeCase("c2")];
    const run = makeRun("r1", "h1");
    const iter1 = makeIteration("i1", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const iter2 = makeIteration("i2", {
      suiteRunId: "r1",
      testCaseId: "c2",
      result: "failed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run], [iter1, iter2]),
    );
    expect(result.current.hasAnyData).toBe(true);
    const c1Cell = result.current.matrix.get("c1")?.get("h1");
    expect(c1Cell?.passCount).toBe(1);
    expect(c1Cell?.failCount).toBe(0);
    const c2Cell = result.current.matrix.get("c2")?.get("h1");
    expect(c2Cell?.failCount).toBe(1);
  });

  it("computes average tokens per iteration in a cell", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const run = makeRun("r1", "h1");
    const iter1 = makeIteration("i1", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const iter2 = {
      ...makeIteration("i2", {
        suiteRunId: "r1",
        testCaseId: "c1",
        result: "passed",
      }),
      tokensUsed: 300,
    } as EvalIteration;
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run], [iter1, iter2]),
    );
    const cell = result.current.matrix.get("c1")?.get("h1");
    expect(cell?.avgTokensPerIteration).toBe(200);
  });

  it("adds historical fallback column for namedHostId no longer attached", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacyRun = makeRun("r2", "h_old");
    const iter = makeIteration("i3", {
      suiteRunId: "r2",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [legacyRun], [iter]),
    );
    const historical = result.current.hostColumns.find(
      (c) => c.hostId === "h_old",
    );
    expect(historical).toBeDefined();
    expect(historical?.isHistorical).toBe(true);
  });

  it("excludes orphaned iterations whose run is not in the runs list", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    // No run with id "r_orphan" in the runs array
    const orphanIter = makeIteration("i_orph", {
      suiteRunId: "r_orphan",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [], [orphanIter]),
    );
    expect(result.current.hasAnyData).toBe(false);
  });

  it("excludes iterations from runs with no namedHostId", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacyRun = makeRun("r_legacy"); // no namedHostId
    const iter = makeIteration("i4", {
      suiteRunId: "r_legacy",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [legacyRun], [iter]),
    );
    expect(result.current.hasAnyData).toBe(false);
  });

  it("handles empty cell when a (case, host) pair has no iterations", () => {
    const suite = makeSuite([
      { namedHostId: "h1", hostName: "Claude" },
      { namedHostId: "h2", hostName: "Cursor" },
    ]);
    const cases = [makeCase("c1")];
    const run = makeRun("r1", "h1");
    const iter = makeIteration("i5", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run], [iter]),
    );
    // h2 has no iterations — cell should be absent from matrix
    const c1h2 = result.current.matrix.get("c1")?.get("h2");
    expect(c1h2).toBeUndefined();
  });

  it("does not attach trendSeries when cellTrends is false", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const run1 = makeRun("r1", "h1", 1000);
    const run2 = makeRun("r2", "h1", 2000);
    const iter1 = makeIteration("i1", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const iter2 = makeIteration("i2", {
      suiteRunId: "r2",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run1, run2], [iter1, iter2]),
    );
    expect(result.current.matrix.get("c1")?.get("h1")?.trendSeries).toBeUndefined();
  });

  it("attaches chronological trendSeries when cellTrends is true", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const run1 = makeRun("r1", "h1", 1000);
    const run2 = makeRun("r2", "h1", 2000);
    const iter1 = makeIteration("i1", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const iter2 = makeIteration("i2", {
      suiteRunId: "r2",
      testCaseId: "c1",
      result: "failed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run1, run2], [iter1, iter2], {
        cellTrends: true,
      }),
    );
    const cell = result.current.matrix.get("c1")?.get("h1");
    expect(cell?.trendSeries).toHaveLength(2);
    expect(cell?.trendSeries?.[0].runId).toBe("r1");
    expect(cell?.trendSeries?.[0].result).toBe("passed");
    expect(cell?.trendSeries?.[1].runId).toBe("r2");
    expect(cell?.trendSeries?.[1].result).toBe("failed");
    // Snapshot still reflects latest run only
    expect(cell?.passCount).toBe(0);
    expect(cell?.failCount).toBe(1);
  });

  it("buildCellTrendSeries supports uneven host histories", () => {
    const suite = makeSuite([
      { namedHostId: "h1", hostName: "MCPJam" },
      { namedHostId: "h2", hostName: "ChatGPT" },
    ]);
    const cases = [makeCase("c1")];
    const runs = [
      makeRun("r1", "h1", 1000),
      makeRun("r2", "h1", 2000),
      makeRun("r3", "h1", 3000),
      makeRun("r4", "h2", 4000),
    ];
    const iterations = [
      makeIteration("i1", { suiteRunId: "r1", testCaseId: "c1" }),
      makeIteration("i2", { suiteRunId: "r2", testCaseId: "c1" }),
      makeIteration("i3", { suiteRunId: "r3", testCaseId: "c1" }),
      makeIteration("i4", { suiteRunId: "r4", testCaseId: "c1" }),
    ];
    const runHostMap = new Map([
      ["r1", "h1"],
      ["r2", "h1"],
      ["r3", "h1"],
      ["r4", "h2"],
    ]);
    const activeRunIds = new Set(runs.map((r) => r._id));

    const h1Series = buildCellTrendSeries(
      "c1",
      "h1",
      runs,
      iterations,
      runHostMap,
      activeRunIds,
      (id) => id,
    );
    const h2Series = buildCellTrendSeries(
      "c1",
      "h2",
      runs,
      iterations,
      runHostMap,
      activeRunIds,
      (id) => id,
    );

    expect(h1Series).toHaveLength(3);
    expect(h2Series).toHaveLength(1);
    expect(h1Series.map((p) => p.runId)).toEqual(["r1", "r2", "r3"]);
    expect(h2Series[0].runId).toBe("r4");
    void suite;
    void cases;
  });
});
