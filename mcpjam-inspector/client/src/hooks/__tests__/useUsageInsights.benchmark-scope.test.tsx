import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAction, mockUseMutation, mockUseQuery } = vi.hoisted(() => ({
  mockUseAction: vi.fn(),
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: (...args: unknown[]) => mockUseAction(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

import { EMPTY_USAGE_FILTER } from "@/hooks/scenario-usage-filters";
import { useGoalOutcomeDrilldown, useUsageInsights } from "../useUsageInsights";

/** Every `useQuery` call the hook made, as `[name, args]`. */
function queryCalls(): Array<[string, unknown]> {
  return mockUseQuery.mock.calls as Array<[string, unknown]>;
}

function callFor(name: string) {
  return queryCalls().find(([queryName]) => queryName === name);
}

beforeEach(() => {
  mockUseAction.mockReset();
  mockUseMutation.mockReset();
  mockUseQuery.mockReset();
  mockUseAction.mockReturnValue(vi.fn());
  mockUseMutation.mockReturnValue(vi.fn());
  mockUseQuery.mockReturnValue(undefined);
});

describe("the benchmark scope reads its own cohort", () => {
  it("asks the benchmark breakdown query, keyed on the run", () => {
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );

    const call = callFor("chatSessions:getBenchmarkUsageBreakdown");
    expect(call).toBeTruthy();
    expect(call?.[1]).toMatchObject({ benchmarkRunId: "run_1" });
    // The scenario query is not merely skipped — it is never named. A
    // `kind === "swarm" ? … : …` ternary would have sent this scope down the
    // scenario arm and queried with `scenarioId: undefined`.
    expect(callFor("chatSessions:getUsageBreakdown")).toBeUndefined();
  });

  it("never subscribes to the thread list — there is no benchmark browser", () => {
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    expect(callFor("chatSessions:listByScenario")?.[1]).toBe("skip");
  });

  it("leaves the other two scopes exactly where they were", () => {
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "swarm", projectId: "proj_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    expect(callFor("chatSessions:getSwarmUsageBreakdown")?.[1]).toMatchObject({
      projectId: "proj_1",
    });

    mockUseQuery.mockClear();
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "scenario", scenarioId: "scn_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    expect(callFor("chatSessions:getUsageBreakdown")?.[1]).toMatchObject({
      scenarioId: "scn_1",
    });
  });
});

describe("rebuilding a benchmark flow is a paid action", () => {
  it("calls the analyzer action rather than a clustering mutation", async () => {
    const generate = vi.fn().mockResolvedValue({
      status: "generating",
      traceDigest: "digest_1",
      traceCount: 12,
    });
    mockUseAction.mockReturnValue(generate);

    const { result } = renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );

    const outcome = await result.current.rebuild();
    expect(generate).toHaveBeenCalledWith({ benchmarkRunId: "run_1" });
    expect(outcome).toMatchObject({ status: "running", alreadyRunning: false });
  });

  it("reports a cached reading as already-running rather than a fresh queue", async () => {
    mockUseAction.mockReturnValue(
      vi.fn().mockResolvedValue({
        status: "ready",
        traceDigest: "digest_1",
        traceCount: 12,
      }),
    );

    const { result } = renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );

    expect(await result.current.rebuild()).toMatchObject({
      status: "done",
      alreadyRunning: true,
    });
  });

  it("throws a refusal instead of reporting a queue that does not exist", async () => {
    mockUseAction.mockReturnValue(
      vi.fn().mockResolvedValue({
        status: "unavailable",
        reason: "analyzer_feature_unregistered",
      }),
    );

    const { result } = renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );

    await expect(result.current.rebuild()).rejects.toThrow(
      "analyzer_feature_unregistered",
    );
  });
});

describe("a benchmark node click has nothing to drill into yet", () => {
  it("skips the drill-down rather than borrowing the swarm query", () => {
    const { result } = renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: { kind: "benchmark", benchmarkRunId: "run_1" },
        clusterId: null,
        outcome: undefined,
      }),
    );

    // Borrowing `listSwarmSessionsBySelection` would narrow a PROJECT's
    // sessions and present them as this run's traces; falling through to the
    // scenario query would ask about no scenario at all. Neither is issued.
    expect(
      callFor("chatSessions:listSwarmSessionsBySelection"),
    ).toBeUndefined();
    expect(callFor("chatSessions:listSessionsByGoalOutcome")?.[1]).toBe("skip");
    // And a query that was never issued is not "still loading".
    expect(result.current.isLoading).toBe(false);
  });

  it("still drills down on a swarm scope", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: { kind: "swarm", projectId: "proj_1" },
        clusterId: "cluster_1",
        outcome: null,
      }),
    );
    expect(
      callFor("chatSessions:listSwarmSessionsBySelection")?.[1],
    ).toMatchObject({ projectId: "proj_1", clusterId: "cluster_1" });
  });
});
