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

const { mockUseQuery, mockUseMutation } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseMutation: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
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

  // BB-107: a control wired `onClick={onRebuild}` hands React's synthetic event
  // in here. Spreading `args` put the event's DOM refs in the mutation payload
  // and Convex threw on the circular structure — so the scenario branch must
  // pick the knobs, never forward whatever the caller passed.
  it("rebuild() forwards only the knobs, not a caller's wider object", async () => {
    const rebuildFns = new Map<string, ReturnType<typeof vi.fn>>();
    mockUseMutation.mockImplementation((name: string) => {
      const fn = rebuildFns.get(name) ?? vi.fn().mockResolvedValue({});
      rebuildFns.set(name, fn);
      return fn;
    });

    const eventShaped: Record<string, unknown> = {
      force: true,
      type: "click",
      currentTarget: { tagName: "BUTTON" },
    };
    // Self-reference, like the event -> target -> ownerDocument chain that made
    // the real payload unserializable.
    eventShaped.nativeEvent = eventShaped;

    const scenario = renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    await scenario.result.current.rebuild(eventShaped as { force?: boolean });

    expect(
      rebuildFns.get("chatSessions:rebuildScenarioInsights"),
    ).toHaveBeenCalledWith({ scenarioId: "cb-1", force: true });
  });

  // The knobs are the whole point of ClusterTuningControl: drop the tuning
  // branch of the pick and a tuned rebuild silently falls back to defaults.
  it("rebuild() forwards the tuning knobs the caller asked for", async () => {
    const rebuildFns = new Map<string, ReturnType<typeof vi.fn>>();
    mockUseMutation.mockImplementation((name: string) => {
      const fn = rebuildFns.get(name) ?? vi.fn().mockResolvedValue({});
      rebuildFns.set(name, fn);
      return fn;
    });

    const scenario = renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    await scenario.result.current.rebuild({
      tuning: { maxClusters: 12, minSeparation: 0.4, linkThreshold: 0.25 },
    });

    expect(
      rebuildFns.get("chatSessions:rebuildScenarioInsights"),
    ).toHaveBeenCalledWith({
      scenarioId: "cb-1",
      tuning: { maxClusters: 12, minSeparation: 0.4, linkThreshold: 0.25 },
    });
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
