import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActorKey } from "../use-actor-key";

const mockState = vi.hoisted(() => ({
  auth: {
    user: null as { id: string } | null,
    isLoading: false,
  },
  getCachedGuestId: vi.fn(),
  getCachedGuestSession: vi.fn(),
  getOrCreateGuestSession: vi.fn(),
  hasCachedGuestSession: vi.fn(),
  subscribeGuestSessionChanges: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.auth,
}));

vi.mock("@/lib/guest-session", () => ({
  getCachedGuestId: mockState.getCachedGuestId,
  getCachedGuestSession: mockState.getCachedGuestSession,
  getOrCreateGuestSession: mockState.getOrCreateGuestSession,
  hasCachedGuestSession: mockState.hasCachedGuestSession,
  subscribeGuestSessionChanges: mockState.subscribeGuestSessionChanges,
}));

describe("useActorKey", () => {
  beforeEach(() => {
    mockState.auth = { user: null, isLoading: false };
    mockState.getCachedGuestSession.mockReset();
    mockState.getCachedGuestSession.mockReturnValue(null);
    mockState.getCachedGuestId.mockReset();
    mockState.getCachedGuestId.mockImplementation(
      () => mockState.getCachedGuestSession()?.guestId ?? null,
    );
    mockState.hasCachedGuestSession.mockReset();
    mockState.hasCachedGuestSession.mockImplementation(
      () => mockState.getCachedGuestSession() !== null,
    );
    mockState.getOrCreateGuestSession.mockReset();
    mockState.getOrCreateGuestSession.mockResolvedValue(null);
    mockState.subscribeGuestSessionChanges.mockReset();
    mockState.subscribeGuestSessionChanges.mockReturnValue(() => {});
  });

  it("clears a stale guest id and bootstraps a fresh guest after sign-out", async () => {
    mockState.auth = { user: { id: "user_1" }, isLoading: false };
    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_old",
      token: "token_old",
      expiresAt: Date.now() + 60_000,
    });
    mockState.getOrCreateGuestSession.mockResolvedValue({
      guestId: "guest_new",
      token: "token_new",
      expiresAt: Date.now() + 60_000,
    });

    const { result, rerender } = renderHook(() => useActorKey());

    expect(result.current).toBe("user_1");

    mockState.auth = { user: null, isLoading: false };
    rerender();

    await waitFor(() => {
      expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current).toBe("guest_new");
    });
  });

  // Convex keeps the token it already holds when the cache is cleared, so
  // dropping the guest here left the app authenticated with no actor
  // (`app_load/actor_pending`) whenever the re-lookup failed.
  it("keeps the guest when the guest cache is cleared under it", () => {
    let notify = () => {};
    mockState.subscribeGuestSessionChanges.mockImplementation(
      (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    );
    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_1",
      token: "token_1",
      expiresAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useActorKey());
    expect(result.current).toBe("guest_1");

    mockState.getCachedGuestSession.mockReturnValue(null);
    act(() => notify());

    expect(result.current).toBe("guest_1");
    expect(mockState.getOrCreateGuestSession).not.toHaveBeenCalled();
  });

  it("follows a new guest session once it is cached", () => {
    let notify = () => {};
    mockState.subscribeGuestSessionChanges.mockImplementation(
      (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    );
    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_1",
      token: "token_1",
      expiresAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useActorKey());

    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_2",
      token: "token_2",
      expiresAt: Date.now() + 60_000,
    });
    act(() => notify());

    expect(result.current).toBe("guest_2");
  });

  // A browser clock running ahead puts a session that was just cached inside
  // the expiry buffer, so the fresh-only read returns null for it.
  it("follows a new guest when its session is inside the expiry buffer", () => {
    let notify = () => {};
    mockState.subscribeGuestSessionChanges.mockImplementation(
      (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    );
    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_1",
      token: "token_1",
      expiresAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useActorKey());

    mockState.getCachedGuestSession.mockReturnValue(null);
    mockState.getCachedGuestId.mockReturnValue("guest_2");
    act(() => notify());

    expect(result.current).toBe("guest_2");
  });

  // A configured guest authority may answer a renewal with a token and no
  // guestId; keeping the old guest would scope the new token's state to it.
  it("drops the guest when a replacement session has no guest id", async () => {
    let notify = () => {};
    mockState.subscribeGuestSessionChanges.mockImplementation(
      (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    );
    mockState.getCachedGuestSession.mockReturnValue({
      guestId: "guest_1",
      token: "token_1",
      expiresAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useActorKey());
    expect(result.current).toBe("guest_1");

    mockState.getCachedGuestSession.mockReturnValue({
      token: "token_2",
      expiresAt: Date.now() + 60_000,
    });
    act(() => notify());

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});

describe("useActorKey on a vanity landing", () => {
  const originalLocation = window.location;

  function setHostname(hostname: string) {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, hostname },
    });
  }

  beforeEach(() => {
    mockState.auth = { user: null, isLoading: false };
    mockState.getCachedGuestSession.mockReset();
    mockState.getCachedGuestSession.mockReturnValue(null);
    mockState.getOrCreateGuestSession.mockReset();
    mockState.getOrCreateGuestSession.mockResolvedValue({
      guestId: "guest_1",
      token: "token_1",
      expiresAt: Date.now() + 60_000,
    });
    mockState.subscribeGuestSessionChanges.mockReset();
    mockState.subscribeGuestSessionChanges.mockReturnValue(() => {});
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  // This hook is the SECOND guest-creation path; skipping it in
  // unified-convex-auth alone would still spend from the per-IP budget.
  it("returns null without minting a guest on caniuse.dev", async () => {
    setHostname("caniuse.dev");

    const { result } = renderHook(() => useActorKey());

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
    expect(mockState.getOrCreateGuestSession).not.toHaveBeenCalled();
  });

  it("still mints a guest on score.mcpjam.com", async () => {
    setHostname("score.mcpjam.com");

    const { result } = renderHook(() => useActorKey());

    await waitFor(() => {
      expect(mockState.getOrCreateGuestSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current).toBe("guest_1");
    });
  });
});
