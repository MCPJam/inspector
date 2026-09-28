/**
 * `classifyAuthKitBearer` — the gateway verdict `bearerAuthMiddleware` acts on.
 *
 * Keys are generated locally and injected through `deps`, so these run
 * offline. A JWKS outage is simulated with a key resolver that throws the way
 * jose's remote key set does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  errors as joseErrors,
  generateKeyPair,
  type KeyLike,
} from "jose";
import {
  AUTHKIT_KEYS_UNAVAILABLE_BACKOFF_MS,
  classifyAuthKitBearer,
  resetAuthKitJwksCacheForTests,
  type AuthKitGatewayDeps,
} from "../authkit-jwt.js";

const CLIENT_ID = "client_gateway_test";
// A WorkOS user-management issuer: tokens must carry our client id.
const WORKOS_ISSUER = `https://api.workos.com/user_management/${CLIENT_ID}`;
// The AuthKit OAuth issuer: the backend also accepts other audiences from it.
const OAUTH_ISSUER = "https://login.example.test";
const MCP_AUDIENCE = "https://mcp.example.test/mcp";
const SUB = "user_gateway_1";
const SID = "session_gateway_1";

let trustedPrivate: KeyLike;
let trustedPublic: KeyLike;
let attackerPrivate: KeyLike;

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  trustedPrivate = trusted.privateKey;
  trustedPublic = trusted.publicKey;
  attackerPrivate = (await generateKeyPair("RS256")).privateKey;
});

beforeEach(() => {
  resetAuthKitJwksCacheForTests();
});

function deps(
  resolveKey: AuthKitGatewayDeps["resolveKey"] = (iss) =>
    iss === WORKOS_ISSUER || iss === OAUTH_ISSUER ? trustedPublic : null,
): AuthKitGatewayDeps {
  return {
    clientId: CLIENT_ID,
    resolveKey,
    anyAudienceIssuers: new Set([OAUTH_ISSUER]),
  };
}

async function sign(
  key: KeyLike,
  opts: {
    iss?: string;
    aud?: string;
    sub?: string | null;
    sid?: string | null;
    expSecondsFromNow?: number | null;
  } = {},
): Promise<string> {
  const payload: Record<string, unknown> = { org_id: "org_1" };
  if (opts.sid !== null) payload.sid = opts.sid ?? SID;
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? WORKOS_ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt();
  if (opts.sub !== null) builder.setSubject(opts.sub ?? SUB);
  if (opts.expSecondsFromNow !== null) {
    builder.setExpirationTime(
      Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 300),
    );
  }
  return builder.sign(key);
}

describe("classifyAuthKitBearer", () => {
  it("verifies a valid token and surfaces sub, sid and org_id", async () => {
    const token = await sign(trustedPrivate);
    await expect(classifyAuthKitBearer(token, deps())).resolves.toEqual({
      kind: "verified",
      sub: SUB,
      sid: SID,
      orgId: "org_1",
    });
  });

  it("verifies a token without a sid", async () => {
    const token = await sign(trustedPrivate, { sid: null });
    await expect(classifyAuthKitBearer(token, deps())).resolves.toMatchObject({
      kind: "verified",
      sub: SUB,
      sid: undefined,
    });
  });

  it("rejects a forged token signed with an untrusted key", async () => {
    const token = await sign(attackerPrivate, { sub: "someone_else" });
    await expect(classifyAuthKitBearer(token, deps())).resolves.toEqual({
      kind: "invalid",
      reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });

  it("rejects an expired token", async () => {
    const token = await sign(trustedPrivate, { expSecondsFromNow: -120 });
    await expect(classifyAuthKitBearer(token, deps())).resolves.toEqual({
      kind: "invalid",
      reason: "ERR_JWT_EXPIRED",
    });
  });

  it("rejects a token with no expiry, or no subject", async () => {
    const noExp = await sign(trustedPrivate, { expSecondsFromNow: null });
    await expect(classifyAuthKitBearer(noExp, deps())).resolves.toEqual({
      kind: "invalid",
      reason: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
    const noSub = await sign(trustedPrivate, { sub: null });
    await expect(classifyAuthKitBearer(noSub, deps())).resolves.toEqual({
      kind: "invalid",
      reason: "missing_sub",
    });
  });

  it("rejects a tampered payload", async () => {
    const token = await sign(trustedPrivate);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        iss: WORKOS_ISSUER,
        aud: CLIENT_ID,
        sub: "someone_else",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");
    await expect(
      classifyAuthKitBearer(`${header}.${forgedPayload}.${signature}`, deps()),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("rejects a WorkOS-issuer token minted for another audience", async () => {
    const token = await sign(trustedPrivate, { aud: "client_someone_else" });
    await expect(classifyAuthKitBearer(token, deps())).resolves.toEqual({
      kind: "invalid",
      reason: "audience",
    });
  });

  it("defers an OAuth-issuer token for another audience to downstream", async () => {
    const token = await sign(trustedPrivate, {
      iss: OAUTH_ISSUER,
      aud: MCP_AUDIENCE,
    });
    await expect(classifyAuthKitBearer(token, deps())).resolves.toEqual({
      kind: "foreign_audience",
    });
    // Same issuer, our client id: verified like any other.
    const own = await sign(trustedPrivate, { iss: OAUTH_ISSUER });
    await expect(classifyAuthKitBearer(own, deps())).resolves.toMatchObject({
      kind: "verified",
    });
  });

  it("does not claim tokens it has no business verifying", async () => {
    // A JWT from an issuer outside the AuthKit set (MCPJam guest/delegated
    // tokens, for instance) and a bearer that is not a JWT at all.
    const foreign = await sign(attackerPrivate, {
      iss: "https://api.mcpjam.com/delegated",
    });
    await expect(classifyAuthKitBearer(foreign, deps())).resolves.toEqual({
      kind: "not_authkit",
    });
    await expect(classifyAuthKitBearer("not-a-jwt", deps())).resolves.toEqual({
      kind: "not_authkit",
    });
  });

  it("treats a missing AuthKit configuration as nothing to verify", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "");
    vi.stubEnv("VITE_WORKOS_CLIENT_ID", "");
    try {
      const token = await sign(trustedPrivate);
      await expect(classifyAuthKitBearer(token)).resolves.toEqual({
        kind: "not_authkit",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a token whose signing key is not in the issuer's key set", async () => {
    const noMatchingKey = vi.fn(async () => {
      throw new joseErrors.JWKSNoMatchingKey();
    });
    const token = await sign(trustedPrivate);
    await expect(
      classifyAuthKitBearer(
        token,
        deps(() => noMatchingKey as any),
      ),
    ).resolves.toEqual({ kind: "invalid", reason: "ERR_JWKS_NO_MATCHING_KEY" });
  });

  describe("when the issuer's keys cannot be fetched", () => {
    it("defers instead of deciding, then backs off per issuer", async () => {
      const unreachable = vi.fn(async () => {
        throw new joseErrors.JWKSTimeout();
      });
      const token = await sign(trustedPrivate);
      const now = Date.now();

      await expect(
        classifyAuthKitBearer(
          token,
          deps(() => unreachable as any),
          now,
        ),
      ).resolves.toMatchObject({
        kind: "keys_unavailable",
        issuer: WORKOS_ISSUER,
      });
      expect(unreachable).toHaveBeenCalledTimes(1);

      // Within the back-off window the fetch is not attempted again.
      await expect(
        classifyAuthKitBearer(
          token,
          deps(() => unreachable as any),
          now + AUTHKIT_KEYS_UNAVAILABLE_BACKOFF_MS - 1,
        ),
      ).resolves.toMatchObject({ kind: "keys_unavailable" });
      expect(unreachable).toHaveBeenCalledTimes(1);

      // Another issuer is unaffected by this one's outage.
      const other = await sign(trustedPrivate, { iss: OAUTH_ISSUER });
      await expect(
        classifyAuthKitBearer(
          other,
          deps((iss) => (iss === OAUTH_ISSUER ? trustedPublic : null)),
          now + 1,
        ),
      ).resolves.toMatchObject({ kind: "verified" });

      // After the window, verification resumes.
      await expect(
        classifyAuthKitBearer(
          token,
          deps(),
          now + AUTHKIT_KEYS_UNAVAILABLE_BACKOFF_MS,
        ),
      ).resolves.toMatchObject({ kind: "verified" });
    });

    it("treats a network error the same way", async () => {
      const refused = vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      });
      const token = await sign(trustedPrivate);
      await expect(
        classifyAuthKitBearer(
          token,
          deps(() => refused as any),
        ),
      ).resolves.toMatchObject({
        kind: "keys_unavailable",
        reason: "connect ECONNREFUSED 127.0.0.1:1",
      });
    });
  });
});
