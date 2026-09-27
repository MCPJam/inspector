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

import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";

const ORIGINAL_FETCH = global.fetch;
const EDGE_SECRET = "edge-secret-for-tests";
const LIMIT = 600;

// A capture body for this deployment's project, so each request is one the
// relay forwards and only the limiter decides.
const CAPTURE_BODY = JSON.stringify({
  api_key: POSTHOG_PROJECT_KEY,
  batch: [
    {
      event: "$pageview",
      properties: { token: POSTHOG_PROJECT_KEY, distinct_id: "device-1" },
    },
  ],
});

// A fresh module per test, so each starts with empty rate-limit windows.
async function createTestApp() {
  vi.resetModules();
  const { default: relayRoutes, relayBodyLimit } = await import("../relay.js");
  const app = new Hono();
  app.use("/relay/*", relayBodyLimit());
  app.route("/relay", relayRoutes);
  return app;
}

function capture(app: Hono, headers: Record<string, string>) {
  return app.request("http://localhost:6274/relay/i/v0/e/", {
    method: "POST",
    body: CAPTURE_BODY,
    headers,
  });
}

function attested(ip: string, extra: Record<string, string> = {}) {
  return {
    "cf-connecting-ip": ip,
    "x-mcpjam-edge-secret": EDGE_SECRET,
    ...extra,
  };
}

describe("posthog relay rate limit (hosted mode)", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", EDGE_SECRET);
    global.fetch = vi.fn().mockResolvedValue(new Response("ok"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = ORIGINAL_FETCH;
  });

  it("keys on the attested client IP — rotating forwarding headers cannot reset the bucket", async () => {
    const app = await createTestApp();

    let lastRes: Response | undefined;
    for (let i = 0; i <= LIMIT; i++) {
      lastRes = await capture(
        app,
        attested("203.0.113.7", {
          "X-Real-IP": `10.1.${Math.floor(i / 250)}.${i % 250}`,
          "X-Forwarded-For": `10.0.${Math.floor(i / 250)}.${i % 250}`,
        }),
      );
    }

    expect(lastRes?.status).toBe(429);
    expect(await lastRes!.json()).toEqual({ error: "rate_limited" });
    expect(vi.mocked(fetch).mock.calls.length).toBe(LIMIT);

    // A different attested IP is a different bucket and still passes.
    const other = await capture(app, attested("203.0.113.8"));
    expect(other.status).toBe(200);
  });

  it("puts every request without an attested IP in one shared bucket", async () => {
    const app = await createTestApp();

    // Each request claims a different address, through headers a client can
    // write itself or with an edge secret that does not match.
    const unattested = (i: number): Record<string, string> => {
      const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
      switch (i % 4) {
        case 0:
          return { "cf-connecting-ip": ip };
        case 1:
          return { "cf-connecting-ip": ip, "x-mcpjam-edge-secret": "forged" };
        case 2:
          return { "X-Real-IP": ip };
        default:
          return { "X-Forwarded-For": ip };
      }
    };

    for (let i = 0; i < LIMIT; i++) {
      expect((await capture(app, unattested(i))).status).toBe(200);
    }
    const refused = await capture(app, unattested(LIMIT));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });

    // An attested caller keeps its own bucket.
    const ok = await capture(app, attested("203.0.113.9"));
    expect(ok.status).toBe(200);
  });
});
