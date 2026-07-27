/**
 * The archive-confirm reference-count hook. Phase 4 EXTENDED it to scan
 * journeys as well as eval suites, so an environment referenced ONLY by a
 * journey no longer reports "0 consumers".
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => mockQuery(name, args),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: (projectId: string | null | undefined) => !!projectId,
}));

import { useProjectEnvironmentConsumers } from "../use-project-environment-consumers";

const SUITE_QUERY = "testSuites:getTestSuitesOverview";
const JOURNEY_QUERY = "journeys:listJourneysByProject";

/** Route each Convex query name to a canned result (or `undefined` = loading). */
function stubQueries(results: { suites?: unknown; journeys?: unknown }) {
  mockQuery.mockImplementation((name: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (name === SUITE_QUERY) return results.suites;
    if (name === JOURNEY_QUERY) return results.journeys;
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useProjectEnvironmentConsumers", () => {
  it("counts a journey that references the environment (was previously ignored)", () => {
    stubQueries({
      suites: [],
      journeys: [
        { environmentIds: ["env-1", "env-2"] },
        { environmentIds: ["env-9"] },
        { environmentIds: null },
      ],
    });

    const { result } = renderHook(() =>
      useProjectEnvironmentConsumers("proj-1", "env-1")
    );

    expect(result.current.journeyCount).toBe(1);
    expect(result.current.suiteCount).toBe(0);
  });

  it("counts suites and journeys independently", () => {
    stubQueries({
      suites: [
        { suite: { environmentIds: ["env-1"] } },
        { suite: { environmentIds: ["env-1", "env-2"] } },
        { suite: { environmentIds: ["env-2"] } },
      ],
      journeys: [{ environmentIds: ["env-1"] }, { environmentIds: ["env-1"] }],
    });

    const { result } = renderHook(() =>
      useProjectEnvironmentConsumers("proj-1", "env-1")
    );

    expect(result.current.suiteCount).toBe(2);
    expect(result.current.journeyCount).toBe(2);
  });

  it("reports null per-source while that source is still loading", () => {
    stubQueries({ suites: [], journeys: undefined });

    const { result } = renderHook(() =>
      useProjectEnvironmentConsumers("proj-1", "env-1")
    );

    expect(result.current.suiteCount).toBe(0);
    expect(result.current.journeyCount).toBeNull();
  });

  it("skips both queries and reports null when no environment is targeted", () => {
    stubQueries({ suites: [], journeys: [] });

    const { result } = renderHook(() =>
      useProjectEnvironmentConsumers("proj-1", null)
    );

    expect(result.current.suiteCount).toBeNull();
    expect(result.current.journeyCount).toBeNull();
    // Both Convex queries were skipped (never enabled with real args).
    for (const call of mockQuery.mock.calls) {
      expect(call[1]).toBe("skip");
    }
  });
});
