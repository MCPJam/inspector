import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  isUserReady: true,
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  // Per-run metrics and live-run rows; idle unless `perRunMetrics` is on.
  useQueries: () => ({}),
  useConvex: () => ({ query: async () => null }),
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

  it("reads cases only, never the whole suite's iterations, in per-run mode", () => {
    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: "suite-1",
        deletingSuiteId: null,
        projectId: "ws-1",
        organizationId: null,
        perRunMetrics: true,
      }),
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("testSuites:listTestCases", {
      suiteId: "suite-1",
    });
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getAllTestCasesAndIterationsBySuite",
      "skip"
    );
    expect(mocks.useQuery).not.toHaveBeenCalledWith(
      "testSuites:getAllTestCasesAndIterationsBySuite",
      { suiteId: "suite-1" }
    );
    expect(result.current.sortedIterations).toEqual([]);
    expect(result.current.metricsByRun.size).toBe(0);
  });

  it("keeps the whole-suite read for the legacy surfaces", () => {
    renderHook(() =>
      useEvalQueries({
        isAuthenticated: true,
        selectedSuiteId: "suite-1",
        deletingSuiteId: null,
        projectId: "ws-1",
        organizationId: null,
      }),
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("testSuites:listTestCases", "skip");
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

  // Replaces "preserves direct-guest overview access while the user row is not
  // ready", which asserted the opposite. That test passed a projectId, but
  // `useIsDirectGuest` returns false as soon as one exists — so the case it
  // locked in was unreachable. The reachable shape is a guest with no project
  // and no Convex identity, and there the overview query can only throw.
  it("skips the overview query for a direct guest", () => {
    mocks.isUserReady = false;

    const { result } = renderHook(() =>
      useEvalQueries({
        isAuthenticated: false,
        selectedSuiteId: null,
        deletingSuiteId: null,
        projectId: null,
        organizationId: null,
        isDirectGuest: true,
      }),
    );

    expect(result.current.enableOverviewQuery).toBe(false);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      "skip",
    );
  });
});

it("opens the credit wall for a live iteration failure once and preserves completed rows", () => {
  const store = useMCPJamLimitDialogStore;
  store.setState({
    authStatus: "signedIn",
    isOpen: false,
    notifiedRunIds: new Set(),
  });
  let runs = [{ _id: "live-eval", status: "running" }];
  const completed = {
    _id: "done",
    suiteRunId: "live-eval",
    status: "completed",
  };
  let iterations: any[] = [completed];
  mocks.useQuery.mockImplementation((query: string) => {
    if (query === "testSuites:listTestSuiteRuns") return runs;
    if (query === "testSuites:getAllTestCasesAndIterationsBySuite")
      return { iterations, testCases: [] };
    return [];
  });
  const { result, rerender } = renderHook(() =>
    useEvalQueries({
      isAuthenticated: true,
      selectedSuiteId: "suite",
      deletingSuiteId: null,
      projectId: "project",
      organizationId: "org",
    }),
  );
  expect(store.getState().isOpen).toBe(false);
  iterations = [
    ...iterations,
    { _id: "blocked", suiteRunId: "live-eval", error: "Credits exhausted" },
  ];
  runs = [{ _id: "live-eval", status: "failed" }];
  rerender();
  expect(store.getState().isOpen).toBe(true);
  expect(result.current.sortedIterations).toContain(completed);
  store.getState().close();
  iterations = [...iterations];
  rerender();
  expect(store.getState().isOpen).toBe(false);
});
