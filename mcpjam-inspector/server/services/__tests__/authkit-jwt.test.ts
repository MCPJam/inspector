/**
 * Tests for AuthKit access-token verification on the key-management surface.
 * The bar (per review): reject forged/unsigned, wrong-issuer, wrong-audience,
 * and expired tokens; accept a valid one and surface only `sub`/`org_id`.
 *
 * JWKS is injected via `deps` so these run offline with locally generated keys.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, type KeyLike } from "jose";
import {
  verifyAuthKitToken,
  AuthKitVerificationError,
  type AuthKitVerifyDeps,
} from "../authkit-jwt.js";

const ISSUER = "https://login.mcpjam.com";
const CLIENT_ID = "client_test_123";
const SUB = "user_workos_42";

let trustedPrivate: KeyLike;
let trustedPublic: KeyLike;
let attackerPrivate: KeyLike;

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  trustedPrivate = trusted.privateKey;
  trustedPublic = trusted.publicKey;
  const attacker = await generateKeyPair("RS256");
  attackerPrivate = attacker.privateKey;
});

// Trust only ISSUER, verified against the trusted public key.
function deps(): AuthKitVerifyDeps {
  return {
    clientId: CLIENT_ID,
    resolveKey: (iss) => (iss === ISSUER ? trustedPublic : null),
  };
}

async function sign(
  key: KeyLike,
  opts: {
    iss?: string;
    aud?: string;
    sub?: string;
    expSecondsFromNow?: number;
    orgId?: string | null;
  } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (opts.orgId !== null) payload.org_id = opts.orgId ?? "org_active";
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(opts.sub ?? SUB)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt();
  const exp = Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 300);
  builder.setExpirationTime(exp);
  return builder.sign(key);
}

describe("verifyAuthKitToken", () => {
  it("accepts a valid token and returns only sub + org_id", async () => {
    const token = await sign(trustedPrivate, { orgId: "org_active" });
    const result = await verifyAuthKitToken(token, deps());
    expect(result).toEqual({ sub: SUB, orgId: "org_active" });
  });

  it("returns orgId undefined when the token has no org_id", async () => {
    const token = await sign(trustedPrivate, { orgId: null });
    const result = await verifyAuthKitToken(token, deps());
    expect(result).toEqual({ sub: SUB, orgId: undefined });
  });

  it("rejects a forged token signed with an untrusted key", async () => {
    // Attacker controls the payload (valid-looking iss/aud/sub) but not the key.
    const token = await sign(attackerPrivate, { sub: "victim_workos_id" });
    await expect(verifyAuthKitToken(token, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned =
      `${b64({ alg: "none", typ: "JWT" })}.` +
      `${b64({ iss: ISSUER, aud: CLIENT_ID, sub: "victim_workos_id" })}.`;
    await expect(verifyAuthKitToken(unsigned, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
  });

  it("rejects a token from an untrusted issuer", async () => {
    const token = await sign(trustedPrivate, { iss: "https://evil.example.com" });
    await expect(
      verifyAuthKitToken(token, deps()),
    ).rejects.toThrow(/issuer/i);
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign(trustedPrivate, { aud: "client_other" });
    await expect(verifyAuthKitToken(token, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
  });

  it("rejects an expired token", async () => {
    const token = await sign(trustedPrivate, { expSecondsFromNow: -60 });
    await expect(verifyAuthKitToken(token, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyAuthKitToken("not-a-jwt", deps()),
    ).rejects.toBeInstanceOf(AuthKitVerificationError);
  });
});
