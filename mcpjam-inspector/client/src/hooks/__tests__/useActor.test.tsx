import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActor } from "@/hooks/useActor";

const { mockUseAuth, mockUseConvexAuth, mockUseQuery } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseConvexAuth: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

describe("useActor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue(undefined);
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
    });
  });

  it("reports loading while WorkOS auth is loading", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: true,
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(result.current.isLoading).toBe(true);
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", "skip");
  });

  it("reports loading while Convex auth is loading", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
    });

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(result.current.isLoading).toBe(true);
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", "skip");
  });

  it("reports guest when there is no Convex identity", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("guest");
    expect(result.current.isAuthenticated).toBe(false);
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", "skip");
  });

  it("waits when Convex still has an identity but WorkOS has signed out", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(result.current.isAuthenticated).toBe(false);
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", {});
  });

  it("keeps waiting when a stale signed-in users row is present after WorkOS signed out", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue({ _id: "user_123" });

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("reports guest when a guest Convex identity resolves with no users row", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("guest");
    expect(result.current.isAuthenticated).toBe(false);
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", {});
  });

  it("waits for the users row when Convex has an identity", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "workos_user_123" },
      isLoading: false,
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(mockUseQuery).toHaveBeenCalledWith("users:getCurrentUser", {});
  });

  it("keeps signed-in users loading while their users row is provisioning", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "workos_user_123" },
      isLoading: false,
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("loading");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("reports user only after the users row resolves", () => {
    const user = { _id: "user_123", email: "test@example.com" };
    mockUseAuth.mockReturnValue({
      user: { id: "workos_user_123" },
      isLoading: false,
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(user);

    const { result } = renderHook(() => useActor());

    expect(result.current.status).toBe("user");
    expect(result.current.user).toBe(user);
    expect(result.current.isAuthenticated).toBe(true);
  });
});
