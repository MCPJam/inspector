import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
