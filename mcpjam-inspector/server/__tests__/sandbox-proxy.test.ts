/**
 * Sandbox Proxy CSP Tests
 *
 * Tests for the MCP Apps sandbox-proxy endpoint (SEP-1865).
 * Verifies that CSP headers are correctly configured to allow
 * cross-origin framing in the double-iframe architecture.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";

// Mock fs to avoid file system dependency
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => "<html><body>Sandbox Proxy</body></html>"),
  },
}));

/**
 * Creates a test app that mimics the sandbox-proxy route setup.
 * Includes the security middleware to verify header override behavior.
 */
function createSandboxProxyTestApp(): Hono {
  const app = new Hono();

  // Apply security middleware (sets X-Frame-Options: SAMEORIGIN)
  app.use("*", securityHeadersMiddleware);

  // Sandbox proxy route (mirrors server/routes/mcp/index.ts)
  app.get("/api/mcp/sandbox-proxy", (c) => {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    // Allow cross-origin framing between localhost and 127.0.0.1 for double-iframe architecture
    c.header(
      "Content-Security-Policy",
      "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    );
    // Remove X-Frame-Options as it doesn't support multiple origins (CSP frame-ancestors takes precedence)
    c.res.headers.delete("X-Frame-Options");
    return c.body("<html><body>Sandbox Proxy</body></html>");
  });

  // Regular route for comparison (should keep X-Frame-Options)
  app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));

  return app;
}

describe("Sandbox Proxy CSP Headers", () => {
  let app: Hono;

  beforeEach(() => {
    app = createSandboxProxyTestApp();
  });

  describe("GET /api/mcp/sandbox-proxy", () => {
    it("sets Content-Security-Policy with frame-ancestors for localhost origins", async () => {
      const res = await app.request("/api/mcp/sandbox-proxy");

      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).toBe(
        "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
      );
    });

    it("removes X-Frame-Options header to avoid conflict with CSP", async () => {
      const res = await app.request("/api/mcp/sandbox-proxy");

      // X-Frame-Options should be removed (CSP frame-ancestors takes precedence)
      expect(res.headers.get("X-Frame-Options")).toBeNull();
    });

    it("sets correct Content-Type for HTML", async () => {
      const res = await app.request("/api/mcp/sandbox-proxy");

      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    });

    it("sets Cache-Control to prevent caching", async () => {
      const res = await app.request("/api/mcp/sandbox-proxy");

      expect(res.headers.get("Cache-Control")).toBe(
        "no-cache, no-store, must-revalidate",
      );
    });

    it("returns HTML content", async () => {
      const res = await app.request("/api/mcp/sandbox-proxy");

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<html>");
    });
  });

  describe("other routes retain X-Frame-Options", () => {
    it("health endpoint keeps X-Frame-Options from middleware", async () => {
      const res = await app.request("/api/mcp/health");

      // Regular routes should still have X-Frame-Options set by middleware
      expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    });
  });
});
