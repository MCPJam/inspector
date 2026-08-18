import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

describe("useEvalIterationQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A denial must not read as "still loading" — that spins forever.
  it("folds a denied org read (null) into undefined and stops loading", () => {
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() =>
      useEvalIterationQuota({ organizationId: "org_1" })
    );

    expect(result.current.quota).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAtLimit).toBe(false);
  });

  // The counterpart to the denial case: undefined is the in-flight answer, and
  // it is the one state that must still read as loading.
  it("keeps loading while the read is still in flight (undefined)", () => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useEvalIterationQuota({ organizationId: "org_1" })
    );

    expect(result.current.quota).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  // A skipped query also sits at undefined forever, so it must not be confused
  // with an in-flight one.
  it.each([
    ["no organizationId", { organizationId: null }],
    ["enabled: false", { organizationId: "org_1", enabled: false }],
  ])("never loads when the query is skipped (%s)", (_label, args) => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useEvalIterationQuota(args));

    expect(result.current.quota).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("reports the backend payload for an allowed org read", () => {
    mocks.useQuery.mockReturnValue({
      used: 5,
      allowed: 10,
      resetsAt: 0,
      windowKind: "day",
    });

    const { result } = renderHook(() =>
      useEvalIterationQuota({ organizationId: "org_1" })
    );

    expect(result.current.quota).toEqual({
      used: 5,
      allowed: 10,
      resetsAt: 0,
      windowKind: "day",
    });
    expect(result.current.isLoading).toBe(false);
  });
});
