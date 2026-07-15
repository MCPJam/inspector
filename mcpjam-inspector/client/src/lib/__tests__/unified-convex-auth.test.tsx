import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnifiedConvexAuth } from "../unified-convex-auth";

const mockState = vi.hoisted(() => ({
  workos: {
    isLoading: false,
    user: null as { id: string } | null,
    getAccessToken: vi.fn(),
  },
  getCachedGuestSession: vi.fn(),
  getOrCreateGuestSession: vi.fn(),
  forceRefreshGuestSession: vi.fn(),
  markGuestActivated: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.workos,
}));

vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: mockState.getCachedGuestSession,
  getOrCreateGuestSession: mockState.getOrCreateGuestSession,
  forceRefreshGuestSession: mockState.forceRefreshGuestSession,
  markGuestActivated: mockState.markGuestActivated,
}));

describe("useUnifiedConvexAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockState.workos.isLoading = false;
    mockState.workos.user = null;
    mockState.getCachedGuestSession.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries guest session bootstrap after a transient miss", async () => {
    mockState.getOrCreateGuestSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        guestId: "guest-1",
        token: "guest-token",
        expiresAt: Date.now() + 60_000,
      });

    const { result } = renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toEqual({
      __guest: true,
      id: "__guest__",
    });
  });

  it("marks the guest activated only when Convex pulls the guest token, not on resolve", async () => {
    const session = {
      guestId: "guest-1",
      token: "guest-token",
      expiresAt: Date.now() + 60_000,
    };
    mockState.getOrCreateGuestSession.mockResolvedValue(session);
    mockState.getCachedGuestSession.mockReturnValue(session);

    const { result } = renderHook(() => useUnifiedConvexAuth());
    await act(async () => {
      await Promise.resolve();
    });

    // Resolving the session must NOT activate — otherwise an authed user who
    // merely opened the app would be promotable (the incidental-cookie guard).
    expect(mockState.markGuestActivated).not.toHaveBeenCalled();

    // Convex authenticating as the guest is the real activation signal.
    await act(async () => {
      await result.current.getAccessToken();
    });
    expect(mockState.markGuestActivated).toHaveBeenCalledWith("guest-1");
  });
});
