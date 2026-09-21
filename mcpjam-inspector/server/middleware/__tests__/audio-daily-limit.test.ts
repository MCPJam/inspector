import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The per-IP daily ceiling on guest voice transcription (MJ-002).
 *
 * The properties worth pinning are the ones a careless edit would quietly
 * break: the ATTESTED address is the key (that being the whole point — a guest
 * identity is free to re-roll, and a claimed address is free to spoof), a
 * signed-in caller is not charged, it is a no-op locally, and the map cannot be
 * grown by a caller — it fails closed, so a fillable map would be an outage.
 */

const HOSTED_ENV = "VITE_MCPJAM_HOSTED_MODE";
const LIMIT_ENV = "MCPJAM_AUDIO_DAILY_IP_LIMIT";
let savedHosted: string | undefined;
let savedLimit: string | undefined;

beforeEach(() => {
  savedHosted = process.env[HOSTED_ENV];
  savedLimit = process.env[LIMIT_ENV];
});

afterEach(() => {
  if (savedHosted === undefined) delete process.env[HOSTED_ENV];
  else process.env[HOSTED_ENV] = savedHosted;
  if (savedLimit === undefined) delete process.env[LIMIT_ENV];
  else process.env[LIMIT_ENV] = savedLimit;
  vi.resetModules();
});

/**
 * `HOSTED_MODE` and the ceiling are read at import, so each configuration
 * needs a fresh registry.
 */
async function appFor(options: { hosted: boolean; limit?: number }) {
  process.env[HOSTED_ENV] = options.hosted ? "true" : "false";
  if (options.limit === undefined) delete process.env[LIMIT_ENV];
  else process.env[LIMIT_ENV] = String(options.limit);
  vi.resetModules();

  const { audioDailyLimitMiddleware } = await import("../audio-daily-limit");
  const app = new Hono();
  // Stands in for `bearerAuthMiddleware`, which sets `guestId` for a validated
  // guest token and leaves it unset for everyone else.
  app.use("*", async (c, next) => {
    const guestId = c.req.header("x-test-guest-id");
    if (guestId) c.set("guestId", guestId);
    await next();
  });
  app.use("*", audioDailyLimitMiddleware);
  app.post("/transcriptions", (c) => c.json({ ok: true }));
  return app;
}

const hit = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/transcriptions", { method: "POST", headers });

const asGuest = (ip: string, guestId = "guest-1") => ({
  "cf-connecting-ip": ip,
  "x-test-guest-id": guestId,
});

describe("audioDailyLimitMiddleware", () => {
  it("allows the budget and then 429s, per address", async () => {
    const app = await appFor({ hosted: true, limit: 3 });

    for (let i = 0; i < 3; i++) {
      expect((await hit(app, asGuest("203.0.113.5"))).status).toBe(200);
    }

    const blocked = await hit(app, asGuest("203.0.113.5"));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("RATE_LIMITED");
    // A fixed window, so the reset is stateable — and the published spec
    // promises `Retry-After` on every rate-limited response.
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("keys on the address, not the guest identity", async () => {
    // The reason this middleware exists. `POST /api/web/guest-session` hands
    // out identities 10 times a minute per IP, so a per-identity budget alone
    // is reset by anyone willing to make one extra request.
    const app = await appFor({ hosted: true, limit: 3 });

    for (let i = 0; i < 3; i++) {
      expect(
        (await hit(app, asGuest("203.0.113.5", `guest-${i}`))).status
      ).toBe(200);
    }

    const blocked = await hit(app, asGuest("203.0.113.5", "guest-brand-new"));
    expect(blocked.status).toBe(429);
  });

  it("gives each address its own budget", async () => {
    const app = await appFor({ hosted: true, limit: 3 });

    for (let i = 0; i < 3; i++) {
      await hit(app, asGuest("203.0.113.5"));
    }
    expect((await hit(app, asGuest("203.0.113.5"))).status).toBe(429);
    // A neighbour is untouched by the first address's exhausted window.
    expect((await hit(app, asGuest("203.0.113.6"))).status).toBe(200);
  });

  it("does not charge a signed-in caller", async () => {
    // No `guestId`: bounded by their organization's own daily entitlement,
    // which is shared state and cannot be multiplied by minting anything.
    // Charging them here would penalize a team behind one office NAT.
    const app = await appFor({ hosted: true, limit: 3 });

    for (let i = 0; i < 10; i++) {
      expect((await hit(app, { "cf-connecting-ip": "203.0.113.5" })).status).toBe(200);
    }
  });

  it("is a no-op outside hosted mode", async () => {
    const app = await appFor({ hosted: false, limit: 3 });

    for (let i = 0; i < 10; i++) {
      expect((await hit(app, asGuest("203.0.113.5"))).status).toBe(200);
    }
  });

  it("pools un-attestable callers into one shared window with a larger budget", async () => {
    // No attestable address: these share a single window rather than each
    // getting their own, because the alternative is keying on a value the
    // caller writes. Pooled rather than skipped, so stripping a header is not
    // a way out of the ceiling.
    const app = await appFor({ hosted: true, limit: 3 });

    // 4x the per-address limit, since the pool covers many callers.
    for (let i = 0; i < 12; i++) {
      expect((await hit(app, { "x-test-guest-id": `guest-${i}` })).status).toBe(
        200
      );
    }

    const blocked = await hit(app, { "x-test-guest-id": "guest-last" });
    expect(blocked.status).toBe(429);
  });

  it("does not let a caller-written address header mint its own bucket", async () => {
    // `x-real-ip` and `x-forwarded-for` are spoofable with no trusted proxy in
    // front, so keying on them would make this limiter a memory-exhaustion
    // primitive: churn the header, fill the map, and — because the map fails
    // closed at its bound — every guest afterwards is refused. Rotating a
    // claimed address must therefore land in the shared pool, not in 12
    // separate windows.
    const app = await appFor({ hosted: true, limit: 3 });
    const { audioDailyLimitWindowCountForTests } = await import(
      "../audio-daily-limit"
    );

    for (let i = 0; i < 12; i++) {
      await hit(app, {
        "x-real-ip": `203.0.113.${i}`,
        "x-test-guest-id": `guest-${i}`,
      });
    }

    expect(audioDailyLimitWindowCountForTests()).toBe(1);
    const blocked = await hit(app, {
      "x-real-ip": "203.0.113.200",
      "x-test-guest-id": "guest-last",
    });
    expect(blocked.status).toBe(429);
  });

  it("honours the address header an operator vouches for", async () => {
    // A deployment that terminates somewhere other than Cloudflare names its
    // ingress header, and that value IS attestable.
    const previous = process.env.MCPJAM_TRUSTED_CLIENT_IP_HEADER;
    process.env.MCPJAM_TRUSTED_CLIENT_IP_HEADER = "x-operator-ip";
    try {
      const app = await appFor({ hosted: true, limit: 3 });

      for (let i = 0; i < 3; i++) {
        await hit(app, {
          "x-operator-ip": "203.0.113.5",
          "x-test-guest-id": "guest-1",
        });
      }

      expect(
        (
          await hit(app, {
            "x-operator-ip": "203.0.113.5",
            "x-test-guest-id": "guest-1",
          })
        ).status
      ).toBe(429);
      // Its own window, not the pool: a neighbour is unaffected.
      expect(
        (
          await hit(app, {
            "x-operator-ip": "203.0.113.6",
            "x-test-guest-id": "guest-1",
          })
        ).status
      ).toBe(200);
    } finally {
      if (previous === undefined) {
        delete process.env.MCPJAM_TRUSTED_CLIENT_IP_HEADER;
      } else {
        process.env.MCPJAM_TRUSTED_CLIENT_IP_HEADER = previous;
      }
    }
  });

  it("ignores a malformed limit rather than admitting everything", async () => {
    process.env[HOSTED_ENV] = "true";
    process.env[LIMIT_ENV] = "not-a-number";
    vi.resetModules();

    const { AUDIO_DAILY_IP_LIMIT } = await import("../audio-daily-limit");
    expect(AUDIO_DAILY_IP_LIMIT).toBe(200);
  });

  it("bounds the window map against address churn WITHOUT resetting live buckets", async () => {
    const app = await appFor({ hosted: true, limit: 3 });
    const {
      audioDailyLimitWindowCountForTests,
      AUDIO_DAILY_WINDOW_MAX_ENTRIES,
    } = await import("../audio-daily-limit");

    // Exhaust one address first, then fill the map from other addresses. The
    // exhausted bucket must still be exhausted afterwards: evicting to make
    // room would hand a churner a way to reset their own ceiling.
    for (let i = 0; i < 3; i++) {
      await hit(app, asGuest("203.0.113.5"));
    }
    expect((await hit(app, asGuest("203.0.113.5"))).status).toBe(429);

    // Addresses spread across two octets so they are real IPv4 values.
    for (let i = 0; i < AUDIO_DAILY_WINDOW_MAX_ENTRIES + 50; i++) {
      const octet = Math.floor(i / 250);
      const host = i % 250;
      await hit(app, asGuest(`198.51.${octet}.${host}`, `guest-${i}`));
    }

    expect(audioDailyLimitWindowCountForTests()).toBeLessThanOrEqual(
      AUDIO_DAILY_WINDOW_MAX_ENTRIES
    );
    // The exhausted window survives the churn: no eviction, so filling the map
    // is not a way to clear your own ceiling.
    expect((await hit(app, asGuest("203.0.113.5"))).status).toBe(429);
  });

  it("admits an unmetered caller at a full map rather than refusing everyone", async () => {
    // The window is a DAY, so a full map stays full for a day. Refusing new
    // callers would let anyone holding 10k addresses deny guest voice to every
    // other guest on the replica — trading a cost problem the backend already
    // bounds for an availability problem nothing bounds.
    const app = await appFor({ hosted: true, limit: 3 });
    const { AUDIO_DAILY_WINDOW_MAX_ENTRIES } = await import(
      "../audio-daily-limit"
    );

    for (let i = 0; i < AUDIO_DAILY_WINDOW_MAX_ENTRIES + 50; i++) {
      const octet = Math.floor(i / 250);
      const host = i % 250;
      await hit(app, asGuest(`198.51.${octet}.${host}`, `guest-${i}`));
    }

    // More than `limit` times, deliberately. One 200 would prove nothing — a
    // fresh window would also return 200 for its first three. Only an
    // UNMETERED caller keeps passing past the limit; a regression to
    // refusing-at-full-map fails on the first, and a regression to metering
    // fails on the fourth.
    for (let i = 0; i < 6; i++) {
      expect((await hit(app, asGuest("203.0.113.99"))).status).toBe(200);
    }
  });
});
