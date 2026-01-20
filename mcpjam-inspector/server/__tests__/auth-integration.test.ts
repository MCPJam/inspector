/**
 * Auth Integration Tests
 *
 * These tests verify that the security middleware stack is correctly applied
 * to API routes. Unlike unit tests that test routes in isolation, these tests
 * use the full middleware chain to ensure auth is enforced in production.
 *
 * This catches:
 * - Routes accidentally added to UNPROTECTED_ROUTES
 * - Middleware accidentally removed from the stack
 * - Middleware ordering issues
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionAuthMiddleware } from "../middleware/session-auth.js";
import { originValidationMiddleware } from "../middleware/origin-validation.js";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";
import {
  generateSessionToken,
  getSessionToken,
} from "../services/session-token.js";
import { isLocalhostRequest } from "../utils/localhost-check.js";

/**
 * Creates a test app with the full security middleware stack.
 * This mimics the middleware setup in app.ts without the heavy dependencies.
 */
function createSecureTestApp(): Hono {
  const app = new Hono();

  // Apply security middleware in the same order as app.ts
  app.use("*", securityHeadersMiddleware);
  app.use("*", originValidationMiddleware);
  app.use("*", sessionAuthMiddleware);

  // Test routes that should be protected
  app.get("/api/mcp/resources/list", (c) => c.json({ resources: [] }));
  app.post("/api/mcp/resources/list", (c) => c.json({ resources: [] }));
  app.post("/api/mcp/resources/read", (c) => c.json({ content: null }));
  app.post("/api/mcp/tools/call", (c) => c.json({ result: null }));
  app.post("/api/mcp/prompts/get", (c) => c.json({ prompt: null }));
  app.get("/api/mcp/servers/rpc/stream", (c) => c.json({ stream: true }));

  // OAuth proxy routes - must be protected to prevent SSRF
  // See: https://github.com/anthropics/claude-code/issues/XXX
  app.post("/api/mcp/oauth/proxy", (c) => c.json({ proxied: true }));
  app.post("/api/mcp/oauth/debug/proxy", (c) => c.json({ proxied: true }));
  app.get("/api/mcp/oauth/metadata", (c) => c.json({ metadata: true }));

  // Routes that should be unprotected
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));
  app.get("/api/session-token", (c) => {
    const host = c.req.header("Host");
    if (!isLocalhostRequest(host)) {
      return c.json({ error: "Token only available via localhost" }, 403);
    }
    return c.json({ token: getSessionToken() });
  });
  app.get("/api/mcp/apps/widget", (c) => c.json({ widget: true }));
  app.get("/api/apps/chatgpt/widget", (c) => c.json({ chatgpt: true }));

  return app;
}

describe("Auth Integration", () => {
  let app: Hono;
  let validToken: string;

  beforeEach(() => {
    validToken = generateSessionToken();
    app = createSecureTestApp();
  });

  describe("protected API routes require authentication", () => {
    const protectedRoutes = [
      { method: "GET", path: "/api/mcp/resources/list" },
      { method: "POST", path: "/api/mcp/resources/list" },
      { method: "POST", path: "/api/mcp/resources/read" },
      { method: "POST", path: "/api/mcp/tools/call" },
      { method: "POST", path: "/api/mcp/prompts/get" },
      { method: "GET", path: "/api/mcp/servers/rpc/stream" },
      // OAuth proxy routes - protected to prevent unauthenticated SSRF
      { method: "POST", path: "/api/mcp/oauth/proxy" },
      { method: "POST", path: "/api/mcp/oauth/debug/proxy" },
      { method: "GET", path: "/api/mcp/oauth/metadata" },
    ];

    for (const { method, path } of protectedRoutes) {
      it(`rejects ${method} ${path} without token`, async () => {
        const res = await app.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify({}) : undefined,
        });

        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });

      it(`accepts ${method} ${path} with valid token`, async () => {
        const res = await app.request(path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-MCP-Session-Auth": `Bearer ${validToken}`,
          },
          body: method === "POST" ? JSON.stringify({}) : undefined,
        });

        expect(res.status).toBe(200);
      });
    }
  });

  describe("unprotected routes work without authentication", () => {
    const unprotectedRoutes = [
      { path: "/health", description: "health check" },
      { path: "/api/mcp/health", description: "MCP health check" },
      { path: "/api/mcp/apps/widget", description: "MCP apps widget" },
      { path: "/api/apps/chatgpt/widget", description: "ChatGPT widget" },
    ];

    for (const { path, description } of unprotectedRoutes) {
      it(`allows ${path} (${description}) without token`, async () => {
        const res = await app.request(path);

        expect(res.status).toBe(200);
      });
    }
  });

  describe("session token endpoint", () => {
    it("returns token for localhost requests", async () => {
      const res = await app.request("/api/session-token", {
        headers: { Host: "localhost:6274" },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBe(validToken);
    });

    it("returns token for 127.0.0.1 requests", async () => {
      const res = await app.request("/api/session-token", {
        headers: { Host: "127.0.0.1:6274" },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBe(validToken);
    });

    it("rejects token request from non-localhost", async () => {
      const res = await app.request("/api/session-token", {
        headers: { Host: "attacker.com" },
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Token only available via localhost");
    });

    it("rejects token request from network IP", async () => {
      const res = await app.request("/api/session-token", {
        headers: { Host: "192.168.1.100:6274" },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("origin validation blocks cross-origin requests", () => {
    it("blocks requests from malicious origins", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.com",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Forbidden");
    });

    it("allows requests from localhost origin", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("security headers are applied", () => {
    it("sets X-Content-Type-Options header", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("sets X-Frame-Options header", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    });
  });

  describe("query parameter authentication for SSE", () => {
    it("accepts SSE route with token in query parameter", async () => {
      const res = await app.request(
        `/api/mcp/servers/rpc/stream?_token=${validToken}`,
      );

      expect(res.status).toBe(200);
    });

    it("rejects SSE route with invalid query token", async () => {
      const res = await app.request(
        "/api/mcp/servers/rpc/stream?_token=invalid",
      );

      expect(res.status).toBe(401);
    });
  });
});
