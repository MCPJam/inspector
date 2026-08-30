import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnifiedConvexAuth } from "../unified-convex-auth";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

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
  reportCaught: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.workos,
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: mockState.reportCaught,
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
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
    });
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

  /**
   * The burst regression (Sentry CONVEX-CQ). Convex treats one `null` from the
   * token fetcher as terminal — `clearAuth()` with no retry — so every one of
   * these paths has to survive a transient failure on its own.
   */
  describe("token refresh retry", () => {
    const session = {
      guestId: "guest-1",
      token: "fresh-guest-token",
      expiresAt: Date.now() + 60_000,
    };

    // Mount and let the bootstrap effect's own retry ladder run to completion,
    // so its timers and mock calls can't bleed into the refresh assertions.
    async function mountGuest() {
      const { result } = renderHook(() => useUnifiedConvexAuth());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });
      return result;
    }

    it("mints a new guest token when the cache has lapsed", async () => {
      // An empty cache is exactly the state a 24h guest token reaches once it
      // enters its 5-minute expiry buffer. The old code returned the stale
      // React copy of that same expired token. The cache must still be empty
      // when getAccessToken runs, or this exercises the cached fast path
      // instead of the mint path it exists to cover.
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSession.mockResolvedValue(null);

      const result = await mountGuest();
      mockState.getOrCreateGuestSession.mockClear();

      // A real mint writes through to the cache (setCachedSession), which is
      // how markActiveGuest then resolves the guestId.
      mockState.getOrCreateGuestSession.mockImplementation(async () => {
        mockState.getCachedGuestSession.mockReturnValue(session);
        return session;
      });

      let token: string | null = null;
      await act(async () => {
        token = await result.current.getAccessToken();
      });

      expect(token).toBe("fresh-guest-token");
      expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(1);
      expect(mockState.markGuestActivated).toHaveBeenCalledWith("guest-1");
      expect(mockState.reportCaught).not.toHaveBeenCalled();
    });

    it("retries a transient guest mint failure and returns the token", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSession.mockResolvedValue(null);

      const result = await mountGuest();
      // Bootstrap already exhausted its own ladder; count only the refresh.
      mockState.getOrCreateGuestSession.mockClear();
      mockState.getOrCreateGuestSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(session);

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500);
      });

      await act(async () => {
        await expect(pending).resolves.toBe("fresh-guest-token");
      });
      expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(3);
      expect(mockState.reportCaught).not.toHaveBeenCalled();
    });

    it("reports once and returns null when the guest ladder is exhausted", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSession.mockResolvedValue(null);

      const result = await mountGuest();
      mockState.getOrCreateGuestSession.mockClear();

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });

      await act(async () => {
        await expect(pending).resolves.toBeNull();
      });
      expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(4);
      expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
      expect(mockState.reportCaught).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          source: "guest_token_refresh",
          level: "warning",
        }),
      );
      // Convex is about to clearAuth() on this null — the banner is what makes
      // that recoverable without a reload.
      expect(useSessionRefreshStore.getState().status).toBe("failed");
      expect(useSessionRefreshStore.getState().kind).toBe("transient");
    });

    it("still honors the explicit force-refresh path", async () => {
      mockState.getCachedGuestSession.mockReturnValue(session);
      mockState.getOrCreateGuestSession.mockResolvedValue(session);
      mockState.forceRefreshGuestSession.mockResolvedValue("forced-token");

      const result = await mountGuest();

      let token: string | null = null;
      await act(async () => {
        token = await result.current.getAccessToken({
          forceRefreshToken: true,
        });
      });

      expect(token).toBe("forced-token");
      expect(mockState.forceRefreshGuestSession).toHaveBeenCalledTimes(1);
    });

    it("retries a transient WorkOS network failure", async () => {
      mockState.workos.user = { id: "user-1" };
      mockState.workos.getAccessToken
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce("workos-token");

      const result = await mountGuest();

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500);
      });

      await act(async () => {
        await expect(pending).resolves.toBe("workos-token");
      });
      expect(mockState.workos.getAccessToken).toHaveBeenCalledTimes(3);
      expect(mockState.reportCaught).not.toHaveBeenCalled();
    });

    it("gives up immediately on a dead WorkOS session", async () => {
      // authkit latches to ERROR after this — retrying only re-throws, and a
      // genuine sign-out is not a fault worth reporting.
      const loginRequired = new Error("login required");
      loginRequired.name = "LoginRequiredError";
      mockState.workos.user = { id: "user-1" };
      mockState.workos.getAccessToken.mockRejectedValue(loginRequired);

      const result = await mountGuest();

      let token: string | null = "unset";
      await act(async () => {
        token = await result.current.getAccessToken();
      });

      expect(token).toBeNull();
      expect(mockState.workos.getAccessToken).toHaveBeenCalledTimes(1);
      expect(mockState.reportCaught).not.toHaveBeenCalled();
      // Retrying cannot help here, so the banner must offer sign-in instead.
      expect(useSessionRefreshStore.getState().kind).toBe("signed_out");
    });

    it("clears the banner once a token is recovered", async () => {
      useSessionRefreshStore.setState({
        status: "failed",
        kind: "transient",
      });
      mockState.workos.user = { id: "user-1" };
      mockState.workos.getAccessToken.mockResolvedValue("workos-token");

      const result = await mountGuest();

      await act(async () => {
        await result.current.getAccessToken();
      });

      expect(useSessionRefreshStore.getState().status).toBe("idle");
      expect(useSessionRefreshStore.getState().kind).toBeNull();
    });

    it("hands Convex a new token getter when the user retries", async () => {
      mockState.workos.user = { id: "user-1" };
      mockState.workos.getAccessToken.mockResolvedValue("workos-token");

      const { result } = renderHook(() => useUnifiedConvexAuth());
      await act(async () => {
        await Promise.resolve();
      });
      const before = result.current.getAccessToken;

      // A fresh identity is the whole retry lever: @convex-dev/workos keys its
      // fetchAccessToken on it, and ConvexAuthState re-runs setAuth when that
      // changes. Same function object would mean nothing happens.
      await act(async () => {
        useSessionRefreshStore.getState().retry();
      });

      expect(result.current.getAccessToken).not.toBe(before);
    });

    it("reports once when the WorkOS ladder is exhausted", async () => {
      mockState.workos.user = { id: "user-1" };
      mockState.workos.getAccessToken.mockRejectedValue(
        new TypeError("Failed to fetch"),
      );

      const result = await mountGuest();

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });

      await act(async () => {
        await expect(pending).resolves.toBeNull();
      });
      expect(mockState.workos.getAccessToken).toHaveBeenCalledTimes(4);
      expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
      expect(mockState.reportCaught).toHaveBeenCalledWith(
        expect.any(TypeError),
        expect.objectContaining({
          source: "workos_token_refresh",
          level: "warning",
        }),
      );
    });
  });
});
