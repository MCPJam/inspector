import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  getGuestPromotionProof: vi.fn().mockResolvedValue(null),
  revokeGuestSessionAndCookie: vi.fn().mockResolvedValue(false),
  getExistingGuestId: vi.fn().mockResolvedValue(null as string | null),
  isGuestActivated: vi.fn().mockReturnValue(false),
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
  getGuestPromotionProof: mockState.getGuestPromotionProof,
  revokeGuestSessionAndCookie: mockState.revokeGuestSessionAndCookie,
  getExistingGuestId: mockState.getExistingGuestId,
  isGuestActivated: mockState.isGuestActivated,
}));

vi.mock("@sentry/react", () => ({
  setUser: mockState.sentrySetUser,
}));

describe("useEnsureDbUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.ensureUser.mockResolvedValue(undefined);
    mockState.getGuestPromotionProof.mockResolvedValue(null);
    mockState.revokeGuestSessionAndCookie.mockResolvedValue(false);
    mockState.getExistingGuestId.mockResolvedValue(null);
    mockState.isGuestActivated.mockReturnValue(false);
    mockState.actorKey = "guest-1";
    mockState.auth.user = null;
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the user as ready only after ensureUser succeeds", async () => {
    let resolveEnsureUser: (() => void) | undefined;
    mockState.ensureUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsureUser = resolve;
        })
    );

    const { result } = renderHook(() => useEnsureDbUser());

    expect(result.current.isUserReady).toBe(false);
    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });
    expect(result.current.isUserReady).toBe(false);

    await act(async () => {
      resolveEnsureUser?.();
    });

    await waitFor(() => {
      expect(result.current.isUserReady).toBe(true);
    });
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

  it("does not re-run when AuthKit returns a new user object for the same id", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    mockState.auth.user = { id: "workos-user-1" };
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight ensureUser call for the same identity", async () => {
    let resolveEnsureUser: (() => void) | undefined;
    mockState.ensureUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsureUser = resolve;
        })
    );

    const { rerender } = renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    const nextEnsureUser = vi.fn().mockResolvedValue(undefined);
    mockState.ensureUser = nextEnsureUser;
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(nextEnsureUser).not.toHaveBeenCalled();

    await act(async () => {
      resolveEnsureUser?.();
    });
  });

  it("retries ensureUser on Convex write conflicts", async () => {
    mockState.ensureUser
      .mockRejectedValueOnce(
        new Error(
          'Documents read from or written to the "users" table changed while this mutation was being run'
        )
      )
      .mockResolvedValueOnce(undefined);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
    });
  });

  it("abandons a pending retry when the identity changes", async () => {
    vi.useFakeTimers();
    mockState.ensureUser
      .mockRejectedValueOnce(
        new Error(
          'Documents read from or written to the "users" table changed while this mutation was being run'
        )
      )
      .mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useEnsureDbUser());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(1);

    mockState.actorKey = "guest-2";
    rerender();

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(mockState.ensureUser).toHaveBeenCalledTimes(2);
  });

  it("revokes an incidental (unactivated) guest cookie on WorkOS auth without promoting", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    // A guest cookie exists (incidental document bootstrap) but was never
    // activated as a guest.
    mockState.getExistingGuestId.mockResolvedValue("guest-incidental");
    mockState.isGuestActivated.mockReturnValue(false);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    // No promotion proof requested.
    expect(mockState.getGuestPromotionProof).not.toHaveBeenCalled();
    // ensureUser called WITHOUT guestProofJwt.
    expect(mockState.ensureUser).toHaveBeenCalledWith({});
    // Incidental cookie revoked.
    await waitFor(() => {
      expect(mockState.revokeGuestSessionAndCookie).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes an activated guest on WorkOS auth", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.getExistingGuestId.mockResolvedValue("guest-activated");
    mockState.isGuestActivated.mockReturnValue(true);
    mockState.getGuestPromotionProof.mockResolvedValue("proof-jwt");

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.getGuestPromotionProof).toHaveBeenCalledTimes(1);
    });
    // ensureUser called WITH the proof.
    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledWith({
        guestProofJwt: "proof-jwt",
      });
    });
    // Activated guests still revoke their cookie after a successful promote.
    await waitFor(() => {
      expect(mockState.revokeGuestSessionAndCookie).toHaveBeenCalledTimes(1);
    });
  });

  it("does not request a promotion proof or revoke when no guest cookie exists", async () => {
    mockState.auth.user = { id: "workos-user-1" };
    mockState.actorKey = "workos-user-1";
    mockState.getExistingGuestId.mockResolvedValue(null);

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
    });

    expect(mockState.getGuestPromotionProof).not.toHaveBeenCalled();
    expect(mockState.revokeGuestSessionAndCookie).not.toHaveBeenCalled();
    expect(mockState.ensureUser).toHaveBeenCalledWith({});
  });

  it("does not retry unrelated ensureUser errors", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockState.ensureUser.mockRejectedValueOnce(new Error("boom"));

    renderHook(() => useEnsureDbUser());

    await waitFor(() => {
      expect(mockState.ensureUser).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[auth] ensureUser failed",
        expect.any(Error)
      );
    });
  });
});
