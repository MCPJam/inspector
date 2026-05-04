import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnsureDbUser } from "../useEnsureDbUser";

const mockState = vi.hoisted(() => ({
  actorKey: "guest-1" as string | null,
  auth: {
    user: null as { id: string } | null,
  },
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
  ensureUser: vi.fn().mockResolvedValue(undefined),
  getExistingGuestBearerToken: vi.fn().mockResolvedValue(null),
  revokeGuestSessionAndCookie: vi.fn().mockResolvedValue(false),
  sentrySetUser: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
  useMutation: () => mockState.ensureUser,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.auth,
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => mockState.actorKey,
}));

vi.mock("@/lib/guest-session", () => ({
  getExistingGuestBearerToken: mockState.getExistingGuestBearerToken,
  revokeGuestSessionAndCookie: mockState.revokeGuestSessionAndCookie,
}));

vi.mock("@sentry/react", () => ({
  setUser: mockState.sentrySetUser,
}));

describe("useEnsureDbUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.actorKey = "guest-1";
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
  });

  it("re-runs ensureUser when the guest actor key rotates", async () => {
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    mockState.actorKey = "guest-2";
    rerender();

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
    });
  });

  it("waits for a guest actor key before ensuring the guest row", async () => {
    mockState.actorKey = null;
    const { rerender } = renderHook(() => useEnsureDbUser());

    expect(mockState.ensureUser).not.toHaveBeenCalled();

    mockState.actorKey = "guest-1";
    rerender();

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });
  });

  it("clears Sentry when WorkOS signs out but Convex remains guest-authenticated", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith({
        id: "workos-user-1",
      });
    });

    mockState.sentrySetUser.mockClear();
    mockState.auth.user = null;
    mockState.actorKey = "guest-1";
    rerender();

    await waitFor(() => {
      expect(mockState.sentrySetUser).toHaveBeenCalledWith(null);
    });
  });
});
