/**
 * OAuth Proxy Token Requirement Tests
 *
 * Tests for the bearer token requirement middleware added to OAuth web routes.
 * Validates that guest tokens, WorkOS tokens, and missing tokens are handled correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  initGuestTokenSecret,
  issueGuestToken,
  validateGuestToken,
} from "../../../services/guest-token.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";

/**
 * Creates a test app that replicates the middleware from oauth.ts
 * with simple test handlers (avoids importing real oauth-proxy utils).
 */
function createTestOAuthApp(): Hono {
  const app = new Hono();

  // Replicate the token requirement middleware from oauth.ts
  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Bearer token required" },
        401,
      );
    }

    const token = authHeader.slice("Bearer ".length);

    const result = validateGuestToken(token);
    if (result.valid && result.guestId) {
      c.set("guestId", result.guestId);
      return next();
    }

    // Not a guest token — assume WorkOS, allow through
    return next();
  });

  app.use("*", guestRateLimitMiddleware);

  // Test routes simulating OAuth proxy endpoints
  app.post("/proxy", (c) =>
    c.json({ proxied: true, guestId: c.get("guestId") ?? null }),
  );
  app.get("/metadata", (c) =>
    c.json({ metadata: true, guestId: c.get("guestId") ?? null }),
  );

  return app;
}

describe("OAuth proxy token middleware", () => {
  let app: Hono;

  beforeEach(() => {
    initGuestTokenSecret();
    app = createTestOAuthApp();
  });

  describe("no token", () => {
    it("returns 401 for request without Authorization header", async () => {
      const res = await app.request("/proxy", { method: "POST" });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.code).toBe("UNAUTHORIZED");
      expect(data.message).toBe("Bearer token required");
    });

    it("returns 401 for GET request without Authorization header", async () => {
      const res = await app.request("/metadata");

      expect(res.status).toBe(401);
    });

    it("returns 401 for non-Bearer auth scheme", async () => {
      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });

      expect(res.status).toBe(401);
    });

    it("returns 401 for Bearer with empty token value", async () => {
      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: "Bearer " },
      });

      // Hono trims header value, so "Bearer " becomes "Bearer" which
      // doesn't start with "Bearer " (note trailing space), returning 401
      expect(res.status).toBe(401);
    });
  });

  describe("guest token", () => {
    it("allows request with valid guest token", async () => {
      const { token } = issueGuestToken();

      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.proxied).toBe(true);
    });

    it("sets guestId in context for valid guest token", async () => {
      const { token, guestId } = issueGuestToken();

      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.guestId).toBe(guestId);
    });

    it("rejects expired guest token but allows through as WorkOS", async () => {
      // Issue token in the past
      const realDateNow = Date.now;
      vi.spyOn(Date, "now").mockReturnValue(
        realDateNow() - 25 * 60 * 60 * 1000,
      );
      const { token } = issueGuestToken();
      vi.spyOn(Date, "now").mockImplementation(realDateNow);

      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.guestId).toBeNull();
    });

    it("rejects tampered guest token but allows through as WorkOS", async () => {
      const { token } = issueGuestToken();
      const tamperedToken = token + "tampered";

      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.guestId).toBeNull();
    });
  });

  describe("WorkOS token (non-guest)", () => {
    it("allows request with a non-guest bearer token", async () => {
      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: "Bearer some-workos-jwt-token" },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.guestId).toBeNull();
    });

    it("allows request with JWT-like bearer token", async () => {
      const fakeJwt =
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakesig";

      const res = await app.request("/metadata", {
        headers: { Authorization: `Bearer ${fakeJwt}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.guestId).toBeNull();
    });
  });

  describe("rate limiting integration", () => {
    it("rate limits guest users after 60 requests", async () => {
      const { token } = issueGuestToken();

      for (let i = 0; i < 60; i++) {
        const res = await app.request("/proxy", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
      }

      const res = await app.request("/proxy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(429);
    });

    it("does not rate limit WorkOS tokens (no guestId set)", async () => {
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/proxy", {
          method: "POST",
          headers: { Authorization: "Bearer workos-token" },
        });
        expect(res.status).toBe(200);
      }
    });
  });
});
