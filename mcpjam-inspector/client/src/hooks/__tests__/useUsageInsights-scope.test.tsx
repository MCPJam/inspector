/**
 * Scope routing in the insights hooks.
 *
 * The chatbox and swarm surfaces share every component downstream of these
 * hooks, so the ONLY place the two can diverge is which Convex function gets
 * called with which key. A swarm scope silently hitting the chatbox query
 * would fail auth (chatbox access check against a project id) or, worse,
 * return another surface's cohort — hence pinning the function names and arg
 * shapes here.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useGoalOutcomeDrilldown,
  useUsageInsights,
} from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/chatbox-usage-filters";

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
  it("chatbox sourceId hits getUsageBreakdown with a chatboxId", () => {
    renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    const breakdown = queryCalls().find(([name]) =>
      name.includes("UsageBreakdown"),
    );
    expect(breakdown?.[0]).toBe("chatSessions:getUsageBreakdown");
    expect(breakdown?.[1]).toMatchObject({ chatboxId: "cb-1" });
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
    expect((breakdown?.[1] as Record<string, unknown>).chatboxId).toBe(
      undefined,
    );
    const threads = queryCalls().find(([name]) =>
      name.includes("listByChatbox"),
    );
    expect(threads?.[1]).toBe("skip");
  });

  it("rebuild() is scope-bound: swarm rebuilds the project, chatbox the chatbox", async () => {
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
      rebuildFns.get("chatSessions:rebuildChatboxInsights"),
    ).not.toHaveBeenCalled();

    const chatbox = renderHook(() =>
      useUsageInsights({ sourceId: "cb-1", filters: EMPTY_USAGE_FILTER }),
    );
    await chatbox.result.current.rebuild();
    expect(
      rebuildFns.get("chatSessions:rebuildChatboxInsights"),
    ).toHaveBeenCalledWith({ chatboxId: "cb-1" });
  });
});

describe("useGoalOutcomeDrilldown scope routing", () => {
  it("chatbox scope pages listSessionsByGoalOutcome", () => {
    renderHook(() =>
      useGoalOutcomeDrilldown({
        scope: { kind: "chatbox", chatboxId: "cb-1" },
        clusterId: "cluster-a",
        outcome: undefined,
      }),
    );
    const [name, args] = queryCalls()[0];
    expect(name).toBe("chatSessions:listSessionsByGoalOutcome");
    expect(args).toMatchObject({ chatboxId: "cb-1", clusterId: "cluster-a" });
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
    expect((args as Record<string, unknown>).chatboxId).toBe(undefined);
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
