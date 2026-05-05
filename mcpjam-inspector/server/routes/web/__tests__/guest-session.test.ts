import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import guestSession from "../guest-session.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_REMOTE_URL = process.env.MCPJAM_GUEST_SESSION_URL;
const ORIGINAL_SHARED_SECRET = process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;
const ORIGINAL_NON_PROD_LOCKDOWN = process.env.MCPJAM_NONPROD_LOCKDOWN;
const ORIGINAL_FETCH = global.fetch;

const SAMPLE_COOKIE =
  "__Host-mcpjam_guest_session=cookie-set-by-convex; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000";

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/guest-session", guestSession);
  return app;
}

describe("POST /guest-session", () => {
  let app: Hono;
  let sessionCounter: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionCounter = 0;
    process.env.NODE_ENV = "test";
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    delete process.env.MCPJAM_GUEST_SESSION_URL;
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
    delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET =
      "test-guest-session-secret";
    global.fetch = vi.fn().mockImplementation(async () => {
      sessionCounter += 1;
      return new Response(
        JSON.stringify({
          guestId: `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`,
          token: `header-${sessionCounter}.payload-${sessionCounter}.signature-${sessionCounter}`,
          expiresAt: Date.now() + 60_000 + sessionCounter,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": SAMPLE_COOKIE,
          },
        },
      );
    }) as typeof fetch;
    app = createTestApp();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    if (ORIGINAL_REMOTE_URL === undefined) {
      delete process.env.MCPJAM_GUEST_SESSION_URL;
    } else {
      process.env.MCPJAM_GUEST_SESSION_URL = ORIGINAL_REMOTE_URL;
    }
    if (ORIGINAL_HOSTED_MODE === undefined) {
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
    } else {
      process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
    }
    if (ORIGINAL_NON_PROD_LOCKDOWN === undefined) {
      delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    } else {
      process.env.MCPJAM_NONPROD_LOCKDOWN = ORIGINAL_NON_PROD_LOCKDOWN;
    }
    if (ORIGINAL_SHARED_SECRET === undefined) {
      delete process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
    } else {
      process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = ORIGINAL_SHARED_SECRET;
    }
    global.fetch = ORIGINAL_FETCH;
  });

  describe("token issuance", () => {
    it("returns 200 with guestId, token, and expiresAt", async () => {
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });

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
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
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
  });

  it("forwards Set-Cookie from Convex to the browser", async () => {
    const res = await app.request("/guest-session", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(
      "__Host-mcpjam_guest_session=cookie-set-by-convex",
    );
  });

  it("forwards browser Cookie/User-Agent but not spoofable IP headers upstream", async () => {
    await app.request("/guest-session", {
      method: "POST",
      headers: {
        cookie: "__Host-mcpjam_guest_session=raw-cookie-id",
        "user-agent": "BrowserAgent/1.0",
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.7",
      },
    });

    const upstreamCall = vi.mocked(global.fetch).mock.calls[0]!;
    expect(upstreamCall[0]).toBe(
      "https://test-deployment.convex.site/guest/session",
    );
    const init = upstreamCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe("__Host-mcpjam_guest_session=raw-cookie-id");
    expect(headers["User-Agent"]).toBe("BrowserAgent/1.0");
    expect(headers["X-Forwarded-For"]).toBeUndefined();
    expect(headers["X-Real-IP"]).toBeUndefined();
  });

  it("forwards only the guest-session cookie upstream, not other origin cookies", async () => {
    await app.request("/guest-session", {
      method: "POST",
      headers: {
        "x-forwarded-for": "10.0.99.1",
        cookie:
          "session=secret-app-session; csrf=abc123; __Host-mcpjam_guest_session=raw-cookie-id; other=keep",
      },
    });

    const upstreamCall = vi.mocked(global.fetch).mock.calls[0]!;
    const init = upstreamCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe("__Host-mcpjam_guest_session=raw-cookie-id");
    expect(headers["Cookie"]).not.toContain("session=secret-app-session");
    expect(headers["Cookie"]).not.toContain("csrf=abc123");
    expect(headers["Cookie"]).not.toContain("other=keep");
  });

  it("omits Cookie header upstream when guest-session cookie is absent", async () => {
    await app.request("/guest-session", {
      method: "POST",
      headers: {
        "x-forwarded-for": "10.0.99.2",
        cookie: "session=secret-app-session; csrf=abc123",
      },
    });

    const upstreamCall = vi.mocked(global.fetch).mock.calls[0]!;
    const init = upstreamCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBeUndefined();
  });

  it("forwards mode and legacyToken from request body to upstream", async () => {
    await app.request("/guest-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "lookup_only",
        legacyToken: "old-jwt",
      }),
    });

    const upstreamCall = vi.mocked(global.fetch).mock.calls[0]!;
    const init = upstreamCall[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({ mode: "lookup_only", legacyToken: "old-jwt" }),
    );
  });

  it("returns 204 when upstream lookup_only finds no session", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch;

    const res = await app.request("/guest-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "lookup_only" }),
    });
    expect(res.status).toBe(204);
  });

  it("returns 403 with passthrough Set-Cookie when upstream revokes", async () => {
    const expiredCookie =
      "__Host-mcpjam_guest_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ code: "FORBIDDEN", message: "Guest session revoked" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": expiredCookie,
          },
        },
      ),
    ) as typeof fetch;

    const res = await app.request("/guest-session", { method: "POST" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const data = await res.json();
    expect(data.code).toBe("FORBIDDEN");
  });

  it("returns 403 when non-prod lockdown is enabled", async () => {
    process.env.MCPJAM_NONPROD_LOCKDOWN = "true";

    const res = await app.request("/guest-session", { method: "POST" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "FORBIDDEN",
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

  describe("remote guest session mode", () => {
    it("relays through hosted Inspector in local production", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
      delete process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            guestId: "guest-remote",
            token: "remote-token",
            expiresAt: 123456789,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ) as typeof fetch;

      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({
        guestId: "guest-remote",
        token: "remote-token",
        expiresAt: 123456789,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://app.mcpjam.com/api/web/guest-session",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          signal: expect.anything(),
        }),
      );
    });

    it("returns 503 when the Convex guest session cannot be fetched", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "nope" }), { status: 503 }),
        ) as typeof fetch;

      const res = await app.request("/guest-session", { method: "POST" });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe("INTERNAL_ERROR");
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
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.2" },
        });
      }

      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.code).toBe("RATE_LIMITED");
    });

    it("rate limits are per-IP", async () => {
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.3" },
        });
      }

      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.4" },
      });
      expect(res.status).toBe(200);
    });

    it("uses first IP from x-forwarded-for when multiple present", async () => {
      for (let i = 0; i < 10; i++) {
        await app.request("/guest-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.5, 10.0.0.6, 10.0.0.7" },
        });
      }

      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.5" },
      });
      expect(res.status).toBe(429);

      const res2 = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.6" },
      });
      expect(res2.status).toBe(200);
    });

    it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
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

    it("fails closed in production when no client IP header is available", async () => {
      process.env.NODE_ENV = "production";

      const res = await app.request("/guest-session", { method: "POST" });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.code).toBe("RATE_LIMITED");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
