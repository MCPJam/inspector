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
  getOrCreateGuestSessionOrThrow: vi.fn(),
  forceRefreshGuestSessionOrThrow: vi.fn(),
  markGuestActivated: vi.fn(),
  getGuestSessionRefusal: vi.fn(() => null as { until: number } | null),
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
  getOrCreateGuestSessionOrThrow: mockState.getOrCreateGuestSessionOrThrow,
  forceRefreshGuestSessionOrThrow: mockState.forceRefreshGuestSessionOrThrow,
  markGuestActivated: mockState.markGuestActivated,
  getGuestSessionRefusal: mockState.getGuestSessionRefusal,
}));

describe("useUnifiedConvexAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockState.workos.isLoading = false;
    mockState.workos.user = null;
    mockState.getCachedGuestSession.mockReturnValue(null);
    mockState.getGuestSessionRefusal.mockReturnValue(null);
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
    mockState.getOrCreateGuestSessionOrThrow
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
    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toEqual({
      __guest: true,
      id: "__guest__",
    });
    expect(mockState.reportCaught).not.toHaveBeenCalled();
  });

  it("stops after one attempt and does not report when the server refused to create a guest", async () => {
    mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);
    mockState.getGuestSessionRefusal.mockReturnValue({
      until: Date.now() + 600_000,
    });

    const { result } = renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("reports once after guest session bootstrap exhausts every attempt", async () => {
    mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

    const { result } = renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(4);
    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = mockState.reportCaught.mock.calls[0]!;
    expect(error).toEqual(
      new Error("Guest session bootstrap exhausted without a token"),
    );
    expect(options).toEqual({
      source: "guest_session_bootstrap",
      level: "error",
      extra: { attempts: 4 },
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("reports the real cause when guest session bootstrap fails", async () => {
    const networkError = new TypeError("Failed to fetch");
    mockState.getOrCreateGuestSessionOrThrow.mockRejectedValue(networkError);

    renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(4);
    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = mockState.reportCaught.mock.calls[0]!;
    expect(error).toBe(networkError);
    // No HTTP status on a network error, so no `httpStatus` key at all.
    expect(options).toEqual({
      source: "guest_session_bootstrap",
      level: "error",
      extra: { attempts: 4 },
    });
  });

  it("reports why the server's upstream hop failed", async () => {
    const relayError = Object.assign(
      new Error(
        "guest-session request failed: 503 Service Unavailable (network ENOTFOUND)",
      ),
      {
        status: 503,
        upstreamFailure: { reason: "network", networkCode: "ENOTFOUND" },
      },
    );
    mockState.getOrCreateGuestSessionOrThrow.mockRejectedValue(relayError);

    renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = mockState.reportCaught.mock.calls[0]!;
    expect(error).toBe(relayError);
    // No upstream status on a network failure, so no `upstreamStatus` key.
    expect(options).toEqual({
      source: "guest_session_bootstrap",
      level: "error",
      extra: {
        attempts: 4,
        httpStatus: 503,
        upstreamReason: "network",
        networkCode: "ENOTFOUND",
      },
    });
  });

  it("ignores malformed upstream failure details", async () => {
    mockState.getOrCreateGuestSessionOrThrow.mockRejectedValue(
      Object.assign(new Error("guest-session request failed: 503"), {
        status: 503,
        upstreamFailure: { reason: 42 },
      }),
    );

    renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    const [, options] = mockState.reportCaught.mock.calls[0]!;
    expect(options).toEqual({
      source: "guest_session_bootstrap",
      level: "error",
      extra: { attempts: 4, httpStatus: 503 },
    });
  });

  it("does not report guest session bootstrap after unmount", async () => {
    mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

    const { unmount } = renderHook(() => useUnifiedConvexAuth());
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).not.toHaveBeenCalled();
  });

  it("marks the guest activated only when Convex pulls the guest token, not on resolve", async () => {
    const session = {
      guestId: "guest-1",
      token: "guest-token",
      expiresAt: Date.now() + 60_000,
    };
    mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(session);
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
      // Bootstrap exhaustion is covered above. Refresh tests count only reports
      // emitted by the token fetch they invoke after mounting.
      mockState.reportCaught.mockClear();
      return result;
    }

    it("mints a new guest token when the cache has lapsed", async () => {
      // An empty cache is exactly the state a 24h guest token reaches once it
      // enters its 5-minute expiry buffer. The old code returned the stale
      // React copy of that same expired token. The cache must still be empty
      // when getAccessToken runs, or this exercises the cached fast path
      // instead of the mint path it exists to cover.
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

      const result = await mountGuest();
      mockState.getOrCreateGuestSessionOrThrow.mockClear();

      // A real mint writes through to the cache (setCachedSession), which is
      // how markActiveGuest then resolves the guestId.
      mockState.getOrCreateGuestSessionOrThrow.mockImplementation(async () => {
        mockState.getCachedGuestSession.mockReturnValue(session);
        return session;
      });

      let token: string | null = null;
      await act(async () => {
        token = await result.current.getAccessToken();
      });

      expect(token).toBe("fresh-guest-token");
      expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(1);
      expect(mockState.markGuestActivated).toHaveBeenCalledWith("guest-1");
      expect(mockState.reportCaught).not.toHaveBeenCalled();
    });

    it("retries a transient guest mint failure and returns the token", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

      const result = await mountGuest();
      // Bootstrap already exhausted its own ladder; count only the refresh.
      mockState.getOrCreateGuestSessionOrThrow.mockClear();
      mockState.getOrCreateGuestSessionOrThrow
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
      expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(3);
      expect(mockState.reportCaught).not.toHaveBeenCalled();
    });

    it("reports once and returns null when the guest ladder is exhausted", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

      const result = await mountGuest();
      mockState.getOrCreateGuestSessionOrThrow.mockClear();

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });

      await act(async () => {
        await expect(pending).resolves.toBeNull();
      });
      expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(4);
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

    it("reports the real cause and status when the guest ladder is exhausted", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

      const result = await mountGuest();
      const serverError = Object.assign(
        new Error("guest-session request failed: 503 Service Unavailable"),
        { status: 503 },
      );
      mockState.getOrCreateGuestSessionOrThrow.mockReset();
      mockState.getOrCreateGuestSessionOrThrow.mockRejectedValue(serverError);

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });

      await act(async () => {
        await expect(pending).resolves.toBeNull();
      });
      expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(4);
      expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
      expect(mockState.reportCaught).toHaveBeenCalledWith(serverError, {
        source: "guest_token_refresh",
        level: "warning",
        extra: { attempts: 4, httpStatus: 503 },
      });
    });

    it("reports the upstream status when the server's own hop got one", async () => {
      mockState.getCachedGuestSession.mockReturnValue(null);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(null);

      const result = await mountGuest();
      const relayError = Object.assign(
        new Error(
          "guest-session request failed: 503 Service Unavailable (upstream_status 522)",
        ),
        {
          status: 503,
          upstreamFailure: { reason: "upstream_status", upstreamStatus: 522 },
        },
      );
      mockState.getOrCreateGuestSessionOrThrow.mockReset();
      mockState.getOrCreateGuestSessionOrThrow.mockRejectedValue(relayError);

      let pending: Promise<string | null>;
      await act(async () => {
        pending = result.current.getAccessToken();
        await vi.advanceTimersByTimeAsync(500 + 1500 + 3000);
      });

      await act(async () => {
        await expect(pending).resolves.toBeNull();
      });
      expect(mockState.reportCaught).toHaveBeenCalledWith(relayError, {
        source: "guest_token_refresh",
        level: "warning",
        extra: {
          attempts: 4,
          httpStatus: 503,
          upstreamReason: "upstream_status",
          upstreamStatus: 522,
        },
      });
    });

    it("still honors the explicit force-refresh path", async () => {
      mockState.getCachedGuestSession.mockReturnValue(session);
      mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue(session);
      mockState.forceRefreshGuestSessionOrThrow.mockResolvedValue("forced-token");

      const result = await mountGuest();

      let token: string | null = null;
      await act(async () => {
        token = await result.current.getAccessToken({
          forceRefreshToken: true,
        });
      });

      expect(token).toBe("forced-token");
      expect(mockState.forceRefreshGuestSessionOrThrow).toHaveBeenCalledTimes(1);
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
      //
      // Shaped exactly as authkit throws it: `LoginRequiredError` extends
      // `Error` without ever assigning `name`, so the instance carries
      // `name: "Error"` and only the message identifies it.
      const loginRequired = new Error("No access token available");
      expect(loginRequired.name).toBe("Error");
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

    it("gives up immediately when authkit labels the error by name", async () => {
      // Belt and braces: if a later authkit sets `name`, that must keep
      // classifying as a dead session even if the message is reworded.
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

describe("useUnifiedConvexAuth on a vanity landing", () => {
  const originalLocation = window.location;

  function setHostname(hostname: string) {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, hostname },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockState.workos.isLoading = false;
    mockState.workos.user = null;
    mockState.getCachedGuestSession.mockReturnValue(null);
    mockState.getGuestSessionRefusal.mockReturnValue(null);
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("mints no guest session on caniuse.dev and settles signed out", async () => {
    setHostname("caniuse.dev");

    const { result } = renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).not.toHaveBeenCalled();
    // Settled, not spinning: the surface renders instead of waiting on a
    // bootstrap that will never run.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();

    // Past the whole retry ladder, still nothing — and no error reported.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockState.getOrCreateGuestSessionOrThrow).not.toHaveBeenCalled();
    expect(mockState.reportCaught).not.toHaveBeenCalled();
  });

  it("mints no guest session on caniuse.dev when a retry is requested", async () => {
    setHostname("caniuse.dev");

    renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      useSessionRefreshStore.setState({ retryNonce: 1 });
      await Promise.resolve();
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).not.toHaveBeenCalled();
  });

  it("still mints a guest session on score.mcpjam.com", async () => {
    setHostname("score.mcpjam.com");
    mockState.getOrCreateGuestSessionOrThrow.mockResolvedValue({
      guestId: "guest-1",
      token: "guest-token",
      expiresAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useUnifiedConvexAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.getOrCreateGuestSessionOrThrow).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).not.toBeNull();
  });
});
