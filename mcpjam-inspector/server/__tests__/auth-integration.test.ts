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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { sessionAuthMiddleware } from "../middleware/session-auth.js";
import { originValidationMiddleware } from "../middleware/origin-validation.js";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";
import {
  applyHostedPartition,
  mountHostedOpenRoutes,
} from "../middleware/hosted-partition.js";
import { __resetModelsCacheForTests } from "../routes/mcp/models.js";
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
  app.get("/api/apps/mcp-apps/widget", (c) => c.json({ widget: true }));

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
      { path: "/api/apps/mcp-apps/widget", description: "MCP apps widget" },
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

/**
 * Hosted-mode partition: the /api/mcp and /api/apps families are 410'd in
 * hosted deployments, except a small allowlist of read-only public paths. This
 * exercises the REAL shared middleware (applyHostedPartition +
 * mountHostedOpenRoutes) both production entries use, so the two entrypoints
 * can't silently drift and the public model catalog stays reachable.
 */
describe("hosted-mode partition", () => {
  let app: Hono;
  const originalFetch = global.fetch;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    generateSessionToken();
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    __resetModelsCacheForTests();
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "openai/gpt-4o" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    // Assemble the hosted middleware stack in the same order as the real
    // entries; calling applyHostedPartition unconditionally simulates
    // HOSTED_MODE=true (the entries gate the call on that flag).
    app = new Hono();
    app.use("*", securityHeadersMiddleware);
    app.use("*", originValidationMiddleware);
    applyHostedPartition(app);
    app.use("*", sessionAuthMiddleware);
    mountHostedOpenRoutes(app);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __resetModelsCacheForTests();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  });

  it("keeps the public model catalog reachable (not 410)", async () => {
    const res = await app.request("/api/mcp/models");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("keeps /api/mcp/health reachable", async () => {
    const res = await app.request("/api/mcp/health");
    expect(res.status).toBe(200);
  });

  it("410s a partitioned MCP sibling like /api/mcp/servers", async () => {
    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("FEATURE_NOT_SUPPORTED");
  });

  it("keeps /api/apps/health reachable but 410s other apps routes", async () => {
    expect((await app.request("/api/apps/health")).status).toBe(200);
    const blocked = await app.request("/api/apps/mcp-apps/widget");
    expect(blocked.status).toBe(410);
  });

  it("410s /api/session-token in hosted mode", async () => {
    const res = await app.request("/api/session-token");
    expect(res.status).toBe(410);
  });

  it("410s a trailing-slash /api/mcp/models/ (exact-match allowlist)", async () => {
    const res = await app.request("/api/mcp/models/");
    expect(res.status).toBe(410);
  });
});
