import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearGuestSession, getGuestSessionRefusal } from "../guest-session";
import { useUnifiedConvexAuth } from "../unified-convex-auth";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const auth = vi.hoisted(() => ({
  isLoading: false,
  user: null as { id: string } | null,
  getAccessToken: vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  clearGuestSession();
  auth.user = null;
  useSessionRefreshStore.setState({ status: "idle", kind: null, retryNonce: 0 });
});

afterEach(async () => {
  cleanup();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["bootstrap", "refresh"])(
  "automatically recovers a refused guest %s when Retry-After expires",
  async (mode) => {
    const session = {
      guestId: "guest-1",
      token: "guest-token",
      expiresAt: Date.now() + 3_600_000,
    };
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(session), { status: 200 })),
    );
    if (mode === "refresh") {
      fetch.mockImplementationOnce(() =>
        Promise.resolve(new Response(JSON.stringify(session), { status: 200 })),
      );
    }
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, { status: 429, headers: { "Retry-After": "45" } }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useUnifiedConvexAuth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    if (mode === "refresh") {
      expect(result.current.isAuthenticated).toBe(true);
      await act(async () => {
        expect(
          await result.current.fetchAccessToken({ forceRefreshToken: true }),
        ).toBeNull();
      });
    }
    const refusedRequests = mode === "refresh" ? 2 : 1;
    expect(fetch).toHaveBeenCalledTimes(refusedRequests);
    expect(result.current.isAuthenticated).toBe(false);
    expect(getGuestSessionRefusal()).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(44_000);
    });
    expect(fetch).toHaveBeenCalledTimes(refusedRequests);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getGuestSessionRefusal()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(refusedRequests + 1);
    expect(result.current.isAuthenticated).toBe(true);
    expect(await result.current.fetchAccessToken()).toBe(session.token);
    expect(useSessionRefreshStore.getState().retryNonce).toBe(0);
  },
);

it("does not create a guest on refusal expiry after signing in", async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(null, { status: 429, headers: { "Retry-After": "45" } }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(() => useUnifiedConvexAuth());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getGuestSessionRefusal()).not.toBeNull();
  auth.user = { id: "user-1" };
  rerender();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(getGuestSessionRefusal()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current.isAuthenticated).toBe(true);
});
