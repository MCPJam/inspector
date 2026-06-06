/**
 * Session Authentication Middleware Tests
 *
 * Tests for the session authentication middleware that protects API routes.
 * This is a critical security component.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { sessionAuthMiddleware, scrubTokenFromUrl } from "../session-auth.js";
import {
  generateSessionToken,
  getSessionToken,
} from "../../services/session-token.js";

/**
 * Creates a test Hono app with the session auth middleware.
 */
function createTestApp(): Hono {
  const app = new Hono();

  // Apply session auth middleware
  app.use("*", sessionAuthMiddleware);

  // Test routes - protected API routes
  app.get("/api/mcp/test", (c) => c.json({ message: "protected route" }));
  app.post("/api/mcp/test", (c) => c.json({ message: "protected post route" }));
  app.get("/api/mcp/servers/rpc/stream", (c) =>
    c.json({ message: "sse route" }),
  );

  // Unprotected routes
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));
  app.get("/api/session-token", (c) => c.json({ token: "test" }));

  // Unprotected prefixes
  app.get("/assets/main.js", (c) => c.text("console.log('hello')"));
  app.get("/api/mcp/oauth/callback", (c) => c.json({ oauth: "callback" }));
  app.get("/api/apps/mcp-apps/widget", (c) => c.json({ widget: "data" }));
  app.get("/api/apps/mcp-apps/sandbox-proxy/content", (c) =>
    c.text("sandbox content"),
  );
  // Widget file routes — DOWNLOAD is iframe-accessible (unauthenticated),
  // UPLOAD is host-only (must require auth — see session-auth.ts).
  app.get("/api/apps/files/file/file_abc", (c) => c.body("image-bytes"));
  app.post("/api/apps/files/upload-file", (c) =>
    c.json({ fileId: "file_abc" }),
  );

  // Non-API routes (HTML pages, etc.)
  app.get("/", (c) => c.html("<html>Home</html>"));
  app.get("/inspector", (c) => c.html("<html>Inspector</html>"));

  return app;
}

describe("sessionAuthMiddleware", () => {
  let app: Hono;
  let validToken: string;

  beforeEach(() => {
    app = createTestApp();
    validToken = generateSessionToken();
  });

  describe("protected routes", () => {
    it("returns 401 when no token is provided", async () => {
      const res = await app.request("/api/mcp/test");

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
      expect(data.message).toBe("Session token required.");
    });

    it("returns 401 when invalid token is provided in header", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { "X-MCP-Session-Auth": "Bearer invalid-token" },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
      expect(data.message).toBe("Invalid session token.");
    });

    it("allows request with valid token in header", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { "X-MCP-Session-Auth": `Bearer ${validToken}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toBe("protected route");
    });

    it("rejects session tokens supplied in query parameters", async () => {
      const res = await app.request(`/api/mcp/test?_token=${validToken}`);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("prefers header over query parameter when both present", async () => {
      const res = await app.request(
        `/api/mcp/test?_token=invalid-query-token`,
        {
          headers: { "X-MCP-Session-Auth": `Bearer ${validToken}` },
        },
      );

      // Should succeed because header token is valid
      expect(res.status).toBe(200);
    });

    it("falls back to cookie when header is missing", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { Cookie: `mcp_session_auth=${validToken}` },
      });

      expect(res.status).toBe(200);
    });

    it("works with POST requests", async () => {
      const res = await app.request("/api/mcp/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({ data: "test" }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 401 for POST without token", async () => {
      const res = await app.request("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("SSE route hints", () => {
    it("provides SSE-specific hint for SSE routes without token", async () => {
      const res = await app.request("/api/mcp/servers/rpc/stream");

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.hint).toContain("mcp_session_auth cookie");
    });

    it("provides header hint for non-SSE routes without token", async () => {
      const res = await app.request("/api/mcp/test");

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.hint).toContain("X-MCP-Session-Auth");
    });
  });

  describe("CORS preflight requests", () => {
    it("allows OPTIONS requests without authentication", async () => {
      const res = await app.request("/api/mcp/test", {
        method: "OPTIONS",
      });

      // OPTIONS should pass through (404 because no CORS middleware, but not 401)
      expect(res.status).not.toBe(401);
    });
  });

  describe("unprotected routes", () => {
    it("allows /health without token", async () => {
      const res = await app.request("/health");

      expect(res.status).toBe(200);
    });

    it("allows /api/mcp/health without token", async () => {
      const res = await app.request("/api/mcp/health");

      expect(res.status).toBe(200);
    });

    it("allows /api/session-token without token", async () => {
      const res = await app.request("/api/session-token");

      expect(res.status).toBe(200);
    });
  });

  describe("unprotected prefixes", () => {
    it("allows /assets/ without token", async () => {
      const res = await app.request("/assets/main.js");

      expect(res.status).toBe(200);
    });

    it("requires token for /api/mcp/oauth/ routes", async () => {
      const res = await app.request("/api/mcp/oauth/callback");

      expect(res.status).toBe(401);
    });

    it("allows /api/mcp/oauth/ with valid token", async () => {
      const res = await app.request("/api/mcp/oauth/callback", {
        headers: { "X-MCP-Session-Auth": `Bearer ${validToken}` },
      });

      expect(res.status).toBe(200);
    });

    it("allows /api/apps/mcp-apps/ without token", async () => {
      const res = await app.request("/api/apps/mcp-apps/widget");

      expect(res.status).toBe(200);
    });

    it("allows /api/apps/mcp-apps/sandbox-proxy without token", async () => {
      const res = await app.request("/api/apps/mcp-apps/sandbox-proxy/content");

      expect(res.status).toBe(200);
    });

    it("allows GET /api/apps/files/file/:fileId without token (iframe download)", async () => {
      // The widget iframe fetches the download URL directly (img src, fetch,
      // etc.) and can't carry session headers; download must stay public.
      const res = await app.request("/api/apps/files/file/file_abc");
      expect(res.status).toBe(200);
    });

    it("requires auth on POST /api/apps/files/upload-file (host-only)", async () => {
      // Upload is called from the host page via authFetch, which CAN
      // attach the session token. Allowing it through unauthenticated
      // would let any caller fill the in-memory fileStore (20MB/req) by
      // hitting this route directly. Pin the auth requirement.
      const res = await app.request("/api/apps/files/upload-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "dummy", mimeType: "image/png" }),
      });
      expect(res.status).toBe(401);
    });

    it("accepts upload-file POST when a valid session token is attached", async () => {
      const res = await app.request("/api/apps/files/upload-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({ data: "dummy", mimeType: "image/png" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("non-API routes", () => {
    it("allows root path without token", async () => {
      const res = await app.request("/");

      expect(res.status).toBe(200);
    });

    it("allows HTML pages without token", async () => {
      const res = await app.request("/inspector");

      expect(res.status).toBe(200);
    });
  });

  describe("token format validation", () => {
    it("rejects Bearer prefix without token", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { "X-MCP-Session-Auth": "Bearer " },
      });

      expect(res.status).toBe(401);
    });

    it("rejects non-Bearer auth scheme", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { "X-MCP-Session-Auth": `Basic ${validToken}` },
      });

      expect(res.status).toBe(401);
    });

    it("rejects token without Bearer prefix", async () => {
      const res = await app.request("/api/mcp/test", {
        headers: { "X-MCP-Session-Auth": validToken },
      });

      expect(res.status).toBe(401);
    });
  });
});

describe("scrubTokenFromUrl", () => {
  it("scrubs token from URL with single query param", () => {
    const url = "/api/test?_token=abc123secret";
    expect(scrubTokenFromUrl(url)).toBe("/api/test?_token=[REDACTED]");
  });

  it("scrubs token from URL with multiple query params", () => {
    const url = "/api/test?serverId=foo&_token=abc123secret&other=value";
    expect(scrubTokenFromUrl(url)).toBe(
      "/api/test?serverId=foo&_token=[REDACTED]&other=value",
    );
  });

  it("scrubs token when it's the last param", () => {
    const url = "/api/test?serverId=foo&_token=abc123secret";
    expect(scrubTokenFromUrl(url)).toBe(
      "/api/test?serverId=foo&_token=[REDACTED]",
    );
  });

  it("handles URL without token", () => {
    const url = "/api/test?serverId=foo";
    expect(scrubTokenFromUrl(url)).toBe("/api/test?serverId=foo");
  });

  it("handles URL with no query params", () => {
    const url = "/api/test";
    expect(scrubTokenFromUrl(url)).toBe("/api/test");
  });
});
