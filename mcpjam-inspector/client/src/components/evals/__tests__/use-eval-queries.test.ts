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
    mocks.useQuery.mockReturnValue(undefined);
    mocks.isUserReady = true;
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
  });

  // Regression: INSPECTOR-CLIENT-23M. Convex reports `isAuthenticated` as soon
  // as the guest JWT validates, before `users:ensureUser` has created the row
  // the backend resolves the actor against. Querying in that window made
  // `requireActor()` throw, which Convex returns as "Server Error" and
  // `useQuery` rethrows during render, collapsing the Testing tab into its
  // error boundary.
  describe("db user bootstrap window", () => {
    beforeEach(() => {
      mocks.isUserReady = false;
    });

    it("skips every actor-scoped query while the db user is bootstrapping", () => {
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
      for (const call of mocks.useQuery.mock.calls) {
        expect(call[1]).toBe("skip");
      }
    });

    it("keeps the bootstrap window pending instead of settling as empty", () => {
      const { result } = renderHook(() =>
        useEvalQueries({
          isAuthenticated: true,
          selectedSuiteId: "suite-1",
          deletingSuiteId: null,
          projectId: "ws-1",
          organizationId: null,
        }),
      );

      expect(result.current.isOverviewLoading).toBe(true);
      expect(result.current.isSuiteDetailsLoading).toBe(true);
      expect(result.current.isSuiteRunsLoading).toBe(true);
    });

    it("does not report suite details pending when no suite is selected", () => {
      const { result } = renderHook(() =>
        useEvalQueries({
          isAuthenticated: true,
          selectedSuiteId: null,
          deletingSuiteId: null,
          projectId: "ws-1",
          organizationId: null,
        }),
      );

      expect(result.current.isSuiteDetailsLoading).toBe(false);
      expect(result.current.isSuiteRunsLoading).toBe(false);
    });

    it("still queries for direct guests, who never materialize a db user", () => {
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

      expect(result.current.enableOverviewQuery).toBe(true);
      expect(result.current.isOverviewLoading).toBe(true);
    });
  });
});
