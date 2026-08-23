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

/**
 * A run launched against a Project Environment: `namedHostId` is the
 * environment's RESOLVED host, and `configSnapshot.environmentRef` carries the
 * environment identity the backend froze at run start.
 */
function makeEnvironmentRun(
  id: string,
  resolvedHostId: string,
  environmentId: string,
  revision = 1,
  createdAt = Date.now(),
): EvalSuiteRun {
  const run = makeRun(id, resolvedHostId, createdAt);
  return {
    ...run,
    configSnapshot: {
      ...run.configSnapshot,
      environmentRef: { environmentId, name: `Env ${environmentId}`, revision },
    },
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
  extras: { environmentIds?: string[] } = {},
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
    ...(extras.environmentIds ? { environmentIds: extras.environmentIds } : {}),
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
    const c1Cell = result.current.matrix.get("c1")?.get("h1::client-default");
    expect(c1Cell?.passCount).toBe(1);
    expect(c1Cell?.failCount).toBe(0);
    const c2Cell = result.current.matrix.get("c2")?.get("h1::client-default");
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
    const cell = result.current.matrix.get("c1")?.get("h1::client-default");
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

  it("names a historical column from the project host list", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacyRun = makeRun("r2", "h_old");
    const iter = makeIteration("i3", {
      suiteRunId: "r2",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [legacyRun], [iter], {
        hostNamesById: new Map([["h_old", "Cursor"]]),
      }),
    );
    const historical = result.current.hostColumns.find(
      (c) => c.hostId === "h_old",
    );
    // Named, but STILL historical — it is genuinely detached from the suite.
    expect(historical?.hostName).toBe("Cursor");
    expect(historical?.isHistorical).toBe(true);
  });

  it("names the resolved host of an environment-backed run and does not mark it historical", () => {
    // Environment-backed suites carry NO host attachments; the backend stamps
    // the environment's resolved host on the run instead.
    const suite = makeSuite();
    const cases = [makeCase("c1")];
    const run = makeEnvironmentRun("r1", "h_env", "env1", 3);
    const iter = makeIteration("i1", {
      suiteRunId: "r1",
      testCaseId: "c1",
      result: "passed",
    });
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run], [iter], {
        hostNamesById: new Map([["h_env", "Claude"]]),
      }),
    );
    expect(result.current.hostColumns).toEqual([
      {
        hostId: "h_env",
        columnKey: "h_env::client-default",
        modelKey: "client-default",
        modelLabel: null,
        hostName: "Claude",
        isHistorical: false,
      },
    ]);
    expect(result.current.matrix.get("c1")?.get("h_env::client-default")?.passCount).toBe(1);
  });

  it("collapses two environments resolving to the same host into one column", () => {
    const suite = makeSuite();
    const cases = [makeCase("c1")];
    const runA = makeEnvironmentRun("rA", "h_env", "envA", 1, 1000);
    const runB = makeEnvironmentRun("rB", "h_env", "envB", 1, 2000);
    const iters = [
      makeIteration("iA", {
        suiteRunId: "rA",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("iB", {
        suiteRunId: "rB",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [runA, runB], iters, {
        hostNamesById: new Map([["h_env", "Claude"]]),
      }),
    );
    expect(result.current.hostColumns).toHaveLength(1);
    expect(result.current.hostColumns[0].hostId).toBe("h_env");
    // Latest run wins the cell, exactly as it does for host-backed reruns.
    expect(result.current.matrix.get("c1")?.get("h_env::client-default")?.failCount).toBe(1);
  });

  it("keeps a host historical when only legacy runs reached it", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const envRun = makeEnvironmentRun("rEnv", "h_env", "env1", 1, 1000);
    const legacyRun = makeRun("rOld", "h_old", 2000);
    const iters = [
      makeIteration("iEnv", {
        suiteRunId: "rEnv",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("iOld", {
        suiteRunId: "rOld",
        testCaseId: "c1",
        result: "passed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [envRun, legacyRun], iters),
    );
    const byId = new Map(
      result.current.hostColumns.map((c) => [c.hostId, c] as const),
    );
    expect(byId.get("h1")?.isHistorical).toBe(false);
    expect(byId.get("h_env")?.isHistorical).toBe(false);
    expect(byId.get("h_old")?.isHistorical).toBe(true);
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
    const c1h2 = result.current.matrix.get("c1")?.get("h2::client-default");
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
    expect(
      result.current.matrix.get("c1")?.get("h1::client-default")?.trendSeries
    ).toBeUndefined();
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
    const cell = result.current.matrix.get("c1")?.get("h1::client-default");
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

  it("splits one host into two columns for default + override", () => {
    const suite = makeSuite();
    const cases = [makeCase("c1")];
    const inherit = makeEnvironmentRun("rInherit", "h1", "env-inherit", 1, 1000);
    const override = {
      ...makeEnvironmentRun("rOverride", "h1", "env-override", 1, 2000),
      modelSource: "override" as const,
      effectiveModelId: "google/gemini-2.5-flash",
    };
    const iters = [
      makeIteration("i1", {
        suiteRunId: "rInherit",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("i2", {
        suiteRunId: "rOverride",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [inherit, override], iters, {
        hostNamesById: new Map([["h1", "Claude"]]),
        environments: [
          { environmentId: "env-inherit", hostId: "h1" },
          {
            environmentId: "env-override",
            hostId: "h1",
            modelId: "google/gemini-2.5-flash",
          },
        ],
      }),
    );
    expect(result.current.hostColumns).toHaveLength(2);
    expect(result.current.hostColumns.map((c) => c.columnKey)).toEqual([
      "h1::client-default",
      "h1::google/gemini-2.5-flash",
    ]);
    expect(result.current.hostColumns.every((c) => c.hostId === "h1")).toBe(true);
    expect(
      result.current.matrix.get("c1")?.get("h1::client-default")?.passCount
    ).toBe(1);
    expect(
      result.current.matrix.get("c1")?.get("h1::google/gemini-2.5-flash")
        ?.failCount
    ).toBe(1);
  });

  it("merges a legacy host-backed run into the client-default cell", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacy = makeRun("rLegacy", "h1", 1000);
    const inherit = makeEnvironmentRun("rEnv", "h1", "env1", 1, 2000);
    const iters = [
      makeIteration("i1", {
        suiteRunId: "rLegacy",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("i2", {
        suiteRunId: "rEnv",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [legacy, inherit], iters, {
        environments: [{ environmentId: "env1", hostId: "h1" }],
      }),
    );
    expect(result.current.hostColumns).toHaveLength(1);
    expect(result.current.hostColumns[0].columnKey).toBe("h1::client-default");
    // Latest run (env inherit) wins the cell.
    expect(
      result.current.matrix.get("c1")?.get("h1::client-default")?.failCount
    ).toBe(1);
  });

  it("splits a (host, model) cell when shared slots collide", () => {
    const suite = makeSuite();
    const cases = [makeCase("c1")];
    const runA = makeEnvironmentRun("rA", "h1", "envA", 1, 1000);
    const runB = makeEnvironmentRun("rB", "h1", "envB", 1, 2000);
    const iters = [
      makeIteration("iA", {
        suiteRunId: "rA",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("iB", {
        suiteRunId: "rB",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [runA, runB], iters, {
        hostNamesById: new Map([["h1", "Claude"]]),
        environments: [
          {
            environmentId: "envA",
            hostId: "h1",
            computerEnvironmentId: "img-sandbox-aaaa",
          },
          {
            environmentId: "envB",
            hostId: "h1",
            computerEnvironmentId: "img-sandbox-bbbb",
          },
        ],
      }),
    );
    expect(result.current.hostColumns).toHaveLength(2);
    expect(result.current.hostColumns.map((c) => c.columnKey)).toEqual([
      "h1::client-default::envA",
      "h1::client-default::envB",
    ]);
    expect(result.current.hostColumns[0].splitLabel).toMatch(/sandbox-/);
    // Telling the columns apart is the whole point of splitting them.
    expect(result.current.hostColumns[0].splitLabel).not.toBe(
      result.current.hostColumns[1].splitLabel,
    );
  });

  it("annotates a split by the slot that actually differs, not the sandbox pin", () => {
    const suite = makeSuite();
    const cases = [makeCase("c1")];
    const runA = makeEnvironmentRun("rA", "h1", "envA", 1, 1000);
    const runB = makeEnvironmentRun("rB", "h1", "envB", 1, 2000);
    const iters = [
      makeIteration("iA", {
        suiteRunId: "rA",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("iB", {
        suiteRunId: "rB",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [runA, runB], iters, {
        hostNamesById: new Map([["h1", "Claude"]]),
        environments: [
          // Same image on both, so the sandbox is NOT what separates them —
          // the server group is. Labelling by the pin would print the same
          // annotation twice and name the wrong dimension.
          {
            environmentId: "envA",
            hostId: "h1",
            serverAttachmentId: "att-aaaa",
            computerEnvironmentId: "img-shared",
          },
          {
            environmentId: "envB",
            hostId: "h1",
            serverAttachmentId: "att-bbbb",
            computerEnvironmentId: "img-shared",
          },
        ],
      }),
    );
    const labels = result.current.hostColumns.map((c) => c.splitLabel);
    expect(labels).toEqual(["servers-aaaa", "servers-bbbb"]);
  });

  it("keeps a persisted inherit run on client-default after the env is edited", () => {
    const suite = makeSuite([], { environmentIds: ["env1"] });
    const cases = [makeCase("c1")];
    const inherit = {
      ...makeEnvironmentRun("rInherit", "h1", "env1", 1, 1000),
      modelSource: "client_default" as const,
      effectiveModelId: "anthropic/claude-sonnet-4-6",
    };
    const iters = [
      makeIteration("i1", {
        suiteRunId: "rInherit",
        testCaseId: "c1",
        result: "passed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [inherit], iters, {
        environments: [
          {
            environmentId: "env1",
            hostId: "h1",
            modelId: "google/gemini-2.5-flash",
          },
        ],
      }),
    );
    const keys = result.current.hostColumns.map((c) => c.columnKey);
    expect(keys).toContain("h1::client-default");
    expect(
      result.current.matrix.get("c1")?.get("h1::client-default")?.passCount
    ).toBe(1);
    expect(
      result.current.matrix.get("c1")?.get("h1::google/gemini-2.5-flash")
        ?.passCount ?? 0
    ).toBe(0);
  });

  it("keeps a persisted override on its original model after the env model changes", () => {
    const suite = makeSuite([], { environmentIds: ["env1"] });
    const cases = [makeCase("c1")];
    const override = {
      ...makeEnvironmentRun("rOverride", "h1", "env1", 1, 1000),
      modelSource: "override" as const,
      effectiveModelId: "google/gemini-2.5-flash",
    };
    const iters = [
      makeIteration("i1", {
        suiteRunId: "rOverride",
        testCaseId: "c1",
        result: "failed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [override], iters, {
        environments: [
          {
            environmentId: "env1",
            hostId: "h1",
            modelId: "openai/gpt-4o",
          },
        ],
      }),
    );
    expect(
      result.current.matrix.get("c1")?.get("h1::google/gemini-2.5-flash")
        ?.failCount
    ).toBe(1);
    expect(
      result.current.matrix.get("c1")?.get("h1::openai/gpt-4o")?.failCount ?? 0
    ).toBe(0);
  });

  it("does not mint columns for named environments that are not on the suite", () => {
    const suite = makeSuite([], { environmentIds: ["env-suite"] });
    const cases = [makeCase("c1")];
    const run = makeEnvironmentRun("r1", "h1", "env-suite", 1, 1000);
    const iters = [
      makeIteration("i1", {
        suiteRunId: "r1",
        testCaseId: "c1",
        result: "passed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [run], iters, {
        environments: [
          { environmentId: "env-suite", hostId: "h1" },
          { environmentId: "env-other", hostId: "h2" },
        ],
      }),
    );
    expect(result.current.hostColumns.map((c) => c.hostId)).toEqual(["h1"]);
    expect(result.current.hostColumns.map((c) => c.columnKey)).toEqual([
      "h1::client-default",
    ]);
  });

  it("still mints a column for a run-referenced environment no longer on the suite", () => {
    const suite = makeSuite([], { environmentIds: ["env-suite"] });
    const cases = [makeCase("c1")];
    const historical = makeEnvironmentRun("rOld", "h2", "env-old", 1, 1000);
    const iters = [
      makeIteration("i1", {
        suiteRunId: "rOld",
        testCaseId: "c1",
        result: "passed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [historical], iters, {
        environments: [
          { environmentId: "env-suite", hostId: "h1" },
          { environmentId: "env-old", hostId: "h2" },
        ],
      }),
    );
    const keys = result.current.hostColumns.map((c) => c.columnKey).sort();
    expect(keys).toEqual(["h1::client-default", "h2::client-default"]);
  });

  it("keeps a residual column for a legacy run when a (host, model) group splits", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacy = makeRun("rLegacy", "h1", 500);
    const runA = makeEnvironmentRun("rA", "h1", "envA", 1, 1000);
    const runB = makeEnvironmentRun("rB", "h1", "envB", 1, 2000);
    const iters = [
      makeIteration("iL", {
        suiteRunId: "rLegacy",
        testCaseId: "c1",
        result: "passed",
      }),
      makeIteration("iA", {
        suiteRunId: "rA",
        testCaseId: "c1",
        result: "failed",
      }),
      makeIteration("iB", {
        suiteRunId: "rB",
        testCaseId: "c1",
        result: "passed",
      }),
    ];
    const { result } = renderHook(() =>
      useCrossHostData(suite, cases, [legacy, runA, runB], iters, {
        environments: [
          {
            environmentId: "envA",
            hostId: "h1",
            serverAttachmentId: "att-aaaa",
          },
          {
            environmentId: "envB",
            hostId: "h1",
            serverAttachmentId: "att-bbbb",
          },
        ],
      }),
    );
    const keys = result.current.hostColumns.map((c) => c.columnKey);
    expect(keys).toEqual([
      "h1::client-default::envA",
      "h1::client-default::envB",
      "h1::client-default",
    ]);
    expect(
      result.current.matrix.get("c1")?.get("h1::client-default")?.passCount
    ).toBe(1);
  });
});
