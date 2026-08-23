import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  isUserReady: true,
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady,
}));

import { useEvalQueries } from "../use-eval-queries";

describe("useEvalQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isUserReady = true;
    mocks.useQuery.mockReturnValue(undefined);
  });

  it("does not report overview loading when the overview query is skipped", () => {
    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: false,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: null,
        organizationId: null,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(false);
    expect(result.current.isOverviewLoading).toBe(false);
    expect(result.current.sortedSuites).toEqual([]);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      "skip"
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getAllTestCasesAndIterationsBySuite",
      "skip"
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRuns",
      "skip"
    );
  });

  it("reports overview loading when the overview query is enabled but unresolved", () => {
    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: "ws-1",
        organizationId: null,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(true);
    expect(result.current.isOverviewLoading).toBe(true);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      { projectId: "ws-1" }
    );
  });

  it("queries details and runs when a selected suite is ready", () => {
    renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: "suite-1",
        deletingSuiteId: null,
        projectId: "ws-1",
        organizationId: null,
      }),
    );

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getAllTestCasesAndIterationsBySuite",
      { suiteId: "suite-1" }
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRuns",
      { suiteId: "suite-1", limit: 100 }
    );
  });

  it("uses empty overview args when ready with no project or organization", () => {
    renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: null,
        organizationId: null,
      }),
    );

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      {}
    );
  });

  it("enables the overview query for hosted guests (Convex-authenticated, no WorkOS user)", () => {
    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: "guest-project",
        organizationId: null,
        isDirectGuest: false,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(true);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      { projectId: "guest-project" }
    );
  });

  it("skips overview, details, and runs while the user row is still bootstrapping", () => {
    mocks.isUserReady = false;

    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: "suite-1",
        deletingSuiteId: null,
        projectId: "ws-1",
        organizationId: null,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(false);
    expect(result.current.enableSuiteDetailsQuery).toBe(false);
    // Skipped, but still LOADING: an answer is coming once the row lands, and
    // EvalsTab reads "not loading + no matching suite" as a deleted suite and
    // bounces the deep link.
    expect(result.current.isOverviewLoading).toBe(true);
    expect(result.current.isSuiteDetailsLoading).toBe(true);
    expect(result.current.isSuiteRunsLoading).toBe(true);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      "skip"
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getAllTestCasesAndIterationsBySuite",
      "skip"
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRuns",
      "skip"
    );
  });

  it("preserves direct-guest overview access while the user row is not ready", () => {
    mocks.isUserReady = false;

    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: false,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: "guest-project",
        organizationId: null,
        isDirectGuest: true,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(true);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      { projectId: "guest-project" }
    );
  });
});
