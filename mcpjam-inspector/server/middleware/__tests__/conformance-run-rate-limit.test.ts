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

  it("bounds the window map against address churn WITHOUT resetting live buckets", async () => {
    const app = await appFor(true);
    const {
      conformanceRunRateLimitWindowCountForTests,
      CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES,
    } = await import("../conformance-run-rate-limit");

    // Addresses spread across two octets so they are real IPv4 values rather
    // than `198.51.100.900`.
    const ipAt = (i: number) =>
      `198.51.${Math.floor(i / 256) % 256}.${i % 256}`;

    for (let i = 0; i < CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES; i++) {
      expect((await hit(app, { "x-real-ip": ipAt(i) })).status).toBe(200);
    }

    // Past the cap the limiter FAILS CLOSED. The tempting alternative —
    // evicting the oldest entry — would bound memory while handing that
    // address a brand-new allowance, so a churner could reset their own
    // exhausted bucket just by filling the map. Refusing the new key keeps
    // both the memory bound and the enforcement.
    expect(
      (
        await hit(app, {
          "x-real-ip": ipAt(CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES),
        })
      ).status
    ).toBe(429);

    expect(conformanceRunRateLimitWindowCountForTests()).toBeLessThanOrEqual(
      CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES
    );
  });

  it("keeps serving an address that already has a window when the map is full", async () => {
    // Fail-closed must not lock out callers who are already tracked and well
    // inside their budget — only NEW keys are refused.
    const app = await appFor(true);
    const { CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES } = await import(
      "../conformance-run-rate-limit"
    );
    const known = { "x-real-ip": "203.0.113.42" };
    expect((await hit(app, known)).status).toBe(200);

    for (let i = 1; i < CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES; i++) {
      await hit(app, {
        "x-real-ip": `198.51.${Math.floor(i / 256) % 256}.${i % 256}`,
      });
    }

    expect((await hit(app, known)).status).toBe(200);
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
