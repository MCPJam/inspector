/**
 * Security Headers Middleware Tests
 *
 * Tests for the security headers middleware that stamps standard security
 * headers onto every response, including X-Robots-Tag: noindex — the hosted
 * app shell (app.mcpjam.com) is an authenticated tool, not indexable content,
 * and the SPA catch-all would otherwise let search engines index every route.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { securityHeadersMiddleware } from "../security-headers.js";

/**
 * Creates a test Hono app with the security headers middleware.
 */
function createTestApp(): Hono {
  const app = new Hono();

  app.use("*", securityHeadersMiddleware);

  app.get("/", (c) => c.html("<!doctype html><html></html>"));
  app.get("/api/test", (c) => c.json({ message: "success" }));

  return app;
}

describe("securityHeadersMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("sets the standard security headers on every response", async () => {
    const res = await app.request("/");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("marks responses noindex so the authenticated app shell stays out of search indexes", async () => {
    const res = await app.request("/");

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("applies headers to API responses too", async () => {
    const res = await app.request("/api/test");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});
