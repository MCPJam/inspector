import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

import { useEvalQueries } from "../use-eval-queries";

describe("useEvalQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
