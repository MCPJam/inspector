/**
 * Scope routing in the insights hooks.
 *
 * The scenario and swarm surfaces share every component downstream of these
 * hooks, so the ONLY place the two can diverge is which Convex function gets
 * called with which key. A swarm scope silently hitting the scenario query
 * would fail auth (scenario access check against a project id) or, worse,
 * return another surface's cohort — hence pinning the function names and arg
 * shapes here.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useGoalOutcomeDrilldown,
  useUsageInsights,
} from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/scenario-usage-filters";

const { mockUseQuery, mockUseMutation, mockUseAction } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseMutation: vi.fn(),
  mockUseAction: vi.fn(),
}));

// Every Convex hook `useUsageInsights` reaches for has to appear here: this is
// a non-partial mock, so a hook the module calls but this factory omits is not
// a missing stub, it is a render-time throw that fails every case in the file
// at once. `useAction` arrived with the benchmark scope's on-demand diagram.
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

/** All (name, args) pairs a render passed to useQuery. */
function queryCalls(): Array<[string, unknown]> {
  return mockUseQuery.mock.calls.map(
    (call) => [call[0], call[1]] as [string, unknown],
  );
}

beforeEach(() => {
  mockUseQuery.mockReset().mockReturnValue(undefined);
  mockUseMutation.mockReset().mockReturnValue(vi.fn());
  mockUseAction.mockReset().mockReturnValue(vi.fn());
});

describe("useUsageInsights scope routing", () => {
  it("scenario sourceId hits getUsageBreakdown with a scenarioId", () => {
    renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    const breakdown = queryCalls().find(([name]) =>
      name.includes("UsageBreakdown"),
    );
    expect(breakdown?.[0]).toBe("chatSessions:getUsageBreakdown");
    expect(breakdown?.[1]).toMatchObject({ scenarioId: "cb-1" });
  });

  it("swarm scope hits getSwarmUsageBreakdown with a projectId and skips the thread list", () => {
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "swarm", projectId: "proj-1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    const breakdown = queryCalls().find(([name]) =>
      name.includes("UsageBreakdown"),
    );
    expect(breakdown?.[0]).toBe("chatSessions:getSwarmUsageBreakdown");
    expect(breakdown?.[1]).toMatchObject({ projectId: "proj-1" });
    expect((breakdown?.[1] as Record<string, unknown>).scenarioId).toBe(
      undefined,
    );
    expect((breakdown?.[1] as Record<string, unknown>).journeyRunIds).toBe(
      undefined,
    );
    const threads = queryCalls().find(([name]) =>
      name.includes("listByScenario"),
    );
    expect(threads?.[1]).toBe("skip");
  });

  it("swarm scope forwards journeyRunIds into getSwarmUsageBreakdown", () => {
    renderHook(() =>
      useUsageInsights({
        scope: {
          kind: "swarm",
          projectId: "proj-1",
          journeyRunIds: ["run-a", "run-b"],
        },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    const breakdown = queryCalls().find(([name]) =>
      name.includes("UsageBreakdown"),
    );
    expect(breakdown?.[0]).toBe("chatSessions:getSwarmUsageBreakdown");
    expect(breakdown?.[1]).toMatchObject({
      projectId: "proj-1",
      journeyRunIds: ["run-a", "run-b"],
    });
  });

  it("rebuild() is scope-bound: swarm rebuilds the project, scenario the scenario", async () => {
    const rebuildFns = new Map<string, ReturnType<typeof vi.fn>>();
    mockUseMutation.mockImplementation((name: string) => {
      const fn = rebuildFns.get(name) ?? vi.fn().mockResolvedValue({});
      rebuildFns.set(name, fn);
      return fn;
    });

    const swarm = renderHook(() =>
      useUsageInsights({
        scope: { kind: "swarm", projectId: "proj-1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    await swarm.result.current.rebuild({ force: true });
    expect(
      rebuildFns.get("chatSessions:rebuildSwarmInsights"),
    ).toHaveBeenCalledWith({ projectId: "proj-1", force: true });
    expect(
      rebuildFns.get("chatSessions:rebuildScenarioInsights"),
    ).not.toHaveBeenCalled();

    const scenario = renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    await scenario.result.current.rebuild();
    expect(
      rebuildFns.get("chatSessions:rebuildScenarioInsights"),
    ).toHaveBeenCalledWith({ scenarioId: "cb-1" });
  });

  // The hook's own warning is that a mis-shaped ternary sends a benchmark
  // scope down the SCENARIO arm. That fails as a wrong cohort rather than as
  // an error, so it is pinned here the same way the other two arms are.
  it("benchmark scope hits getBenchmarkUsageBreakdown keyed on the run", () => {
    renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "brun-1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    const breakdown = queryCalls().find(([name]) =>
      name.includes("UsageBreakdown"),
    );
    expect(breakdown?.[0]).toBe("chatSessions:getBenchmarkUsageBreakdown");
    expect(breakdown?.[1]).toMatchObject({ benchmarkRunId: "brun-1" });
    // Keyed on the run and nothing else — a project or scenario id leaking in
    // here is how one surface's cohort ends up answering another's question.
    const args = breakdown?.[1] as Record<string, unknown>;
    expect(args.projectId).toBe(undefined);
    expect(args.scenarioId).toBe(undefined);
  });

  // "A diagram that waits to be asked": the benchmark flow costs model spend
  // against the run's budget, so rendering the hook must never trigger it.
  it("benchmark scope does not generate the flow diagram on render", () => {
    const generate = vi.fn().mockResolvedValue({});
    mockUseAction.mockReturnValue(generate);

    renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "brun-1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );

    expect(generate).not.toHaveBeenCalled();
  });

  it("benchmark rebuild() asks for the flow diagram for its own run", async () => {
    const generate = vi.fn().mockResolvedValue({});
    mockUseAction.mockReturnValue(generate);
    const rebuildFns = new Map<string, ReturnType<typeof vi.fn>>();
    mockUseMutation.mockImplementation((name: string) => {
      const fn = rebuildFns.get(name) ?? vi.fn().mockResolvedValue({});
      rebuildFns.set(name, fn);
      return fn;
    });

    const benchmark = renderHook(() =>
      useUsageInsights({
        scope: { kind: "benchmark", benchmarkRunId: "brun-1" },
        filters: EMPTY_USAGE_FILTER,
      }),
    );
    await benchmark.result.current.rebuild();

    expect(generate).toHaveBeenCalledWith({ benchmarkRunId: "brun-1" });
    // And never through the other scopes' mutations, which key on a project or
    // a scenario the benchmark does not have.
    expect(
      rebuildFns.get("chatSessions:rebuildSwarmInsights"),
    ).not.toHaveBeenCalled();
    expect(
      rebuildFns.get("chatSessions:rebuildScenarioInsights"),
    ).not.toHaveBeenCalled();
  });
});

describe("useGoalOutcomeDrilldown scope routing", () => {
  it("scenario scope pages listSessionsByGoalOutcome", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: { kind: "scenario", scenarioId: "cb-1" },
        clusterId: "cluster-a",
        outcome: undefined,
      }),
    );
    const [name, args] = queryCalls()[0];
    expect(name).toBe("chatSessions:listSessionsByGoalOutcome");
    expect(args).toMatchObject({ scenarioId: "cb-1", clusterId: "cluster-a" });
  });

  it("swarm scope pages listSwarmSessionsBySelection with the projectId", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: { kind: "swarm", projectId: "proj-1" },
        clusterId: "cluster-a",
        outcome: undefined,
      }),
    );
    const [name, args] = queryCalls()[0];
    expect(name).toBe("chatSessions:listSwarmSessionsBySelection");
    expect(args).toMatchObject({ projectId: "proj-1", clusterId: "cluster-a" });
    expect((args as Record<string, unknown>).scenarioId).toBe(undefined);
  });

  it("swarm scope forwards journeyRunIds into listSwarmSessionsBySelection", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: {
          kind: "swarm",
          projectId: "proj-1",
          journeyRunIds: ["run-a"],
        },
        clusterId: null,
        outcome: undefined,
      }),
    );
    const [name, args] = queryCalls()[0];
    expect(name).toBe("chatSessions:listSwarmSessionsBySelection");
    expect(args).toMatchObject({
      projectId: "proj-1",
      journeyRunIds: ["run-a"],
    });
  });

  it("null scope skips the query", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: null,
        clusterId: null,
        outcome: undefined,
      }),
    );
    expect(queryCalls()[0][1]).toBe("skip");
  });
});
