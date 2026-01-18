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

  beforeEach(async () => {
    // Reset module state by clearing the cache and re-importing
    vi.resetModules();

    // Clear any window token
    delete (window as any).__MCP_SESSION_TOKEN__;

    // Reset fetch mock
    vi.mocked(global.fetch).mockReset();

    // Import fresh module
    sessionToken = await import("../session-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getSessionToken", () => {
    it("returns empty string when no token is available", () => {
      expect(sessionToken.getSessionToken()).toBe("");
    });

    it("returns token from window.__MCP_SESSION_TOKEN__", () => {
      (window as any).__MCP_SESSION_TOKEN__ = "test-token-from-window";

      expect(sessionToken.getSessionToken()).toBe("test-token-from-window");
    });

    it("caches token after first read from window", () => {
      (window as any).__MCP_SESSION_TOKEN__ = "cached-token";

      // First read
      sessionToken.getSessionToken();

      // Clear window token
      delete (window as any).__MCP_SESSION_TOKEN__;

      // Should still return cached value
      expect(sessionToken.getSessionToken()).toBe("cached-token");
    });
  });

  describe("hasSessionToken", () => {
    it("returns false when no token is available", () => {
      expect(sessionToken.hasSessionToken()).toBe(false);
    });

    it("returns true when window token is available", () => {
      (window as any).__MCP_SESSION_TOKEN__ = "window-token";

      expect(sessionToken.hasSessionToken()).toBe(true);
    });
  });

  describe("getAuthHeaders", () => {
    it("returns empty object when no token is available", () => {
      const headers = sessionToken.getAuthHeaders();

      expect(headers).toEqual({});
    });

    it("returns auth header when token is available", () => {
      (window as any).__MCP_SESSION_TOKEN__ = "auth-token";

      const headers = sessionToken.getAuthHeaders();

      expect(headers).toEqual({
        "X-MCP-Session-Auth": "Bearer auth-token",
      });
    });

    it("logs warning when token is not available", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      sessionToken.getAuthHeaders();

      expect(warnSpy).toHaveBeenCalledWith(
        "[Auth] Session token not available"
      );
    });
  });

  describe("addTokenToUrl", () => {
    beforeEach(() => {
      (window as any).__MCP_SESSION_TOKEN__ = "url-token";
    });

    it("adds token to URL without query params", () => {
      const result = sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(result).toBe("/api/mcp/stream?_token=url-token");
    });

    it("adds token to URL with existing query params", () => {
      const result = sessionToken.addTokenToUrl("/api/mcp/stream?serverId=foo");

      expect(result).toBe("/api/mcp/stream?serverId=foo&_token=url-token");
    });

    it("returns same-origin URLs as relative paths", () => {
      const result = sessionToken.addTokenToUrl(
        `${window.location.origin}/api/mcp/stream`
      );

      expect(result).toBe("/api/mcp/stream?_token=url-token");
    });

    it("returns original URL when no token is available", async () => {
      // Re-import without token
      vi.resetModules();
      delete (window as any).__MCP_SESSION_TOKEN__;
      sessionToken = await import("../session-token");

      const result = sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(result).toBe("/api/mcp/stream");
    });

    it("logs warning when token is not available", async () => {
      vi.resetModules();
      delete (window as any).__MCP_SESSION_TOKEN__;
      sessionToken = await import("../session-token");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      sessionToken.addTokenToUrl("/api/mcp/stream");

      expect(warnSpy).toHaveBeenCalledWith(
        "[Auth] Session token not available for URL"
      );
    });
  });

  describe("initializeSessionToken", () => {
    it("returns token from window immediately if available", async () => {
      (window as any).__MCP_SESSION_TOKEN__ = "init-window-token";

      const token = await sessionToken.initializeSessionToken();

      expect(token).toBe("init-window-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("fetches token from API when window token is not available", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: "api-token" }),
      } as Response);

      const token = await sessionToken.initializeSessionToken();

      expect(token).toBe("api-token");
      expect(global.fetch).toHaveBeenCalledWith("/api/session-token");
    });

    it("throws error when API call fails", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(sessionToken.initializeSessionToken()).rejects.toThrow(
        "Failed to get session token: 500"
      );
    });

    it("caches token after successful API fetch", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: "cached-api-token" }),
      } as Response);

      await sessionToken.initializeSessionToken();

      // Second call should not fetch again
      const token = await sessionToken.initializeSessionToken();

      expect(token).toBe("cached-api-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("allows retry after fetch failure", async () => {
      // First call fails
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(sessionToken.initializeSessionToken()).rejects.toThrow();

      // Second call succeeds
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "retry-token" }),
      } as Response);

      const token = await sessionToken.initializeSessionToken();

      expect(token).toBe("retry-token");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("deduplicates concurrent fetch requests", async () => {
      let resolveCount = 0;
      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCount++;
            setTimeout(() => {
              resolve({
                ok: true,
                json: () => Promise.resolve({ token: "dedup-token" }),
              } as Response);
            }, 10);
          })
      );

      // Fire multiple concurrent requests
      const results = await Promise.all([
        sessionToken.initializeSessionToken(),
        sessionToken.initializeSessionToken(),
        sessionToken.initializeSessionToken(),
      ]);

      expect(results).toEqual(["dedup-token", "dedup-token", "dedup-token"]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("authFetch", () => {
    beforeEach(() => {
      (window as any).__MCP_SESSION_TOKEN__ = "fetch-token";
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
