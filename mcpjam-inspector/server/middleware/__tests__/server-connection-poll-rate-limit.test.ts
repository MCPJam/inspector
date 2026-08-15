/**
 * The budget that lets a client poll without being punished for it.
 *
 * Two keys, because one cannot answer both questions. Charged only to the
 * identity, a guest mints a fresh id and gets a fresh window, so the ceiling
 * means nothing. Charged only to the address, an office behind one NAT shares a
 * bucket and twenty colleagues watching their own connections lock each other
 * out. Both are charged: the identity bucket is the one a normal caller meets,
 * and the address bucket sits far above it to bound the rotation the identity
 * bucket cannot see.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  hasDedicatedPollBudget,
  resetServerConnectionPollRateLimitForTests,
  serverConnectionPollRateLimitMiddleware,
  SERVER_CONNECTION_POLL_RATE_LIMIT,
  SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT,
} from "../server-connection-poll-rate-limit.js";

/** `principal` mimics whatever upstream auth established, when anything did. */
function appFor(principal?: { key: "guestId" | "mcpjamUserId"; value: string }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (principal) c.set(principal.key, principal.value);
    await next();
  });
  app.use("*", serverConnectionPollRateLimitMiddleware);
  app.get("/poll", (c) => c.json({ ok: true }));
  return app;
}

const poll = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/poll", { headers });

beforeEach(() => resetServerConnectionPollRateLimitForTests());
afterEach(() => resetServerConnectionPollRateLimitForTests());

describe("the identity budget", () => {
  it("bounds one caller and then refuses", async () => {
    const app = appFor({ key: "guestId", value: "guest_1" });
    const ip = { "x-real-ip": "203.0.113.20" };

    for (let i = 0; i < SERVER_CONNECTION_POLL_RATE_LIMIT; i += 1) {
      expect((await poll(app, ip)).status).toBe(200);
    }
    const refused = await poll(app, ip);
    expect(refused.status).toBe(429);
  });

  it("advertises how long the window actually holds", async () => {
    const app = appFor({ key: "guestId", value: "guest_1" });
    for (let i = 0; i < SERVER_CONNECTION_POLL_RATE_LIMIT; i += 1) {
      await poll(app);
    }

    const refused = await poll(app);
    const retryAfter = Number(refused.headers.get("retry-after"));

    // A fixed "5" would train a client to hammer a door that stays shut for
    // another fifty seconds.
    expect(retryAfter).toBeGreaterThan(5);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("the address budget", () => {
  it("bounds a guest who mints a new identity for every request", async () => {
    const ip = { "x-real-ip": "203.0.113.21" };

    // Each request arrives as a different guest, so the identity bucket never
    // fills. The address bucket is what stops it.
    let refusedAt = -1;
    for (let i = 0; i < SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT + 5; i += 1) {
      const app = appFor({ key: "guestId", value: `guest_${i}` });
      const res = await poll(app, ip);
      if (res.status === 429) {
        refusedAt = i;
        break;
      }
    }

    expect(refusedAt).toBe(SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT);
  });

  it("leaves room for a whole office on one address", async () => {
    // Twenty colleagues at the fastest sane interval is ~600/min. The ceiling
    // has to sit above that or a shared NAT becomes a shared outage.
    expect(SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT).toBeGreaterThan(600);
  });

  it("gives each address its own", async () => {
    const app = appFor();
    for (let i = 0; i < SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT; i += 1) {
      await poll(app, { "x-real-ip": "203.0.113.22" });
    }

    expect((await poll(app, { "x-real-ip": "203.0.113.22" })).status).toBe(429);
    expect((await poll(app, { "x-real-ip": "198.51.100.9" })).status).toBe(200);
  });
});

describe("callers we cannot place", () => {
  it("passes through rather than sharing one bucket", async () => {
    // Collapsing every unplaceable caller into one key would let a single
    // header-stripped request starve the rest.
    const app = appFor();
    for (let i = 0; i < SERVER_CONNECTION_POLL_RATE_LIMIT + 10; i += 1) {
      expect((await poll(app)).status).toBe(200);
    }
  });
});

describe("the exemption and the budget agree", () => {
  it("claims exactly the status path", () => {
    expect(
      hasDedicatedPollBudget("GET", "/api/v1/server-connections/scr_1")
    ).toBe(true);
    // A path the shared guest limiter still owns must not also be exempted, or
    // it would be metered by nobody.
    expect(hasDedicatedPollBudget("POST", "/api/v1/server-connections")).toBe(
      false
    );
    expect(
      hasDedicatedPollBudget("POST", "/api/v1/server-connections/scr_1/cancel")
    ).toBe(false);
    expect(hasDedicatedPollBudget("GET", "/api/v1/projects")).toBe(false);
  });
});
