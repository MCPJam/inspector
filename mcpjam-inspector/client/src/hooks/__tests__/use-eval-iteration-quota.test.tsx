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
