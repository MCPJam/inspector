import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthKitVerificationError,
  verifyAuthKitToken,
} from "../../../services/authkit-jwt.js";
import { resetGuestJwksCacheForTests } from "../../../services/guest-token-verifier.js";
import { resetGuestAuthorityForTests } from "../../guest-authority.js";
import {
  classifyChatRequestActor,
  isGuestOrAnonymous,
  isGuestOrAnonymousRequest,
  isVerifiedMember,
} from "../local-engine-request.js";

/**
 * The local-engine boundary, exercised with REAL signatures: the guest
 * authority's keys come from a JWKS the test serves, and AuthKit sessions are
 * verified by the real verifier against a test issuer key. The point is the
 * regression: before, any bearer that was not signed by an in-process key the
 * server never had came out a "member" and could drive local bash.
 */

const BACKEND = "https://dev-backend.convex.site";
const GUEST_ISSUER = "https://api.mcpjam.com/guest";
const DELEGATED_ISSUER = "https://api.mcpjam.com/delegated";
const AUTHKIT_ISSUER = "https://deep-vanilla-68-test.authkit.app";
const CLIENT_ID = "client_test";

function rsa(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const authorityKeys = rsa();
const retiredKeys = rsa();
const authkitKeys = rsa();

async function sign(
  key: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  expiresIn: string | number = "1h",
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuedAt();
  if (typeof expiresIn === "number") jwt.setExpirationTime(expiresIn);
  else jwt.setExpirationTime(expiresIn);
  return jwt.sign(key);
}

const memberDeps = {
  verify: (token: string) =>
    verifyAuthKitToken(token, {
      clientId: CLIENT_ID,
      resolveKey: (issuer) =>
        issuer === AUTHKIT_ISSUER ? authkitKeys.publicKey : null,
    }),
};

const deps = {
  validateGuest: undefined as never,
  harnessActor: memberDeps,
};

async function classify(header: string | undefined) {
  const { validateGuestTokenDetailedAsync } =
    await import("../../../services/guest-token-verifier.js");
  return classifyChatRequestActor(header, {
    ...deps,
    validateGuest: validateGuestTokenDetailedAsync,
  });
}

describe("classifyChatRequestActor — the local-engine boundary", () => {
  const originalFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    "MCPJAM_GUEST_AUTHORITY",
    "CONVEX_HTTP_URL",
    "MCPJAM_GUEST_SESSION_SHARED_SECRET",
  ] as const;

  beforeEach(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env.MCPJAM_GUEST_AUTHORITY = "backend";
    process.env.CONVEX_HTTP_URL = BACKEND;
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = "test-secret";
    resetGuestAuthorityForTests();
    resetGuestJwksCacheForTests();
    const jwk = await exportJWK(authorityKeys.publicKey);
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === `${BACKEND}/guest/jwks`) {
        return new Response(
          JSON.stringify({
            keys: [{ ...jwk, kid: "guest-2", alg: "RS256", use: "sig" }],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetGuestAuthorityForTests();
    resetGuestJwksCacheForTests();
    global.fetch = originalFetch;
  });

  it("no Authorization ⇒ anonymous, never a member", async () => {
    for (const header of [undefined, "", "Bearer ", "Basic abc"]) {
      const actor = await classify(header);
      expect(actor.kind).toBe("anonymous");
      expect(isVerifiedMember(actor)).toBe(false);
      expect(isGuestOrAnonymous(actor)).toBe(true);
    }
  });

  it("a BACKEND-issued guest token ⇒ guest (the in-process key is never involved)", async () => {
    const token = await sign(authorityKeys.privateKey, "guest-2", {
      iss: GUEST_ISSUER,
      sub: "guest-123",
    });
    const actor = await classify(`Bearer ${token}`);
    expect(actor).toEqual({ kind: "guest", guestId: "guest-123" });
    expect(isVerifiedMember(actor)).toBe(false);
  });

  it("an arbitrary bearer ⇒ unverified, never a member", async () => {
    const actor = await classify("Bearer anything-at-all");
    expect(actor.kind).toBe("unverified");
    expect(isVerifiedMember(actor)).toBe(false);
    expect(isGuestOrAnonymous(actor)).toBe(false);
  });

  it("an expired AuthKit session ⇒ unverified", async () => {
    const token = await sign(
      authkitKeys.privateKey,
      "ak-1",
      { iss: AUTHKIT_ISSUER, sub: "user_1", aud: CLIENT_ID },
      Math.floor(Date.now() / 1000) - 3600,
    );
    const actor = await classify(`Bearer ${token}`);
    expect(actor.kind).toBe("unverified");
  });

  it("an expired guest token is not a guest and not a member", async () => {
    const token = await sign(
      authorityKeys.privateKey,
      "guest-2",
      { iss: GUEST_ISSUER, sub: "guest-old" },
      Math.floor(Date.now() / 1000) - 60,
    );
    const actor = await classify(`Bearer ${token}`);
    expect(actor.kind).toBe("unverified");
  });

  it("guest and delegated tokens signed by a RETIRED key are rejected", async () => {
    const retiredGuest = await sign(retiredKeys.privateKey, "guest-1", {
      iss: GUEST_ISSUER,
      sub: "guest-old",
    });
    const retiredDelegated = await sign(retiredKeys.privateKey, "guest-1", {
      iss: DELEGATED_ISSUER,
      sub: "user_1",
    });
    expect((await classify(`Bearer ${retiredGuest}`)).kind).toBe("unverified");
    expect((await classify(`Bearer ${retiredDelegated}`)).kind).toBe(
      "unverified",
    );
  });

  it("a retired key reusing the CURRENT kid is still rejected", async () => {
    const forged = await sign(retiredKeys.privateKey, "guest-2", {
      iss: GUEST_ISSUER,
      sub: "guest-old",
    });
    expect((await classify(`Bearer ${forged}`)).kind).toBe("unverified");
  });

  it("a verified AuthKit session ⇒ member, with the canonical acting user", async () => {
    const token = await sign(authkitKeys.privateKey, "ak-1", {
      iss: AUTHKIT_ISSUER,
      sub: "user_42",
      aud: CLIENT_ID,
    });
    const actor = await classify(`Bearer ${token}`);
    expect(actor.kind).toBe("member");
    if (actor.kind !== "member") return;
    expect(actor.actor.userId).toBe("authkit:user_42");
  });

  it("guest verification being unavailable can only make the answer stricter", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    resetGuestJwksCacheForTests();
    const guestToken = await sign(authorityKeys.privateKey, "guest-2", {
      iss: GUEST_ISSUER,
      sub: "guest-123",
    });
    const actor = await classify(`Bearer ${guestToken}`);
    expect(actor.kind).toBe("unverified");
    expect(isVerifiedMember(actor)).toBe(false);
  });

  it("a verifier that throws unexpectedly fails closed", async () => {
    const actor = await classifyChatRequestActor("Bearer x", {
      validateGuest: async () => ({ valid: false }),
      harnessActor: {
        verify: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(actor).toEqual({ kind: "unverified", reason: "verification_error" });
  });

  it("an AuthKit verification failure is reported as unverified, not thrown", async () => {
    const actor = await classifyChatRequestActor("Bearer x", {
      validateGuest: async () => ({ valid: false }),
      harnessActor: {
        verify: async () => {
          throw new AuthKitVerificationError("bad");
        },
      },
    });
    expect(actor.kind).toBe("unverified");
  });

  describe("isGuestOrAnonymousRequest (the guest half only)", () => {
    it("is true for no bearer and for a guest of the selected authority", async () => {
      expect(await isGuestOrAnonymousRequest(undefined)).toBe(true);
      const token = await sign(authorityKeys.privateKey, "guest-2", {
        iss: GUEST_ISSUER,
        sub: "guest-123",
      });
      expect(await isGuestOrAnonymousRequest(`Bearer ${token}`)).toBe(true);
    });

    it("is false for anything else — which is NOT a membership answer", async () => {
      expect(await isGuestOrAnonymousRequest("Bearer anything")).toBe(false);
      expect(
        await isGuestOrAnonymousRequest("Bearer x", {
          validateGuest: async () => {
            throw new Error("unavailable");
          },
        }),
      ).toBe(false);
      // The same bearer is never a member.
      expect((await classify("Bearer anything")).kind).toBe("unverified");
    });
  });
});
