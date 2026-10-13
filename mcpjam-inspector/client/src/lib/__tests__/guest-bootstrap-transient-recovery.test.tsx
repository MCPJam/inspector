import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { clearGuestSession, getGuestBearerToken } from "../guest-session";
import { useUnifiedConvexAuth } from "../unified-convex-auth";

const auth = vi.hoisted(() => ({
  isLoading: false,
  user: null as { id: string } | null,
  getAccessToken: vi.fn(),
}));
const reportCaught = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught }));

const session = () => ({
  guestId: "guest-recovered",
  token: "recovered-token",
  expiresAt: Date.now() + 3_600_000,
});
let visible = true;
let online = true;

async function exhaustedBootstrap(status = 503) {
  const fetch = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useUnifiedConvexAuth());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(hook.result.current.isAuthenticated).toBe(false);
  return { ...hook, fetch };
}

function allowSession(fetch: ReturnType<typeof vi.fn>) {
  fetch.mockImplementation(async () => Response.json(session()));
}

describe("transient guest bootstrap recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearGuestSession();
    auth.user = null;
    auth.isLoading = false;
    visible = true;
    online = true;
    reportCaught.mockReset();
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
      queriesPaused: false,
      authConfirmed: false,
    });
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      visible ? "visible" : "hidden",
    );
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  });

  afterEach(async () => {
    cleanup();
    await vi.runOnlyPendingTimersAsync();
    clearGuestSession();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes Retry and recovers automatically without reloading", async () => {
    const { result, fetch } = await exhaustedBootstrap();
    expect(useSessionRefreshStore.getState()).toMatchObject({
      status: "failed",
      kind: "transient",
    });
    allowSession(fetch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.isAuthenticated).toBe(true);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it("coalesces connection and focus events into one recovery", async () => {
    const { result, fetch } = await exhaustedBootstrap();
    allowSession(fetch);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.isAuthenticated).toBe(true);
    expect(useSessionRefreshStore.getState().retryNonce).toBe(1);
  });

  it("does not spend another retry ladder on repeated focus events", async () => {
    const { fetch } = await exhaustedBootstrap();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it.each(["hidden", "offline"])(
    "waits while %s and recovers when the app is available again",
    async (mode) => {
      const { result, fetch } = await exhaustedBootstrap();
      allowSession(fetch);
      visible = mode !== "hidden";
      online = mode !== "offline";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetch).toHaveBeenCalledTimes(4);
      visible = true;
      online = true;
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(result.current.isAuthenticated).toBe(true);
    },
  );

  it("lets the existing Retry action recover immediately", async () => {
    const { result, fetch } = await exhaustedBootstrap();
    allowSession(fetch);
    await act(async () => {
      useSessionRefreshStore.getState().retry();
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("adopts a guest session obtained by a cloud action", async () => {
    const { result, fetch } = await exhaustedBootstrap();
    allowSession(fetch);
    await act(async () => {
      expect(await getGuestBearerToken()).toBe("recovered-token");
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.isAuthenticated).toBe(true);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it("adopts a recovered token for the same expired guest identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...session(),
          token: "expired-token",
        }),
      ),
    );
    await getGuestBearerToken();
    await vi.advanceTimersByTimeAsync(3_600_000);
    const { result, fetch } = await exhaustedBootstrap();
    allowSession(fetch);
    await act(async () => {
      expect(await getGuestBearerToken()).toBe("recovered-token");
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("keeps a rate-limit refusal out of automatic recovery", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "600" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    renderHook(() => useUnifiedConvexAuth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it("does not automatically retry an explicit 403 refusal", async () => {
    const { fetch } = await exhaustedBootstrap(403);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("ends the retrying state if recovery reaches a terminal refusal", async () => {
    const { fetch } = await exhaustedBootstrap();
    fetch.mockImplementation(async () => new Response(null, { status: 403 }));
    await act(async () => {
      useSessionRefreshStore.getState().retry();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it.each(["sign-in", "unmount"])(
    "stops recovery after %s",
    async (transition) => {
      const { fetch, rerender, unmount } = await exhaustedBootstrap();
      if (transition === "sign-in") {
        auth.user = { id: "user-1" };
        rerender();
      } else unmount();
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it("keeps recovery available when telemetry throws", async () => {
    reportCaught.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { result, fetch } = await exhaustedBootstrap();
    allowSession(fetch);
    await act(async () => {
      useSessionRefreshStore.getState().retry();
    });
    expect(result.current.isAuthenticated).toBe(true);
  });
});
