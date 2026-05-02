/**
 * Guest Session Client Module Tests
 *
 * Cookie-backed guest sessions: the JWT lives only in module memory and
 * the persistent identity is the HttpOnly cookie owned by the backend.
 * Tests cover memory caching, credentials passthrough, lookup_only,
 * legacy localStorage migration (one-time), force refresh, and
 * deduplication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const LEGACY_STORAGE_KEY = "mcpjam_guest_session_v1";

describe("guest-session module", () => {
  let guestSession: typeof import("../guest-session");

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(global.fetch).mockReset();
    localStorage.clear();
    vi.mocked(localStorage.getItem).mockClear();
    vi.mocked(localStorage.setItem).mockClear();
    vi.mocked(localStorage.removeItem).mockClear();
    guestSession = await import("../guest-session");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getOrCreateGuestSession", () => {
    it("requests with credentials:include and lookup_or_create body", async () => {
      const mockSession = {
        guestId: "guest-1",
        token: "token-1",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSession),
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();
      expect(session).toEqual(mockSession);
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/web/guest-session",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "lookup_or_create" }),
        }),
      );
    });

    it("never persists session to localStorage", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            guestId: "g",
            token: "t",
            expiresAt: Date.now() + 60_000,
          }),
      } as Response);

      await guestSession.getOrCreateGuestSession();
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it("returns the in-memory session on subsequent calls without re-fetching", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            guestId: "g",
            token: "memory-token",
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }),
      } as Response);

      const a = await guestSession.getOrCreateGuestSession();
      const b = await guestSession.getOrCreateGuestSession();
      expect(a).toEqual(b);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("refetches when within 5-minute expiry buffer", async () => {
      const frozen = 1_700_000_000_000;
      vi.useFakeTimers({ now: frozen });

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              guestId: "g1",
              token: "almost-expired",
              expiresAt: frozen + 4 * 60 * 1000,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              guestId: "g2",
              token: "fresh",
              expiresAt: frozen + 24 * 60 * 60 * 1000,
            }),
        } as Response);

      await guestSession.getOrCreateGuestSession();
      const second = await guestSession.getOrCreateGuestSession();
      expect(second?.token).toBe("fresh");
      expect(global.fetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("returns null on non-ok response", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response);

      const session = await guestSession.getOrCreateGuestSession();
      expect(session).toBeNull();
    });

    it("returns null on network error", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error("network"));
      const session = await guestSession.getOrCreateGuestSession();
      expect(session).toBeNull();
    });

    it("deduplicates concurrent calls", async () => {
      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: () =>
                    Promise.resolve({
                      guestId: "dedup",
                      token: "dedup-token",
                      expiresAt: Date.now() + 60_000,
                    }),
                } as Response),
              5,
            );
          }),
      );

      const [a, b, c] = await Promise.all([
        guestSession.getOrCreateGuestSession(),
        guestSession.getOrCreateGuestSession(),
        guestSession.getOrCreateGuestSession(),
      ]);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("legacy migration", () => {
    it("forwards legacyToken from localStorage exactly once and deletes it after fetch", async () => {
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === LEGACY_STORAGE_KEY
          ? JSON.stringify({
              guestId: "legacy-id",
              token: "legacy-token",
              expiresAt: Date.now() - 1000,
            })
          : null,
      );

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            guestId: "legacy-id",
            token: "fresh",
            expiresAt: Date.now() + 60_000,
          }),
      } as Response);

      const a = await guestSession.getOrCreateGuestSession();
      expect(a?.token).toBe("fresh");
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/web/guest-session",
        expect.objectContaining({
          body: JSON.stringify({
            mode: "lookup_or_create",
            legacyToken: "legacy-token",
          }),
        }),
      );
      expect(localStorage.removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);

      // Force a refetch to ensure legacy token isn't sent twice.
      vi.mocked(global.fetch).mockClear();
      await guestSession.forceRefreshGuestSession();
      const lastCall = vi.mocked(global.fetch).mock.calls.at(-1);
      expect(lastCall?.[1]?.body).toBe(
        JSON.stringify({ mode: "lookup_or_create" }),
      );
    });

    it("deletes legacy token even when the migration fetch fails", async () => {
      vi.mocked(localStorage.getItem).mockReturnValue(
        JSON.stringify({
          guestId: "legacy",
          token: "legacy-token",
          expiresAt: Date.now() - 1000,
        }),
      );
      vi.mocked(global.fetch).mockRejectedValue(new Error("offline"));

      await guestSession.getOrCreateGuestSession();
      expect(localStorage.removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);
    });
  });

  describe("getExistingGuestBearerToken (lookup_only)", () => {
    it("sends mode:lookup_only and returns null on 204", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
      } as Response);

      const token = await guestSession.getExistingGuestBearerToken();
      expect(token).toBeNull();
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/web/guest-session",
        expect.objectContaining({
          credentials: "include",
          body: JSON.stringify({ mode: "lookup_only" }),
        }),
      );
    });

    it("returns existing cached token without re-fetching", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            guestId: "g",
            token: "cached-token",
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }),
      } as Response);

      await guestSession.getOrCreateGuestSession();
      vi.mocked(global.fetch).mockClear();

      const token = await guestSession.getExistingGuestBearerToken();
      expect(token).toBe("cached-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("forceRefreshGuestSession", () => {
    it("clears in-memory cache and re-requests with credentials", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              guestId: "g",
              token: "stale",
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              guestId: "g",
              token: "fresh",
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            }),
        } as Response);

      await guestSession.getOrCreateGuestSession();
      const refreshed = await guestSession.forceRefreshGuestSession();
      expect(refreshed).toBe("fresh");
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenLastCalledWith(
        "/api/web/guest-session",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("dedupes concurrent force-refresh calls", async () => {
      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: () =>
                    Promise.resolve({
                      guestId: "g",
                      token: "fresh",
                      expiresAt: Date.now() + 60_000,
                    }),
                } as Response),
              5,
            ),
          ),
      );

      const [a, b] = await Promise.all([
        guestSession.forceRefreshGuestSession(),
        guestSession.forceRefreshGuestSession(),
      ]);
      expect(a).toBe("fresh");
      expect(b).toBe("fresh");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearGuestSession", () => {
    it("drops only the in-memory cache, no localStorage call needed", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            guestId: "g",
            token: "memory",
            expiresAt: Date.now() + 60_000,
          }),
      } as Response);

      await guestSession.getOrCreateGuestSession();
      guestSession.clearGuestSession();
      expect(localStorage.removeItem).not.toHaveBeenCalledWith(
        LEGACY_STORAGE_KEY,
      );
    });
  });
});
