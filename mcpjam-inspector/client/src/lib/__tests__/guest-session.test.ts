/**
 * Guest Session Client Module Tests
 *
 * Tests for the client-side guest session manager.
 * Covers localStorage persistence, token fetching, expiry handling,
 * request deduplication, and session cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("guest-session module", () => {
  let guestSession: typeof import("../guest-session");

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(global.fetch).mockReset();

    // Clear localStorage
    localStorage.clear();
    vi.mocked(localStorage.getItem).mockClear();
    vi.mocked(localStorage.setItem).mockClear();
    vi.mocked(localStorage.removeItem).mockClear();

    // Import fresh module
    guestSession = await import("../guest-session");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getOrCreateGuestSession", () => {
    it("fetches a new session when localStorage is empty", async () => {
      const mockSession = {
        guestId: "test-guest-id",
        token: "test-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSession),
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toEqual(mockSession);
      expect(global.fetch).toHaveBeenCalledWith("/api/web/guest-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("stores fetched session in localStorage", async () => {
      const mockSession = {
        guestId: "stored-guest-id",
        token: "stored-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSession),
      } as Response);

      await guestSession.getOrCreateGuestSession();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        "mcpjam_guest_session_v1",
        JSON.stringify(mockSession),
      );
    });

    it("returns cached session from localStorage when not expired", async () => {
      const cachedSession = {
        guestId: "cached-guest-id",
        token: "cached-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h from now
      };

      vi.mocked(localStorage.getItem).mockReturnValue(
        JSON.stringify(cachedSession),
      );

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toEqual(cachedSession);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("refreshes session when within 5-minute expiry buffer", async () => {
      const almostExpired = {
        guestId: "expiring-guest-id",
        token: "expiring-token",
        expiresAt: Date.now() + 4 * 60 * 1000, // Only 4 minutes left
      };

      vi.mocked(localStorage.getItem).mockReturnValue(
        JSON.stringify(almostExpired),
      );

      const newSession = {
        guestId: "new-guest-id",
        token: "new-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(newSession),
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toEqual(newSession);
      expect(global.fetch).toHaveBeenCalled();
    });

    it("refreshes session when already expired", async () => {
      const expired = {
        guestId: "expired-guest-id",
        token: "expired-token",
        expiresAt: Date.now() - 1000, // Already expired
      };

      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(expired));

      const newSession = {
        guestId: "fresh-guest-id",
        token: "fresh-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(newSession),
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toEqual(newSession);
    });

    it("returns null when fetch fails with non-ok response", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toBeNull();
    });

    it("returns null when fetch throws network error", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toBeNull();
    });

    it("handles invalid JSON in localStorage gracefully", async () => {
      vi.mocked(localStorage.getItem).mockReturnValue("not valid json{{{");

      const newSession = {
        guestId: "recovery-guest-id",
        token: "recovery-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(newSession),
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();

      expect(session).toEqual(newSession);
      expect(global.fetch).toHaveBeenCalled();
    });

    it("deduplicates concurrent fetch requests", async () => {
      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                ok: true,
                json: () =>
                  Promise.resolve({
                    guestId: "dedup-guest",
                    token: "dedup-token",
                    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
                  }),
              } as Response);
            }, 10);
          }),
      );

      const results = await Promise.all([
        guestSession.getOrCreateGuestSession(),
        guestSession.getOrCreateGuestSession(),
        guestSession.getOrCreateGuestSession(),
      ]);

      // All should get the same result
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);

      // Only one fetch should have been made
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("allows retry after failed fetch", async () => {
      // First call fails
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      const result1 = await guestSession.getOrCreateGuestSession();
      expect(result1).toBeNull();

      // Second call succeeds
      const newSession = {
        guestId: "retry-guest",
        token: "retry-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(newSession),
      } as Response);

      const result2 = await guestSession.getOrCreateGuestSession();
      expect(result2).toEqual(newSession);
    });

    it("uses session with exactly 5 min + 1ms remaining (valid)", async () => {
      const session = {
        guestId: "edge-guest",
        token: "edge-token",
        expiresAt: Date.now() + 5 * 60 * 1000 + 1, // 5 min + 1ms buffer
      };

      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(session));

      const result = await guestSession.getOrCreateGuestSession();

      expect(result).toEqual(session);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("getGuestBearerToken", () => {
    it("returns just the token string from a valid session", async () => {
      const mockSession = {
        guestId: "token-guest",
        token: "the-bearer-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSession),
      } as Response);

      const token = await guestSession.getGuestBearerToken();

      expect(token).toBe("the-bearer-token");
    });

    it("returns null when session creation fails", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Error",
      } as Response);

      const token = await guestSession.getGuestBearerToken();

      expect(token).toBeNull();
    });

    it("returns cached token from localStorage", async () => {
      const session = {
        guestId: "cached",
        token: "cached-bearer",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(session));

      const token = await guestSession.getGuestBearerToken();

      expect(token).toBe("cached-bearer");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("clearGuestSession", () => {
    it("removes session from localStorage", () => {
      guestSession.clearGuestSession();

      expect(localStorage.removeItem).toHaveBeenCalledWith(
        "mcpjam_guest_session_v1",
      );
    });

    it("can be called safely when no session exists", () => {
      expect(() => guestSession.clearGuestSession()).not.toThrow();
      expect(localStorage.removeItem).toHaveBeenCalledWith(
        "mcpjam_guest_session_v1",
      );
    });

    it("after clearing, next getOrCreate fetches a new session", async () => {
      // First, create a cached session
      const session1 = {
        guestId: "first",
        token: "first-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(session1));

      const result1 = await guestSession.getGuestBearerToken();
      expect(result1).toBe("first-token");
      expect(global.fetch).not.toHaveBeenCalled();

      // Clear the session
      guestSession.clearGuestSession();

      // Now localStorage should return null
      vi.mocked(localStorage.getItem).mockReturnValue(null);

      const session2 = {
        guestId: "second",
        token: "second-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(session2),
      } as Response);

      const result2 = await guestSession.getGuestBearerToken();
      expect(result2).toBe("second-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("forceRefreshGuestSession", () => {
    it("clears localStorage and fetches a new token", async () => {
      // Seed a cached session that looks valid by time
      const staleSession = {
        guestId: "stale",
        token: "stale-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      vi.mocked(localStorage.getItem).mockReturnValue(
        JSON.stringify(staleSession),
      );

      // Verify the stale session would be returned normally
      const before = await guestSession.getOrCreateGuestSession();
      expect(before?.token).toBe("stale-token");
      expect(global.fetch).not.toHaveBeenCalled();

      // Now simulate localStorage returning null after clear
      vi.mocked(localStorage.getItem).mockReturnValue(null);

      const freshSession = {
        guestId: "fresh",
        token: "fresh-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(freshSession),
      } as Response);

      const result = await guestSession.forceRefreshGuestSession();

      expect(localStorage.removeItem).toHaveBeenCalledWith(
        "mcpjam_guest_session_v1",
      );
      expect(result).toBe("fresh-token");
      expect(global.fetch).toHaveBeenCalledWith("/api/web/guest-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("returns null when server is unreachable", async () => {
      vi.mocked(localStorage.getItem).mockReturnValue(null);
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      const result = await guestSession.forceRefreshGuestSession();

      expect(result).toBeNull();
    });
  });
});
