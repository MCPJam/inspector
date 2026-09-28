import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActorKey } from "../use-actor-key";

const mockState = vi.hoisted(() => ({
  auth: {
    user: null as { id: string } | null,
    isLoading: false,
  },
  getCachedGuestSession: vi.fn(),
  getOrCreateGuestSession: vi.fn(),
  subscribeGuestSessionChanges: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockState.auth,
}));

vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: mockState.getCachedGuestSession,
  getOrCreateGuestSession: mockState.getOrCreateGuestSession,
  subscribeGuestSessionChanges: mockState.subscribeGuestSessionChanges,
}));

describe("useActorKey", () => {
  beforeEach(() => {
    mockState.auth = { user: null, isLoading: false };
    mockState.getCachedGuestSession.mockReset();
    mockState.getCachedGuestSession.mockReturnValue(null);
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
