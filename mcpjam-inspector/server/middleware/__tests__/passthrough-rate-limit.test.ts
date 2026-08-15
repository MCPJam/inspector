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

  it("IS NOT SPENT BY A REQUEST THE TOKEN BUCKET ALREADY REFUSED", async () => {
    // The order of the two charges is a security property, not a style choice.
    //
    // Charge the IP first and the limiter becomes a weapon: a caller that has
    // exhausted its own token budget goes on spending the SHARED IP window with
    // every rejected request, at no cost to itself, until everyone else behind
    // that NAT, office or carrier is refused too. Denial of service delivered
    // by the thing meant to prevent it.
    //
    // So: drain one token's budget, then send far more than the IP window holds
    // — every one of them refused at the token bucket — and prove an innocent
    // caller on the same address is still served afterwards.
    const a = app();
    const shared = "198.51.100.42";

    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT; i++) {
      expect((await a.request("/x", req("tok-greedy", shared))).status).toBe(
        200
      );
    }

    for (let i = 0; i < PASSTHROUGH_IP_LIMIT + 50; i++) {
      expect((await a.request("/x", req("tok-greedy", shared))).status).toBe(
        429
      );
    }

    // The neighbour: a different token, the same address.
    expect((await a.request("/x", req("tok-neighbour", shared))).status).toBe(
      200
    );
  }, 30_000);

  it("A BLANK BEARER DOES NOT BUY THE SHARED IP BUDGET CHEAPLY", async () => {
    // The same weapon as the test above, reached from the other side. A token
    // that is only whitespace still reaches this branch — `Bearer ` with a
    // trailing space is normalized away by the HTTP layer and 401s upstream,
    // but a non-breaking space survives transport, satisfies the `Bearer `
    // prefix check, and trims to nothing here. Treating that as "no token"
    // handed the caller the whole per-IP window to spend while risking no
    // budget of its own. Blank credentials now share one token bucket, which
    // is the tighter of the two and bites first.
    const a = app();
    const shared = "198.51.100.44";
    const blank = {
      headers: { "x-real-ip": shared, authorization: "Bearer \u00a0" },
    };

    let refused = 0;
    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT + 5; i++) {
      if ((await a.request("/x", blank)).status === 429) refused++;
    }
    // Refused by the TOKEN bucket, well before the looser IP window could be.
    expect(refused).toBeGreaterThan(0);

    // And the neighbour behind the same address is untouched.
    expect((await a.request("/x", req("tok-neighbour", shared))).status).toBe(
      200
    );
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

  it("ONE HOST CANNOT FILL THE TOKEN MAP AND LOCK OUT EVERYONE ELSE", async () => {
    // The attack the two-map design invites if insertion is not gated.
    //
    // Minting a bearer costs nothing, so a single host can name 10k of them.
    // If each request inserted its token entry BEFORE the IP backstop was
    // consulted, those requests would be refused one by one and still fill the
    // map on the way past — and a full map that refuses unknown keys then
    // denies every legitimate caller whose token is not already resident.
    // 10k requests every few minutes would hold the hosted API down.
    //
    // So a first-seen token only takes an entry once the IP window has
    // admitted the request: the fill rate is bounded by the backstop, and this
    // host runs out of IP budget long before it runs out of names.
    const a = app();
    const attacker = "198.51.100.60";
    for (let i = 0; i < PASSTHROUGH_MAX_ENTRIES; i++) {
      await a.request("/x", req(`churn-${i}`, attacker));
    }

    // An unrelated caller, from its own address, is unaffected.
    expect(
      (await a.request("/x", req("tok-brand-new", "198.51.100.61"))).status
    ).toBe(200);
  }, 30_000);

  it("still refuses the attacker itself, on the backstop", async () => {
    // The other half: bounding the FILL must not stop the flood being braked.
    const a = app();
    const attacker = "198.51.100.70";
    for (let i = 0; i < PASSTHROUGH_IP_LIMIT; i++) {
      await a.request("/x", req(`rot-${i}`, attacker));
    }
    expect((await a.request("/x", req("rot-next", attacker))).status).toBe(429);
  }, 30_000);

  it("degrades a FULL token map to IP-only metering rather than refusing", async () => {
    // Filling the token map legitimately takes many hosts, and at that point
    // the map being full is our resource problem, not the caller's. There is a
    // real backstop underneath it, so an unclassifiable request is metered by
    // IP instead of being refused — the opposite choice from the IP map, which
    // has nothing beneath it and does fail closed.
    const a = app();
    // ~20 addresses, each staying under its own IP budget, so the token map
    // fills while the IP map holds a couple of dozen entries — otherwise the
    // IP map would hit its own cap first and refuse for the wrong reason.
    const perIp = Math.floor(PASSTHROUGH_IP_LIMIT * 0.8);
    for (let i = 0; i < PASSTHROUGH_MAX_ENTRIES; i++) {
      await a.request("/x", req(`tok-${i}`, `10.0.0.${Math.floor(i / perIp)}`));
    }

    expect(
      (await a.request("/x", req("tok-overflow", "192.0.2.99"))).status
    ).toBe(200);
  }, 60_000);
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
