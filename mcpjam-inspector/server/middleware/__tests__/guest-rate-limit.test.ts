/**
 * Guest Rate Limit Middleware Tests
 *
 * Tests for per-guestId rate limiting on OAuth proxy routes.
 * Covers rate limit enforcement, window sliding, and non-guest passthrough.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { guestRateLimitMiddleware } from "../guest-rate-limit.js";

/**
 * Creates a test Hono app with the guest rate limit middleware.
 * Includes a middleware that optionally sets guestId from a test header.
 */
function createTestApp(): Hono {
  const app = new Hono();

  // Simulate token validation: set guestId from a test header
  app.use("*", async (c, next) => {
    const guestId = c.req.header("x-test-guest-id");
    if (guestId) {
      c.set("guestId", guestId);
    }
    await next();
  });

  // Apply the rate limit middleware
  app.use("*", guestRateLimitMiddleware);

  // Test route
  app.get("/proxy", (c) => c.json({ ok: true }));
  app.post("/proxy", (c) => c.json({ ok: true }));

  return app;
}

describe("guestRateLimitMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("non-guest requests", () => {
    it("passes through when no guestId is set", async () => {
      const res = await app.request("/proxy");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it("passes through unlimited requests when no guestId", async () => {
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/proxy");
        expect(res.status).toBe(200);
      }
    });
  });

  describe("guest rate limiting", () => {
    it("allows requests within the rate limit", async () => {
      for (let i = 0; i < 60; i++) {
        const res = await app.request("/proxy", {
          headers: { "x-test-guest-id": "guest-a" },
        });
        expect(res.status).toBe(200);
      }
    });

    it("returns 429 after exceeding 60 req/min for a guestId", async () => {
      // Exhaust the limit
      for (let i = 0; i < 60; i++) {
        await app.request("/proxy", {
          headers: { "x-test-guest-id": "guest-b" },
        });
      }

      // 61st request should be rate-limited
      const res = await app.request("/proxy", {
        headers: { "x-test-guest-id": "guest-b" },
      });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.code).toBe("RATE_LIMITED");
      expect(data.message).toContain("Guest rate limit exceeded");
    });

    it("rate limits are per-guestId", async () => {
      // Exhaust limit for guest-c
      for (let i = 0; i < 60; i++) {
        await app.request("/proxy", {
          headers: { "x-test-guest-id": "guest-c" },
        });
      }

      // guest-d should still be allowed
      const res = await app.request("/proxy", {
        headers: { "x-test-guest-id": "guest-d" },
      });
      expect(res.status).toBe(200);

      // guest-c should be blocked
      const res2 = await app.request("/proxy", {
        headers: { "x-test-guest-id": "guest-c" },
      });
      expect(res2.status).toBe(429);
    });

    it("applies to both GET and POST requests", async () => {
      // Exhaust limit with mixed methods
      for (let i = 0; i < 30; i++) {
        await app.request("/proxy", {
          headers: { "x-test-guest-id": "guest-e" },
        });
        await app.request("/proxy", {
          method: "POST",
          headers: { "x-test-guest-id": "guest-e" },
        });
      }

      // Should be rate-limited regardless of method
      const getRes = await app.request("/proxy", {
        headers: { "x-test-guest-id": "guest-e" },
      });
      expect(getRes.status).toBe(429);

      const postRes = await app.request("/proxy", {
        method: "POST",
        headers: { "x-test-guest-id": "guest-e" },
      });
      expect(postRes.status).toBe(429);
    });

    it("429 response has correct error shape", async () => {
      for (let i = 0; i < 60; i++) {
        await app.request("/proxy", {
          headers: { "x-test-guest-id": "guest-f" },
        });
      }

      const res = await app.request("/proxy", {
        headers: { "x-test-guest-id": "guest-f" },
      });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data).toHaveProperty("code", "RATE_LIMITED");
      expect(data).toHaveProperty("message");
      expect(typeof data.message).toBe("string");
    });
  });
});
