/**
 * Guest Session Endpoint Tests
 *
 * Tests for POST /api/web/guest-session.
 * Covers token issuance, response format, and IP-based rate limiting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import guestSession from "../guest-session.js";
import { initGuestTokenSecret } from "../../../services/guest-token.js";

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/guest-session", guestSession);
  return app;
}

describe("POST /guest-session", () => {
  let app: Hono;

  beforeEach(() => {
    initGuestTokenSecret();
    app = createTestApp();
  });

  describe("token issuance", () => {
    it("returns 200 with guestId, token, and expiresAt", async () => {
      const res = await app.request("/guest-session", { method: "POST" });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.guestId).toBeDefined();
      expect(typeof data.guestId).toBe("string");
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe("string");
      expect(data.expiresAt).toBeDefined();
      expect(typeof data.expiresAt).toBe("number");
    });

    it("returns a UUID guestId", async () => {
      const res = await app.request("/guest-session", { method: "POST" });
      const data = await res.json();

      expect(data.guestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("returns a three-part JWT token (header.payload.signature)", async () => {
      const res = await app.request("/guest-session", { method: "POST" });
      const data = await res.json();

      const parts = data.token.split(".");
      expect(parts.length).toBe(3);
    });

    it("returns expiresAt in the future", async () => {
      const before = Date.now();
      const res = await app.request("/guest-session", { method: "POST" });
      const data = await res.json();

      expect(data.expiresAt).toBeGreaterThan(before);
    });

    it("returns different tokens on successive requests", async () => {
      const res1 = await app.request("/guest-session", { method: "POST" });
      const res2 = await app.request("/guest-session", { method: "POST" });

      const data1 = await res1.json();
      const data2 = await res2.json();

      expect(data1.guestId).not.toBe(data2.guestId);
      expect(data1.token).not.toBe(data2.token);
    });
  });

  describe("HTTP method handling", () => {
    it("returns 404 for GET requests", async () => {
      const res = await app.request("/guest-session");
      expect(res.status).toBe(404);
    });

    it("returns 404 for PUT requests", async () => {
      const res = await app.request("/guest-session", { method: "PUT" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for DELETE requests", async () => {
      const res = await app.request("/guest-session", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("IP-based rate limiting", () => {
    it("allows up to 10 requests per IP", async () => {
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.1" },
        });
        expect(res.status).toBe(200);
      }
    });

    it("returns 429 after 10 requests from the same IP", async () => {
      // Exhaust the rate limit
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.2" },
        });
      }

      // 11th request should be rate-limited
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.code).toBe("RATE_LIMITED");
      expect(data.message).toBeDefined();
    });

    it("rate limits are per-IP", async () => {
      // Exhaust limit for IP1
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.3" },
        });
      }

      // IP2 should still be allowed
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.4" },
      });
      expect(res.status).toBe(200);
    });

    it("uses first IP from x-forwarded-for when multiple present", async () => {
      // Exhaust limit for the first IP in the chain
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.5, 10.0.0.6, 10.0.0.7" },
        });
      }

      // Same first IP should be rate-limited
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.5" },
      });
      expect(res.status).toBe(429);

      // Different first IP should be allowed
      const res2 = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.6" },
      });
      expect(res2.status).toBe(200);
    });

    it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
      // Exhaust limit using x-real-ip
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-real-ip": "10.0.0.8" },
        });
      }

      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-real-ip": "10.0.0.8" },
      });
      expect(res.status).toBe(429);
    });
  });
});
