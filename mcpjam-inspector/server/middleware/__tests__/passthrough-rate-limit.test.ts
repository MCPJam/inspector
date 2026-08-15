/**
 * The spike brake on the last unmetered credential class.
 *
 * `bearerAuthMiddleware` has three branches and only two of them cost
 * anything to hold: an `sk_` key is validated against WorkOS and metered per
 * key id, a guest token is validated and metered per guest id. The third — an
 * AuthKit JWT — is deliberately NOT verified at the gateway (every route it
 * fronts forwards the bearer to Convex, which verifies it against JWKS, and
 * verifying twice would add a round trip to reach the same answer). Sound
 * reasoning, and it left that branch reaching the handlers with no budget
 * attached to it at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../../config.js", () => ({ HOSTED_MODE: true }));

const {
  PASSTHROUGH_IP_LIMIT,
  PASSTHROUGH_MAX_ENTRIES,
  PASSTHROUGH_TOKEN_LIMIT,
  passthroughRateLimitMiddleware,
  resetPassthroughRateLimitForTests,
} = await import("../passthrough-rate-limit.js");

/**
 * `authMethod` is set by `bearerAuthMiddleware` upstream; the tests set it
 * directly so this file pins the LIMITER rather than re-testing bearer
 * classification.
 */
type AuthMethod = "unverified_passthrough" | "workos_api_key" | "guest";

function app(authMethod: AuthMethod = "unverified_passthrough") {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("authMethod", authMethod);
    await next();
  });
  a.use("*", passthroughRateLimitMiddleware);
  a.get("/x", (c) => c.json({ ok: true }));
  return a;
}

const req = (token?: string, ip = "203.0.113.1") => ({
  headers: {
    "x-real-ip": ip,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});

beforeEach(() => resetPassthroughRateLimitForTests());

describe("what it meters", () => {
  it("leaves the sk_ and guest branches alone", async () => {
    // Both already carry their own budgets. Metering them here would charge
    // the same request twice and make each surface's real ceiling the product
    // of two numbers nobody wrote down together.
    for (const method of ["workos_api_key", "guest"] as const) {
      const a = app(method);
      for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT + 5; i++) {
        const res = await a.request("/x", req(`tok-${method}`));
        expect(res.status).toBe(200);
      }
    }
  });

  it("refuses a passthrough burst with 429 + Retry-After", async () => {
    const a = app();
    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT; i++) {
      expect((await a.request("/x", req("tok-a"))).status).toBe(200);
    }

    const res = await a.request("/x", req("tok-a"));

    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("RATE_LIMITED");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("keys per token, so one caller cannot exhaust another's budget", async () => {
    const a = app();
    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT; i++) {
      await a.request("/x", req("tok-noisy"));
    }

    expect((await a.request("/x", req("tok-noisy"))).status).toBe(429);
    expect(
      (await a.request("/x", req("tok-quiet", "203.0.113.2"))).status
    ).toBe(200);
  });
});

describe("the per-IP backstop", () => {
  it("CATCHES A TOKEN-ROTATING CALLER", async () => {
    // The reason there are two keys. A bearer costs nothing to change, so a
    // per-token bucket alone brakes an honest client and nothing else — an
    // attacker takes a fresh token per request and gets a fresh budget with
    // it. These requests each carry a NEW token and still converge on the IP.
    const a = app();
    let refused = 0;
    for (let i = 0; i < PASSTHROUGH_IP_LIMIT + 5; i++) {
      const res = await a.request("/x", req(`rotating-${i}`, "198.51.100.7"));
      if (res.status === 429) refused++;
    }

    expect(refused).toBeGreaterThan(0);
  });

  it("meters a request with NO bearer at all", async () => {
    // Otherwise the cheapest way past the limiter is to send no credential —
    // and this branch is reached precisely by requests whose credential
    // nothing here has checked.
    const a = app();
    let refused = 0;
    for (let i = 0; i < PASSTHROUGH_IP_LIMIT + 5; i++) {
      const res = await a.request("/x", {
        headers: { "x-real-ip": "198.51.100.8" },
      });
      if (res.status === 429) refused++;
    }

    expect(refused).toBeGreaterThan(0);
  });

  it("is looser than the per-token budget, because an IP is not a caller", async () => {
    // Offices, VPNs and mobile carriers put many real users behind one
    // address. Sized at the token limit it would refuse a floor of ordinary
    // people rather than a loop.
    expect(PASSTHROUGH_IP_LIMIT).toBeGreaterThan(PASSTHROUGH_TOKEN_LIMIT);
  });

  it("does not collapse header-stripped callers into one shared bucket", async () => {
    // No attributable IP means no bucket to charge. Falling through matches
    // the other limiters' posture; the alternative is one shared bucket where
    // a single header-stripped request starves everyone else behind it.
    const a = app();
    for (let i = 0; i < PASSTHROUGH_IP_LIMIT + 5; i++) {
      const res = await a.request("/x", { headers: {} });
      expect(res.status).toBe(200);
    }
  });
});

describe("bounded, and fails closed when full", () => {
  it("refuses NEW keys at the cap while still serving existing ones", async () => {
    // Both keys are attacker-controlled, so sustained churn would otherwise
    // grow the maps until the replica died — long before any single bucket hit
    // its limit. Evicting the oldest instead (an LRU) would hand a churner a
    // way to reset their own exhausted bucket.
    const a = app();
    const established = "198.51.100.9";
    expect(
      (await a.request("/x", req("tok-established", established))).status
    ).toBe(200);

    // Fill the IP map to its cap from distinct addresses.
    for (let i = 0; i < PASSTHROUGH_MAX_ENTRIES; i++) {
      await a.request("/x", {
        headers: {
          "x-real-ip": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        },
      });
    }

    // A brand-new address is refused…
    const fresh = await a.request("/x", {
      headers: { "x-real-ip": "192.0.2.250" },
    });
    expect(fresh.status).toBe(429);

    // …while the address already in the map keeps being served.
    expect(
      (await a.request("/x", req("tok-established", established))).status
    ).toBe(200);
  }, 30_000);
});

describe("local mode", () => {
  it("is exempt — one user, and it is the person who started the process", async () => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ HOSTED_MODE: false }));
    const local = await import("../passthrough-rate-limit.js");

    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("authMethod", "unverified_passthrough");
      await next();
    });
    a.use("*", local.passthroughRateLimitMiddleware);
    a.get("/x", (c) => c.json({ ok: true }));

    for (let i = 0; i < local.PASSTHROUGH_TOKEN_LIMIT + 5; i++) {
      expect((await a.request("/x", req("tok-local"))).status).toBe(200);
    }
    vi.doUnmock("../../config.js");
  });
});
