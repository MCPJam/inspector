import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreditBalance } from "@/hooks/useCreditBalance";

const { mockUseActor, mockUseQuery } = vi.hoisted(() => ({
  mockUseActor: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("@/hooks/useActor", () => ({
  useActor: () => mockUseActor(),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

describe("useCreditBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue(undefined);
  });

  it("skips the balance query while actor state is loading", () => {
    mockUseActor.mockReturnValue({
      status: "loading",
      isLoading: true,
      isAuthenticated: false,
      user: null,
    });

    const { result } = renderHook(() =>
      useCreditBalance({ includeGuests: true })
    );

    expect(mockUseQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.isLoading).toBe(true);
  });

  it("fetches balance for confirmed signed-in users", () => {
    mockUseActor.mockReturnValue({
      status: "user",
      isLoading: false,
      isAuthenticated: true,
      user: { _id: "user_123" },
    });
    mockUseQuery.mockReturnValue({
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 12,
      freeDailyResetAt: 1234,
    });

    const { result } = renderHook(() => useCreditBalance());

    expect(mockUseQuery).toHaveBeenCalledWith("billing:getCreditBalance", {});
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.balance?.freeDailyPercentUsed).toBe(12);
  });

  it("skips guests unless guest usage is requested", () => {
    mockUseActor.mockReturnValue({
      status: "guest",
      isLoading: false,
      isAuthenticated: false,
      user: null,
    });

    const { result } = renderHook(() => useCreditBalance());

    expect(mockUseQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("fetches guest balance data when requested without marking the actor signed in", () => {
    mockUseActor.mockReturnValue({
      status: "guest",
      isLoading: false,
      isAuthenticated: false,
      user: null,
    });
    mockUseQuery.mockReturnValue({
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 5678,
    });

    const { result } = renderHook(() =>
      useCreditBalance({ includeGuests: true })
    );

    expect(mockUseQuery).toHaveBeenCalledWith("billing:getCreditBalance", {});
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.balance?.freeDailyPercentUsed).toBe(65);
  });
});
