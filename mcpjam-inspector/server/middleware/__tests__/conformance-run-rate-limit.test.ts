import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The per-IP ceiling on hosted conformance runs.
 *
 * The properties worth pinning are the ones a careless edit would quietly
 * break: it must be a no-op locally (a laptop dialing its own server is the
 * product), each address must get its own budget, and the map must not grow
 * without bound — a limiter that can be turned into the attack is not one.
 */

const HOSTED_ENV = "VITE_MCPJAM_HOSTED_MODE";
let savedHosted: string | undefined;

beforeEach(() => {
  savedHosted = process.env[HOSTED_ENV];
});

afterEach(() => {
  if (savedHosted === undefined) delete process.env[HOSTED_ENV];
  else process.env[HOSTED_ENV] = savedHosted;
  vi.resetModules();
});

/** `HOSTED_MODE` is read at config import, so each mode needs a fresh registry. */
async function appFor(hosted: boolean) {
  process.env[HOSTED_ENV] = hosted ? "true" : "false";
  vi.resetModules();
  const { conformanceRunRateLimitMiddleware } = await import(
    "../conformance-run-rate-limit"
  );
  const app = new Hono();
  app.use("*", conformanceRunRateLimitMiddleware);
  app.get("/run", (c) => c.json({ ok: true }));
  return app;
}

const hit = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/run", { headers });

describe("conformanceRunRateLimitMiddleware", () => {
  it("allows the budget and then 429s, per address", async () => {
    const app = await appFor(true);
    const ip = { "x-real-ip": "203.0.113.5" };

    for (let i = 0; i < 30; i++) {
      expect((await hit(app, ip)).status).toBe(200);
    }
    const blocked = await hit(app, ip);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("RATE_LIMITED");
  });

  it("gives each address its own budget", async () => {
    const app = await appFor(true);
    for (let i = 0; i < 30; i++) {
      await hit(app, { "x-real-ip": "203.0.113.5" });
    }
    expect((await hit(app, { "x-real-ip": "203.0.113.5" })).status).toBe(429);
    // A neighbour is untouched by the first address's exhausted window.
    expect((await hit(app, { "x-real-ip": "203.0.113.6" })).status).toBe(200);
  });

  it("is a no-op outside hosted mode", async () => {
    const app = await appFor(false);
    const ip = { "x-real-ip": "203.0.113.5" };
    for (let i = 0; i < 50; i++) {
      expect((await hit(app, ip)).status).toBe(200);
    }
  });

  it("does not collapse un-attributable callers into one shared bucket", async () => {
    // No forwarding header and no socket peer: charging these to a single
    // "unknown" key would let one such request starve every other.
    const app = await appFor(true);
    for (let i = 0; i < 50; i++) {
      expect((await hit(app)).status).toBe(200);
    }
  });

  it("bounds the window map against address churn", async () => {
    const app = await appFor(true);
    // Far more distinct addresses than the cap; every one must still be
    // served, and memory must not track the churn one-for-one.
    for (let i = 0; i < 2000; i++) {
      expect((await hit(app, { "x-real-ip": `198.51.100.${i}` })).status).toBe(
        200
      );
    }
  });

  it("exposes a reset seam so suites cannot leak windows into each other", async () => {
    const app = await appFor(true);
    const { resetConformanceRunRateLimitForTests } = await import(
      "../conformance-run-rate-limit"
    );
    const ip = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < 30; i++) await hit(app, ip);
    expect((await hit(app, ip)).status).toBe(429);

    resetConformanceRunRateLimitForTests();
    expect((await hit(app, ip)).status).toBe(200);
  });
});
