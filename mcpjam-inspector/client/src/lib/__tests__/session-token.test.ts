/**
 * Session Token Client Module Tests
 *
 * Tests for the client-side session token utilities:
 * - Token initialization (from window or API)
 * - Auth headers generation
 * - URL token injection for SSE
 * - Authenticated fetch wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test the module in isolation, so we'll import fresh each time
// by resetting the module state between tests

describe("session-token module", () => {
  let sessionToken: typeof import("../session-token");

  /**
   * Run `fn` with `window.location` replaced by a page served from `origin`,
   * restoring the real location afterwards. Models the self-hosted LAN case
   * (BB-118) where the page is NOT on localhost.
   */
  const withPageOrigin = async (origin: string, fn: () => Promise<void>) => {
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, origin, href: `${origin}/` },
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: realLocation,
      });
    }
  };

  beforeEach(async () => {
    // Reset module state by clearing the cache and re-importing
    vi.resetModules();

    // Clear any access-link token
    localStorage.clear();

    // Reset fetch mock
    vi.mocked(global.fetch).mockReset();

    // Import fresh module
    sessionToken = await import("../session-token");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe("getSessionToken", () => {
    it("returns empty string when no token is available", async () => {
      expect(sessionToken.getSessionToken()).toBe("");
    });

    it("returns the credential held in memory", async () => {
      (await import("../access-link")).rememberAccessToken(
        "test-token-from-window",
      );

      expect(sessionToken.getSessionToken()).toBe("test-token-from-window");
    });

    it("keeps the in-memory credential if storage is cleared", async () => {
      (await import("../access-link")).rememberAccessToken("cached-token");

      // First read
      sessionToken.getSessionToken();

      // Clear access-link token
      localStorage.clear();

      // Should still return cached value
      expect(sessionToken.getSessionToken()).toBe("cached-token");
    });
  });

  describe("hasSessionToken", () => {
    it("returns false when no token is available", async () => {
      expect(sessionToken.hasSessionToken()).toBe(false);
    });

    it("returns true when access-link token is available", async () => {
      (await import("../access-link")).rememberAccessToken("window-token");

      expect(sessionToken.hasSessionToken()).toBe(true);
    });
  });

  describe("getAuthHeaders", () => {
    it("returns empty object when no token is available", async () => {
      const headers = sessionToken.getAuthHeaders();

      expect(headers).toEqual({});
    });

    it("returns auth header when token is available", async () => {
      (await import("../access-link")).rememberAccessToken("auth-token");

      const headers = sessionToken.getAuthHeaders();

      expect(headers).toEqual({
        "X-MCP-Session-Auth": "Bearer auth-token",
      });
    });

    it("logs warning when token is not available", async () => {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(async () => {});

      sessionToken.getAuthHeaders();

      expect(warnSpy).toHaveBeenCalledWith(
        "[Auth] Session token not available",
      );
    });
  });

  describe("addTokenToUrl", () => {
    beforeEach(async () => {
      (await import("../access-link")).rememberAccessToken("url-token");
    });

    it("adds token to URL without query params", async () => {
      const result = sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(result).toBe("/api/mcp/stream?_token=url-token");
    });

    it("adds token to URL with existing query params", async () => {
      const result = sessionToken.addTokenToUrl("/api/mcp/stream?serverId=foo");

      expect(result).toBe("/api/mcp/stream?serverId=foo&_token=url-token");
    });

    it("returns same-origin URLs as relative paths", async () => {
      const result = sessionToken.addTokenToUrl(
        `${window.location.origin}/api/mcp/stream`,
      );

      expect(result).toBe("/api/mcp/stream?_token=url-token");
    });

    it("keeps the full URL for an absolute loopback target", async () => {
      const result = sessionToken.addTokenToUrl(
        "http://127.0.0.1:6274/api/mcp/stream",
      );

      expect(result).toBe(
        "http://127.0.0.1:6274/api/mcp/stream?_token=url-token",
      );
    });

    it("attaches the token on a same-origin LAN page (self-hosted network access)", async () => {
      await withPageOrigin("http://192.168.1.50:6274", async () => {
        expect(sessionToken.addTokenToUrl("/api/mcp/stream")).toBe(
          "/api/mcp/stream?_token=url-token",
        );
        expect(
          sessionToken.addTokenToUrl("http://192.168.1.50:6274/api/mcp/stream"),
        ).toBe("/api/mcp/stream?_token=url-token");
      });
    });

    it("never attaches the token to a foreign absolute URL", async () => {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(async () => {});
      const foreign = "https://outstanding-fennec-304.convex.site/web/stream";

      expect(sessionToken.addTokenToUrl(foreign)).toBe(foreign);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("returns original URL when no token is available", async () => {
      // Re-import without token
      vi.resetModules();
      localStorage.clear();
      sessionToken = await import("../session-token");

      const result = sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(result).toBe("/api/mcp/stream");
    });

    it("logs warning when token is not available", async () => {
      vi.resetModules();
      localStorage.clear();
      sessionToken = await import("../session-token");

      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(async () => {});

      sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(warnSpy).toHaveBeenCalledWith(
        "[Auth] Session token not available for URL",
      );
    });
  });

  describe("initializeSessionToken", () => {
    const token = "valid-access-token-with-32-charsxx";
    it("confirms a saved credential without acquiring one over HTTP", async () => {
      localStorage.setItem("mcpjam.local-access", token);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true })),
      );
      expect(await sessionToken.initializeSessionToken()).toBe(token);
      expect(fetch).toHaveBeenCalledWith(
        "/api/session-token",
        expect.objectContaining({
          headers: { "X-MCP-Session-Auth": `Bearer ${token}` },
        }),
      );
    });
    it("reports expected access refusal when no credential exists", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ code: "ACCESS_LINK_REQUIRED" }), {
          status: 401,
        }),
      );
      await expect(sessionToken.initializeSessionToken()).rejects.toMatchObject(
        { status: 401, code: "ACCESS_LINK_REQUIRED", restarted: false },
      );
    });
    it("deduplicates confirmation and caches successful initialization", async () => {
      localStorage.setItem("mcpjam.local-access", token);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true })),
      );
      expect(
        await Promise.all([
          sessionToken.initializeSessionToken(),
          sessionToken.initializeSessionToken(),
        ]),
      ).toEqual([token, token]);
      expect(await sessionToken.initializeSessionToken()).toBe(token);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("can retry a transient failure", async () => {
      localStorage.setItem("mcpjam.local-access", token);
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
      await expect(sessionToken.initializeSessionToken()).rejects.toThrow(
        "offline",
      );
      expect(await sessionToken.initializeSessionToken()).toBe(token);
    });
  });

  describe("isSessionTokenHostDenied", () => {
    it("is true for a 403 SessionTokenError (host not allowed)", async () => {
      const error = new sessionToken.SessionTokenError(403);
      expect(sessionToken.isSessionTokenHostDenied(error)).toBe(true);
    });

    it("is false for other session-token statuses", async () => {
      expect(
        sessionToken.isSessionTokenHostDenied(
          new sessionToken.SessionTokenError(500),
        ),
      ).toBe(false);
    });

    it("is false for unrelated errors", async () => {
      expect(sessionToken.isSessionTokenHostDenied(new Error("boom"))).toBe(
        false,
      );
      expect(sessionToken.isSessionTokenHostDenied(undefined)).toBe(false);
    });
  });

  describe("authFetch", () => {
    beforeEach(async () => {
      (await import("../access-link")).rememberAccessToken("fetch-token");
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: "test" }),
      } as Response);
    });

    it("adds auth header to fetch requests", async () => {
      await sessionToken.authFetch("/api/test");

      expect(global.fetch).toHaveBeenCalledWith("/api/test", {
        headers: {
          "X-MCP-Session-Auth": "Bearer fetch-token",
        },
      });
    });

    it("merges auth header with existing headers", async () => {
      await sessionToken.authFetch("/api/test", {
        headers: {
          "Content-Type": "application/json",
        },
      });

      expect(global.fetch).toHaveBeenCalledWith("/api/test", {
        headers: {
          "X-MCP-Session-Auth": "Bearer fetch-token",
          "Content-Type": "application/json",
        },
      });
    });

    it("preserves other fetch options", async () => {
      await sessionToken.authFetch("/api/test", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: {
          "Content-Type": "application/json",
        },
      });

      expect(global.fetch).toHaveBeenCalledWith("/api/test", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: {
          "X-MCP-Session-Auth": "Bearer fetch-token",
          "Content-Type": "application/json",
        },
      });
    });

    it("keeps session auth on absolute loopback API URLs", async () => {
      await sessionToken.authFetch("http://127.0.0.1:6274/api/test");

      expect(global.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:6274/api/test",
        {
          headers: {
            "X-MCP-Session-Auth": "Bearer fetch-token",
          },
        },
      );
    });

    it("keeps session auth on same-origin API calls from a LAN page (self-hosted network access)", async () => {
      // The server issued the token to this allowlisted host
      // (MCPJAM_ALLOWED_HOSTS); the page must be able to send it back to the
      // same origin, or every call 401s and the feature is a dead end.
      await withPageOrigin("http://192.168.1.50:6274", async () => {
        await sessionToken.authFetch("/api/test");
        await sessionToken.authFetch("http://192.168.1.50:6274/api/test");

        expect(global.fetch).toHaveBeenNthCalledWith(1, "/api/test", {
          headers: { "X-MCP-Session-Auth": "Bearer fetch-token" },
        });
        expect(global.fetch).toHaveBeenNthCalledWith(
          2,
          "http://192.168.1.50:6274/api/test",
          { headers: { "X-MCP-Session-Auth": "Bearer fetch-token" } },
        );
      });
    });

    it("does not add session auth to a different port on the same LAN host", async () => {
      // Same hostname is not the same origin: another service on the box must
      // not receive the token.
      await withPageOrigin("http://192.168.1.50:6274", async () => {
        await sessionToken.authFetch("http://192.168.1.50:9999/api/test");

        expect(global.fetch).toHaveBeenCalledWith(
          "http://192.168.1.50:9999/api/test",
          { headers: {} },
        );
      });
    });

    it("does not add session auth to a non-/api path even on the same origin", async () => {
      await withPageOrigin("http://192.168.1.50:6274", async () => {
        await sessionToken.authFetch("http://192.168.1.50:6274/relay/e");

        expect(global.fetch).toHaveBeenCalledWith(
          "http://192.168.1.50:6274/relay/e",
          { headers: {} },
        );
      });
    });

    it("does not add session auth to cross-origin Convex HTTP requests", async () => {
      await sessionToken.authFetch(
        "https://outstanding-fennec-304.convex.site/web/registry/catalog",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      expect(global.fetch).toHaveBeenCalledWith(
        "https://outstanding-fennec-304.convex.site/web/registry/catalog",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });

    it("user-provided headers override auth headers", async () => {
      await sessionToken.authFetch("/api/test", {
        headers: {
          "X-MCP-Session-Auth": "Bearer custom-token",
        },
      });

      expect(global.fetch).toHaveBeenCalledWith("/api/test", {
        headers: {
          "X-MCP-Session-Auth": "Bearer custom-token",
        },
      });
    });
  });
});
