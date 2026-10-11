/**
 * Tests for AuthKit access-token verification on the key-management surface.
 * The bar (per review): reject forged/unsigned, wrong-issuer, wrong-audience,
 * and expired tokens; accept a valid one and surface only `sub`/`org_id`.
 *
 * JWKS is injected via `deps` so these run offline with locally generated keys.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  resolveMcpResourceIndicator,
  verifyAuthKitToken,
  AuthKitVerificationError,
  type AuthKitVerifyDeps,
} from "../authkit-jwt.js";

const ISSUER = "https://login.mcpjam.com";
const CLIENT_ID = "client_test_123";
const SUB = "user_workos_42";
const PRODUCTION_CLIENT_ID = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
const LEGACY_STAGING_CLIENT_ID = "client_01K4C1TVA6CMQ3G32F1P301A9G";
const STAGING_CLIENT_ID = "client_01KTN2EWHHJCKRB8RSR307X4SG";

let trustedPrivate: CryptoKey;
let trustedPublic: CryptoKey;
let attackerPrivate: CryptoKey;

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
  key: CryptoKey,
  opts: {
    iss?: string;
    aud?: string;
    sub?: string;
    expSecondsFromNow?: number;
    orgId?: string | null;
    sid?: string;
  } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (opts.orgId !== null) payload.org_id = opts.orgId ?? "org_active";
  if (opts.sid) payload.sid = opts.sid;
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

  it("returns the session id when the token carries one", async () => {
    const token = await sign(trustedPrivate, { sid: "session_01" });
    const result = await verifyAuthKitToken(token, deps());
    expect(result).toEqual({
      sub: SUB,
      orgId: "org_active",
      sid: "session_01",
    });
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
    const token = await sign(trustedPrivate, {
      iss: "https://evil.example.com",
    });
    await expect(verifyAuthKitToken(token, deps())).rejects.toThrow(/issuer/i);
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign(trustedPrivate, { aud: "client_other" });
    await expect(verifyAuthKitToken(token, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
  });

  it("does not infer an MCP resource for an unknown AuthKit client id", async () => {
    const resource = resolveMcpResourceIndicator(PRODUCTION_CLIENT_ID)![0];
    const token = await sign(trustedPrivate, { aud: resource });

    expect(resolveMcpResourceIndicator(CLIENT_ID)).toBeUndefined();
    await expect(verifyAuthKitToken(token, deps())).rejects.toBeInstanceOf(
      AuthKitVerificationError,
    );
    await expect(
      verifyAuthKitToken(token, deps(), {
        allowMcpResourceAudience: true,
      }),
    ).rejects.toBeInstanceOf(AuthKitVerificationError);
  });

  it("accepts the MCP resource only for its matching OAuth issuer and client", async () => {
    const productionIssuer = "https://login.mcpjam.com";
    const productionDeps: AuthKitVerifyDeps = {
      clientId: PRODUCTION_CLIENT_ID,
      resolveKey: (issuer) =>
        issuer === productionIssuer ? trustedPublic : null,
    };
    const token = await sign(trustedPrivate, {
      iss: productionIssuer,
      aud: resolveMcpResourceIndicator(PRODUCTION_CLIENT_ID)?.[0],
    });

    await expect(
      verifyAuthKitToken(token, productionDeps),
    ).rejects.toBeInstanceOf(AuthKitVerificationError);
    await expect(
      verifyAuthKitToken(token, productionDeps, {
        allowMcpResourceAudience: true,
      }),
    ).resolves.toMatchObject({ sub: SUB });
  });

  it("rejects an MCP resource on a different issuer or environment", async () => {
    const productionIssuer = "https://login.mcpjam.com";
    // Even if an issuer key were mistakenly present in the injected resolver,
    // opting into MCP audiences must not accept that issuer's resource token.
    const productionDeps: AuthKitVerifyDeps = {
      clientId: PRODUCTION_CLIENT_ID,
      resolveKey: () => trustedPublic,
    };
    const wrongIssuer = await sign(trustedPrivate, {
      iss: "https://other-issuer.example",
      aud: resolveMcpResourceIndicator(PRODUCTION_CLIENT_ID)?.[0],
    });
    const wrongEnvironment = await sign(trustedPrivate, {
      iss: productionIssuer,
      aud: resolveMcpResourceIndicator(LEGACY_STAGING_CLIENT_ID)?.[0],
    });

    for (const token of [wrongIssuer, wrongEnvironment]) {
      await expect(
        verifyAuthKitToken(token, productionDeps, {
          allowMcpResourceAudience: true,
        }),
      ).rejects.toBeInstanceOf(AuthKitVerificationError);
    }
  });

  it("maps only the known environment client ids and matches the worker hosts", () => {
    expect(resolveMcpResourceIndicator(PRODUCTION_CLIENT_ID)).toEqual([
      "https://mcp.mcpjam.com/mcp",
    ]);
    expect(resolveMcpResourceIndicator(LEGACY_STAGING_CLIENT_ID)).toEqual([
      "https://mcp-staging.mcpjam.com/mcp",
    ]);
    expect(resolveMcpResourceIndicator(STAGING_CLIENT_ID)).toEqual([
      "http://localhost:8787/mcp",
      "https://mcp-staging.mcpjam.com/mcp",
    ]);
    expect(resolveMcpResourceIndicator("client_unknown")).toBeUndefined();

    const wrangler = readFileSync(
      new URL("../../../../mcp/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    expect(wrangler).toContain('"pattern": "mcp.mcpjam.com"');
    expect(wrangler).toContain('"pattern": "mcp-staging.mcpjam.com"');
    expect(wrangler).toContain("localhost:8787");
  });

  it.each(["http://localhost:8787/mcp", "https://mcp-staging.mcpjam.com/mcp"])(
    "accepts %s only for staging OAuth with explicit opt-in",
    async (aud) => {
      const issuer = "https://deep-vanilla-68-test.authkit.app";
      const stagingDeps: AuthKitVerifyDeps = {
        clientId: STAGING_CLIENT_ID,
        resolveKey: () => trustedPublic,
      };
      const token = await sign(trustedPrivate, { iss: issuer, aud });
      await expect(
        verifyAuthKitToken(token, stagingDeps),
      ).rejects.toBeInstanceOf(AuthKitVerificationError);
      await expect(
        verifyAuthKitToken(token, stagingDeps, {
          allowMcpResourceAudience: true,
        }),
      ).resolves.toMatchObject({ sub: SUB });
      for (const iss of [
        "https://api.workos.com/",
        "https://dynamic-echo-14-staging.authkit.app",
      ]) {
        const wrongIssuer = await sign(trustedPrivate, { iss, aud });
        await expect(
          verifyAuthKitToken(wrongIssuer, stagingDeps, {
            allowMcpResourceAudience: true,
          }),
        ).rejects.toBeInstanceOf(AuthKitVerificationError);
      }
      const productionToken = await sign(trustedPrivate, {
        iss: "https://login.mcpjam.com",
        aud,
      });
      await expect(
        verifyAuthKitToken(
          productionToken,
          { clientId: PRODUCTION_CLIENT_ID, resolveKey: () => trustedPublic },
          { allowMcpResourceAudience: true },
        ),
      ).rejects.toBeInstanceOf(AuthKitVerificationError);
    },
  );

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
