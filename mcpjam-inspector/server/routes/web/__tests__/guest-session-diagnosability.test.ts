import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import guestSession from "../guest-session.js";

/**
 * A 5xx from this route must carry its cause into `webErrorMeta`, which is
 * where `requestLogContextMiddleware` reads the code and message for
 * `http.request.failed`.
 *
 * On 2026-07-22 this path failed 434 times in a single day and every row logged
 * `errorCode: "internal_error"` with NO message, so the incident could not be
 * diagnosed afterwards. The route knew exactly why it failed — returning
 * `c.json` directly discarded that text at the response boundary, because a
 * direct return never sets `webErrorMeta`.
 *
 * Deliberately a separate file from `guest-session.test.ts`: that suite shares
 * module-level rate-limiter and env state across 28 tests, and appending here
 * perturbed it.
 */
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_SHARED_SECRET = process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
const ORIGINAL_FETCH = global.fetch;

describe("guest-session 5xx diagnosability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = "test";
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET =
      "test-guest-session-secret";
    delete process.env.MCPJAM_GUEST_SESSION_URL;
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
    // The upstream is down: this is the shape that produced the 07-22 rows.
    global.fetch = vi
      .fn()
      .mockImplementation(async () => new Response("nope", { status: 500 }));
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = ORIGINAL_SHARED_SECRET;
  });

  it("stashes the failure cause in webErrorMeta", async () => {
    let meta: Record<string, unknown> | undefined;
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      meta = c.get("webErrorMeta" as never) as Record<string, unknown>;
    });
    app.route("/guest-session", guestSession);

    const res = await app.request("/guest-session", {
      method: "POST",
      // Distinct client IP: the route rate-limits per IP, and a 429 would
      // never reach the 503 path this test exists to cover.
      headers: { "x-forwarded-for": "203.0.113.201" },
    });

    expect(res.status).toBe(503);
    expect(meta).toBeDefined();
    expect(meta?.status).toBe(503);
    expect(meta?.code).toBe("INTERNAL_ERROR");
    // The reason must survive to the log row, not only to the client.
    expect(String(meta?.message)).toContain("guest session");
  });

  it("leaves the response body shape unchanged", async () => {
    const app = new Hono();
    app.route("/guest-session", guestSession);

    const res = await app.request("/guest-session", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.202" },
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.message).toBe("string");
  });

  // A self-hosted install makes this 503 on the user's machine, so the body is
  // the only way the cause reaches the browser's error report — and on hosted
  // that body goes to any browser, so only closed values may be in it.
  describe("failure details on the 503", () => {
    async function postGuestSession(ip: string) {
      const app = new Hono();
      app.route("/guest-session", guestSession);
      const res = await app.request("/guest-session", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
      });
      return { res, body: (await res.json()) as Record<string, unknown> };
    }

    it("names an upstream non-ok status and keeps the message", async () => {
      const { res, body } = await postGuestSession("203.0.113.203");

      expect(res.status).toBe(503);
      expect(body.message).toBe(
        "Unable to obtain a guest session right now. Please try again.",
      );
      expect(body.details).toEqual({
        reason: "upstream_status",
        upstreamStatus: 500,
      });
    });

    it("names a relay network failure without leaking the host", async () => {
      // Self-hosted: relays to the hosted Inspector instead of Convex.
      process.env.NODE_ENV = "production";
      global.fetch = vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(
            new Error("getaddrinfo ENOTFOUND app.mcpjam.com"),
            { code: "ENOTFOUND" },
          ),
        }),
      );

      const { res, body } = await postGuestSession("203.0.113.204");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://app.mcpjam.com/api/web/guest-session",
        expect.anything(),
      );
      expect(res.status).toBe(503);
      expect(body.details).toEqual({
        reason: "network",
        networkCode: "ENOTFOUND",
      });
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("app.mcpjam.com");
      expect(raw).not.toContain("getaddrinfo");
    });

    it("names a relay timeout", async () => {
      process.env.NODE_ENV = "production";
      global.fetch = vi
        .fn()
        .mockRejectedValue(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );

      const { res, body } = await postGuestSession("203.0.113.205");

      expect(res.status).toBe(503);
      expect(body.details).toEqual({ reason: "timeout" });
    });
  });
});
