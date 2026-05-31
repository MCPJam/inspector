import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreditBalance } from "@/hooks/useCreditBalance";

const mocks = vi.hoisted(() => ({
  convexAuth: {
    isAuthenticated: false,
    isLoading: false,
  },
  workosAuth: {
    user: null as { id: string } | null,
    isLoading: false,
  },
  queryResult: undefined as unknown,
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.convexAuth,
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mocks.workosAuth,
}));

describe("useCreditBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    mocks.workosAuth.user = null;
    mocks.workosAuth.isLoading = false;
    mocks.queryResult = {
      availableCredits: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 1_777_777_777_000,
      walletLocked: false,
    };
    mocks.useQuery.mockImplementation((_name: unknown, args: unknown) =>
      args === "skip" ? undefined : mocks.queryResult
    );
  });

  it("skips guest Convex identities unless guests are included", () => {
    mocks.convexAuth.isAuthenticated = true;

    const { result } = renderHook(() => useCreditBalance());

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.balance).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(false);
  });

  it("fetches guest balances when includeGuests is enabled without an org", () => {
    mocks.convexAuth.isAuthenticated = true;

    const { result } = renderHook(() =>
      useCreditBalance({ includeGuests: true })
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("billing:getCreditBalance", {});
    expect(result.current.balance).toEqual({
      availableCredits: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 1_777_777_777_000,
      walletLocked: false,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(false);
  });

  it("fetches signed-in org balances without includeGuests", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };

    const { result } = renderHook(() =>
      useCreditBalance({ organizationId: "org-1" })
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("billing:getCreditBalance", {
      organizationId: "org-1",
    });
    expect(result.current.balance?.freeDailyPercentUsed).toBe(65);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(true);
  });

  it("skips signed-in fetches until an organization is selected", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };

    const { result } = renderHook(() => useCreditBalance());

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.balance).toBeUndefined();
  });
});
