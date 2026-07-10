import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The relay rate limiter only runs in hosted mode; HOSTED_MODE is a
// module-load-time const, so it has to be mocked before importing the route.
// Kept in its own file so the main relay tests run with the real (local)
// config.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, HOSTED_MODE: true };
});

import relayRoutes, { relayBodyLimit } from "../relay.js";

const ORIGINAL_FETCH = global.fetch;

function createTestApp() {
  const app = new Hono();
  app.use("/relay/*", relayBodyLimit());
  app.route("/relay", relayRoutes);
  return app;
}

describe("posthog relay rate limit (hosted mode)", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(new Response("ok"));
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("keys on the trusted edge IP — spoofed rotating X-Forwarded-For cannot reset the bucket", async () => {
    const app = createTestApp();

    // x-real-ip (trusted edge header) is fixed; the client rotates its own
    // XFF every request trying to dodge the limiter. getClientIp prefers
    // x-real-ip, so all requests land in one bucket and the 601st is 429.
    let lastRes: Response | undefined;
    for (let i = 0; i < 601; i++) {
      lastRes = await app.request("http://localhost:6274/relay/i/v0/e/", {
        method: "POST",
        body: "{}",
        headers: {
          "X-Real-IP": "203.0.113.7",
          "X-Forwarded-For": `10.0.${Math.floor(i / 250)}.${i % 250}`,
        },
      });
    }

    expect(lastRes?.status).toBe(429);
    expect(await lastRes!.json()).toEqual({ error: "rate_limited" });
    expect(vi.mocked(fetch).mock.calls.length).toBe(600);

    // A different edge IP is a different bucket and still passes.
    const other = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
      headers: { "X-Real-IP": "203.0.113.8" },
    });
    expect(other.status).toBe(200);
  });
});
