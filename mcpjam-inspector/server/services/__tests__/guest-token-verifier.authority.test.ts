import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { exportJWK, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGuestJwksCacheForTests,
  validateGuestTokenDetailedAsync,
} from "../guest-token-verifier.js";
import { resetGuestAuthorityForTests } from "../../utils/guest-authority.js";

/**
 * Guest bearers are verified against the SELECTED authority's JWKS, matched
 * strictly by `kid`. These pin what a signing-key rotation relies on: the new
 * key is picked up on the first token that names it, and tokens signed by the
 * retired key stop verifying — whether they keep the old `kid` or not.
 */

const BACKEND = "https://dev-backend.convex.site";
const JWKS_URL = `${BACKEND}/guest/jwks`;
const ISSUER = "https://api.mcpjam.com/guest";

function rsa(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

async function jwkFor(key: KeyObject, kid?: string): Promise<JWK> {
  const jwk = await exportJWK(key);
  return kid ? { ...jwk, kid, alg: "RS256", use: "sig" } : jwk;
}

async function token(
  key: KeyObject,
  kid: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ iss: ISSUER, sub: "guest-1", ...claims })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

describe("guest bearer verification against the selected authority", () => {
  const originalFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};
  let published: JWK[] = [];

  beforeEach(() => {
    for (const key of [
      "MCPJAM_GUEST_AUTHORITY",
      "CONVEX_HTTP_URL",
      "MCPJAM_GUEST_SESSION_SHARED_SECRET",
    ]) {
      saved[key] = process.env[key];
    }
    process.env.MCPJAM_GUEST_AUTHORITY = "backend";
    process.env.CONVEX_HTTP_URL = BACKEND;
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = "s";
    resetGuestAuthorityForTests();
    resetGuestJwksCacheForTests();
    published = [];
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== JWKS_URL) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ keys: published }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetGuestAuthorityForTests();
    resetGuestJwksCacheForTests();
    global.fetch = originalFetch;
  });

  it("accepts a token whose kid the authority publishes", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const result = await validateGuestTokenDetailedAsync(
      await token(current.privateKey, "guest-2"),
    );
    expect(result).toEqual({ valid: true, guestId: "guest-1" });
  });

  it("picks up a rotated key on the first token naming it (cache refresh)", async () => {
    const retired = rsa();
    const next = rsa();
    published = [await jwkFor(retired.publicKey, "guest-1")];
    expect(
      (
        await validateGuestTokenDetailedAsync(
          await token(retired.privateKey, "guest-1"),
        )
      ).valid,
    ).toBe(true);

    // Operator rotates: new key, new kid; the retired key is withdrawn.
    published = [await jwkFor(next.publicKey, "guest-2")];
    expect(
      (
        await validateGuestTokenDetailedAsync(
          await token(next.privateKey, "guest-2"),
        )
      ).valid,
    ).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects tokens signed by the retired key after rotation, guest and delegated alike", async () => {
    const retired = rsa();
    const next = rsa();
    published = [await jwkFor(next.publicKey, "guest-2")];

    const retiredGuest = await token(retired.privateKey, "guest-1");
    const retiredDelegated = await token(retired.privateKey, "guest-1", {
      iss: "https://api.mcpjam.com/delegated",
    });
    const retiredReusingKid = await token(retired.privateKey, "guest-2");

    expect((await validateGuestTokenDetailedAsync(retiredGuest)).valid).toBe(
      false,
    );
    expect(
      (await validateGuestTokenDetailedAsync(retiredDelegated)).valid,
    ).toBe(false);
    const reused = await validateGuestTokenDetailedAsync(retiredReusingKid);
    expect(reused).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("throttles refreshes forced by unknown kids", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    await validateGuestTokenDetailedAsync(
      await token(current.privateKey, "guest-2"),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const stranger = rsa();
    for (let i = 0; i < 5; i += 1) {
      const result = await validateGuestTokenDetailedAsync(
        await token(stranger.privateKey, `junk-${i}`),
      );
      expect(result.valid).toBe(false);
    }
    // One forced refresh at most inside the throttle window.
    expect(vi.mocked(global.fetch).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("does not spend the unknown-kid throttle while a failed refresh is backing off", async () => {
    const current = rsa();
    const next = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const start = Date.now();
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
    await validateGuestTokenDetailedAsync(
      await token(current.privateKey, "guest-2"),
    );
    const nextBearer = await token(next.privateKey, "guest-3");

    // A slow failing refresh: the backoff runs from when it finished.
    const servedFetch = global.fetch;
    let fail: () => void = () => {};
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail = () => reject(new TypeError("fetch failed"));
        }),
    ) as typeof fetch;
    vi.setSystemTime(start + 1_000);
    const pending = validateGuestTokenDetailedAsync(nextBearer);
    vi.setSystemTime(start + 11_000);
    fail();
    expect((await pending).valid).toBe(false);

    // Throttle window over, backoff not: nothing is fetched.
    global.fetch = servedFetch;
    vi.mocked(global.fetch).mockClear();
    vi.setSystemTime(start + 32_000);
    expect((await validateGuestTokenDetailedAsync(nextBearer)).valid).toBe(
      false,
    );
    expect(global.fetch).not.toHaveBeenCalled();

    // Backoff over: the rotated key is picked up on the next token naming it.
    published = [await jwkFor(next.publicKey, "guest-3")];
    vi.setSystemTime(start + 42_000);
    expect((await validateGuestTokenDetailedAsync(nextBearer)).valid).toBe(
      true,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous key set when the authority publishes no usable keys", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const bearer = await token(current.privateKey, "guest-2");
    const start = Date.now();
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);

    published = [];
    vi.setSystemTime(start + 6 * 60 * 1000);
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // An empty set is a failed refresh: it backs off like one.
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one JWKS fetch among concurrent verifications, succeeding or failing", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const bearer = await token(current.privateKey, "guest-2");
    const servedFetch = global.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      await gate;
      return servedFetch(...args);
    }) as typeof fetch;

    const burst = Array.from({ length: 5 }, () =>
      validateGuestTokenDetailedAsync(bearer),
    );
    release();
    for (const result of await Promise.all(burst)) {
      expect(result.valid).toBe(true);
    }
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Authority down once the set expires: the burst waits on ONE failing
    // fetch, still served by the cached set, and the backoff covers it all.
    const start = Date.now();
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
    vi.setSystemTime(start + 6 * 60 * 1000);
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const outage = await Promise.all(
      Array.from({ length: 5 }, () => validateGuestTokenDetailedAsync(bearer)),
    );
    for (const result of outage) expect(result.valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("never uses a published key that carries no kid, and refuses kid-less tokens", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey)];
    const withKid = await token(current.privateKey, "guest-2");
    expect((await validateGuestTokenDetailedAsync(withKid)).valid).toBe(false);

    const kidless = await new SignJWT({ iss: ISSUER, sub: "guest-1" })
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime("1h")
      .sign(current.privateKey);
    expect((await validateGuestTokenDetailedAsync(kidless)).valid).toBe(false);
  });

  it("stops trusting a stale key set once the authority has been unreachable too long", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const bearer = await token(current.privateKey, "guest-2");
    const start = Date.now();
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);

    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    // Past the routine refresh: the refresh fails, the cached set still serves.
    vi.setSystemTime(start + 6 * 60 * 1000);
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);
    // A failed refresh is not retried on every request.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Past the stale bound: nothing verifies until the JWKS is reachable.
    vi.setSystemTime(start + 61 * 60 * 1000);
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(false);
  });

  it("refuses a promotion proof presented as a session bearer", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const proof = await token(current.privateKey, "guest-2", {
      purpose: "guest-promotion",
    });
    expect(await validateGuestTokenDetailedAsync(proof)).toMatchObject({
      valid: false,
      reason: "not_a_session_bearer",
    });
  });

  it("does not reuse one authority's keys for another", async () => {
    const current = rsa();
    published = [await jwkFor(current.publicKey, "guest-2")];
    const bearer = await token(current.privateKey, "guest-2");
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(true);

    // Same process, different authority (a test changing configuration): the
    // cached key set belongs to the old JWKS URL and must not be consulted.
    process.env.CONVEX_HTTP_URL = "https://other-backend.convex.site";
    resetGuestAuthorityForTests();
    expect((await validateGuestTokenDetailedAsync(bearer)).valid).toBe(false);
  });
});
