/**
 * Origin Validation Middleware Tests
 *
 * Tests for the origin validation middleware that blocks requests from
 * non-localhost origins. This is defense-in-depth against DNS rebinding
 * and CSRF attacks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { originValidationMiddleware } from "../origin-validation.js";

/**
 * Creates a test Hono app with the origin validation middleware.
 */
function createTestApp(): Hono {
  const app = new Hono();

  // Apply origin validation middleware
  app.use("*", originValidationMiddleware);

  // Test route
  app.get("/api/test", (c) => c.json({ message: "success" }));
  app.post("/api/test", (c) => c.json({ message: "success" }));

  return app;
}

describe("originValidationMiddleware", () => {
  let app: Hono;
  const originalEnv = process.env.ALLOWED_ORIGINS;

  beforeEach(() => {
    app = createTestApp();
    // Clear any custom allowed origins
    delete process.env.ALLOWED_ORIGINS;
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv) {
      process.env.ALLOWED_ORIGINS = originalEnv;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  describe("requests without Origin header", () => {
    it("allows requests without Origin header (same-origin or non-browser)", async () => {
      const res = await app.request("/api/test");

      expect(res.status).toBe(200);
    });

    it("allows POST requests without Origin header", async () => {
      const res = await app.request("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("CORS preflight requests", () => {
    it("allows OPTIONS requests regardless of origin", async () => {
      const res = await app.request("/api/test", {
        method: "OPTIONS",
        headers: { Origin: "http://evil.com" },
      });

      // OPTIONS should pass through (not blocked by origin validation)
      expect(res.status).not.toBe(403);
    });
  });

  describe("localhost origins (default allowed)", () => {
    it("allows http://localhost:6274", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:6274" },
      });

      expect(res.status).toBe(200);
    });

    it("allows http://127.0.0.1:6274", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://127.0.0.1:6274" },
      });

      expect(res.status).toBe(200);
    });

    it("allows http://localhost:5173 (Vite dev server)", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(res.status).toBe(200);
    });

    it("allows http://127.0.0.1:5173", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://127.0.0.1:5173" },
      });

      expect(res.status).toBe(200);
    });

    it("allows http://localhost:8080 (Electron dev server)", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:8080" },
      });

      expect(res.status).toBe(200);
    });

    it("allows http://127.0.0.1:8080", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://127.0.0.1:8080" },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("non-localhost origins (blocked by default)", () => {
    it("blocks requests from external domains", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://evil.com" },
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Forbidden");
      expect(data.message).toBe("Request origin not allowed.");
    });

    it("blocks requests from IP addresses on network", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://192.168.1.100:6274" },
      });

      expect(res.status).toBe(403);
    });

    it("blocks requests from https domains", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "https://example.com" },
      });

      expect(res.status).toBe(403);
    });

    it("blocks requests from localhost with wrong port", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:9999" },
      });

      expect(res.status).toBe(403);
    });

    it("blocks requests from localhost without port", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost" },
      });

      expect(res.status).toBe(403);
    });

    it("blocks DNS rebinding attacks (attacker-controlled domain)", async () => {
      // Simulating a DNS rebinding attack where attacker.com resolves to 127.0.0.1
      const res = await app.request("/api/test", {
        headers: { Origin: "http://attacker-localhost.com" },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("custom allowed origins via environment variable", () => {
    it("allows custom origins from ALLOWED_ORIGINS env var", async () => {
      process.env.ALLOWED_ORIGINS = "http://custom.example.com,http://another.com";

      // Need to recreate app to pick up new env
      app = createTestApp();

      const res = await app.request("/api/test", {
        headers: { Origin: "http://custom.example.com" },
      });

      expect(res.status).toBe(200);
    });

    it("allows multiple custom origins", async () => {
      process.env.ALLOWED_ORIGINS =
        "http://first.com, http://second.com, http://third.com";

      app = createTestApp();

      const res1 = await app.request("/api/test", {
        headers: { Origin: "http://first.com" },
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/api/test", {
        headers: { Origin: "http://second.com" },
      });
      expect(res2.status).toBe(200);

      const res3 = await app.request("/api/test", {
        headers: { Origin: "http://third.com" },
      });
      expect(res3.status).toBe(200);
    });

    it("trims whitespace from custom origins", async () => {
      process.env.ALLOWED_ORIGINS = "  http://spacy.com  ,  http://another.com  ";

      app = createTestApp();

      const res = await app.request("/api/test", {
        headers: { Origin: "http://spacy.com" },
      });

      expect(res.status).toBe(200);
    });

    it("blocks origins not in custom list", async () => {
      process.env.ALLOWED_ORIGINS = "http://only-this.com";

      app = createTestApp();

      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:6274" },
      });

      // localhost is no longer allowed when custom origins are set
      expect(res.status).toBe(403);
    });
  });

  describe("security edge cases", () => {
    it("blocks origin with trailing slash", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:6274/" },
      });

      // Origins should not have trailing slash
      expect(res.status).toBe(403);
    });

    it("blocks origin with path", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "http://localhost:6274/some/path" },
      });

      expect(res.status).toBe(403);
    });

    it("is case sensitive for origin comparison", async () => {
      const res = await app.request("/api/test", {
        headers: { Origin: "HTTP://LOCALHOST:6274" },
      });

      // Origin header should be lowercase
      expect(res.status).toBe(403);
    });
  });
});
