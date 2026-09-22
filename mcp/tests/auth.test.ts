import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import {
  authkitIssuerJwks,
  GUEST_ISSUER,
  resourceIdentifier,
  verifyBearerToken,
  type VerifyConfig,
} from "../src/auth.js";

const CLIENT_ID = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
const AUTHKIT_DOMAIN = "login.mcpjam.com";
const ORIGIN = "https://mcp.mcpjam.com";

// The issuer the browser AuthKit SDK actually stamps on prod tokens — the
// regression this whole fix exists for. Pinning to AUTHKIT_DOMAIN rejected it.
const WORKOS_ISSUER = `https://api.workos.com/user_management/${CLIENT_ID}`;

async function makeToken(
  privateKey: CryptoKey,
  claims: { iss: string; aud?: string; expSecondsFromNow?: number },
): Promise<string> {
  const exp = `${claims.expSecondsFromNow ?? 3600}s`;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(claims.iss)
    .setAudience(claims.aud ?? CLIENT_ID)
    .setSubject("user_123")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

function request(token?: string): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("authkitIssuerJwks", () => {
  it("maps the WorkOS-hosted issuer the browser SDK actually uses", () => {
    const map = authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN);
    expect(map.get(WORKOS_ISSUER)).toBe(
      `https://api.workos.com/sso/jwks/${CLIENT_ID}`,
    );
  });

  it("maps the custom AuthKit domain to its /oauth2/jwks endpoint", () => {
    const map = authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN);
    expect(map.get(`https://${AUTHKIT_DOMAIN}`)).toBe(
      `https://${AUTHKIT_DOMAIN}/oauth2/jwks`,
    );
  });

  it("omits the custom domain when AUTHKIT_DOMAIN is unset", () => {
    const map = authkitIssuerJwks(CLIENT_ID, undefined);
    expect(map.has(`https://${AUTHKIT_DOMAIN}`)).toBe(false);
    expect(map.has(WORKOS_ISSUER)).toBe(true);
  });
});

describe("verifyBearerToken", () => {
  it("accepts a token from the WorkOS-hosted issuer (the prod regression)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, { iss: WORKOS_ISSUER });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(true);
    if (result.ok && result.verified.kind === "jwt")
      expect(result.verified.payload.sub).toBe("user_123");
  });

  it("accepts a token from the custom AuthKit domain issuer", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, {
      iss: `https://${AUTHKIT_DOMAIN}`,
    });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(true);
  });

  it("rejects an untrusted issuer with 401", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, {
      iss: "https://evil.example.com",
    });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects a token whose audience is not our client id", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, {
      iss: WORKOS_ISSUER,
      aud: "client_someone_else",
    });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(false);
  });

  it("accepts a token audienced to our resource indicator (third-party OAuth)", async () => {
    // The regression this test exists for: with an MCP Resource Indicator
    // configured in WorkOS, AuthKit stamps `aud` with the requested `resource`
    // rather than the environment client id. Pinning to the client id alone
    // 401'd every third-party client (Claude Code, Cursor, …) *after* a
    // fully successful OAuth flow.
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, {
      iss: `https://${AUTHKIT_DOMAIN}`,
      aud: resourceIdentifier(ORIGIN),
    });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(true);
    if (result.ok && result.verified.kind === "jwt")
      expect(result.verified.payload.sub).toBe("user_123");
  });

  it("rejects a token audienced to a different MCP resource", async () => {
    // Accepting both audiences must not become "accept any audience": a token
    // minted for the staging server (same issuer, same signing keys) must not
    // be replayable against prod.
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeToken(privateKey, {
      iss: `https://${AUTHKIT_DOMAIN}`,
      aud: "https://mcp-staging.mcpjam.com/mcp",
    });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("advertises the resource identifier it accepts as an audience", () => {
    // The metadata document and the audience check must not drift apart.
    expect(resourceIdentifier(ORIGIN)).toBe("https://mcp.mcpjam.com/mcp");
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const signer = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      // The allow-list issuer resolves, but to the WRONG public key.
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? other.publicKey
          : null,
    };
    const token = await makeToken(signer.privateKey, { iss: WORKOS_ISSUER });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(false);
  });

  it("returns 401 with no error code when the bearer is absent", async () => {
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: () => null,
    };

    const result = await verifyBearerToken(request(), config, ORIGIN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      // RFC 6750 §3.1: a missing-credentials challenge carries no error code.
      const wwwAuth = result.response.headers.get("www-authenticate") ?? "";
      expect(wwwAuth).not.toContain("error=");
    }
  });

  it("accepts an AuthKit token even when guest verification is enabled", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const guestPair = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      guest: { issuer: GUEST_ISSUER, jwksUrl: "https://unused.example/jwks" },
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
      resolveGuestKey: () => guestPair.publicKey,
    };
    const token = await makeToken(privateKey, { iss: WORKOS_ISSUER });

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(true);
  });

  // An MCPJam `sk_` key is accepted on its shape and validated by the Platform
  // API, which is the only party that can resolve it — see `VerifiedToken`.
  // These cases pin the SHAPE rule, because that rule is the whole security
  // boundary at the edge: widen it and an arbitrary opaque string stops being
  // challenged.
  it("accepts an MCPJam API key without any key material", async () => {
    // No `resolveKey`: reaching a JWKS at all would mean the key took the JWT
    // path. A fetch here would fail the test rather than hang it.
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: () => {
        throw new Error("an API key must never resolve a signing key");
      },
    };

    const result = await verifyBearerToken(
      request("sk_live_abc123DEF-456_x"),
      config,
      ORIGIN,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verified.kind).toBe("api_key");
      expect(result.verified.token).toBe("sk_live_abc123DEF-456_x");
    }
  });

  it("accepts an API key while locked down, where a guest would be refused", async () => {
    // Lockdown reaches this function as an ABSENT `guest` config (see the
    // `/mcp` route), which is exactly what a locked-down request looks like
    // here. The key is still admitted: the flag bars strangers, not accounts.
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
    };

    const result = await verifyBearerToken(
      request("sk_test_lockdown"),
      config,
      ORIGIN,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verified.kind).toBe("api_key");
  });

  it("rejects a bearer that only looks like an API key", async () => {
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: () => null,
    };

    // `sk-` is a different prefix; a key with a dot could be a JWT smuggling
    // its way past the prefix; a second word is not one token at all.
    for (const bearer of ["sk-live_abc", "sk_live.abc.def", "sk_live_abc extra"]) {
      const result = await verifyBearerToken(request(bearer), config, ORIGIN);
      expect(result.ok, bearer).toBe(false);
      if (!result.ok) expect(result.response.status, bearer).toBe(401);
    }
  });

  it("rejects a JWT that merely starts with the key prefix", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: () => null,
    };
    const jwt = await makeToken(privateKey, { iss: WORKOS_ISSUER });

    const result = await verifyBearerToken(
      request(`sk_${jwt}`),
      config,
      ORIGIN,
    );

    expect(result.ok).toBe(false);
  });
});

// Guest tokens are RS256, carry { iss, sub, iat, exp } with NO `aud`, and must
// NOT carry a `purpose` claim. They verify against the guest JWKS only when
// `config.guest` is set.
async function makeGuestToken(
  privateKey: CryptoKey,
  opts: {
    sub?: string;
    purpose?: string;
    iss?: string;
    expSecondsFromNow?: number;
  } = {},
): Promise<string> {
  return new SignJWT(opts.purpose ? { purpose: opts.purpose } : {})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? GUEST_ISSUER)
    .setSubject(opts.sub ?? "guest_abc")
    .setIssuedAt()
    .setExpirationTime(`${opts.expSecondsFromNow ?? 3600}s`)
    .sign(privateKey);
}

function guestConfig(publicKey: CryptoKey): VerifyConfig {
  return {
    clientId: CLIENT_ID,
    authkitDomain: AUTHKIT_DOMAIN,
    guest: { issuer: GUEST_ISSUER, jwksUrl: "https://guest.example/jwks" },
    // Guest branch resolves here; the AuthKit path resolves nothing.
    resolveGuestKey: (issuer) => (issuer === GUEST_ISSUER ? publicKey : null),
    resolveKey: () => null,
  };
}

describe("verifyBearerToken — guest tokens", () => {
  it("accepts a valid guest token (no aud) and exposes sub", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await makeGuestToken(privateKey, { sub: "guest_xyz" });

    const result = await verifyBearerToken(
      request(token),
      guestConfig(publicKey),
      ORIGIN,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.verified.kind === "jwt")
      expect(result.verified.payload.sub).toBe("guest_xyz");
  });

  it("rejects a guest token carrying a purpose claim (promotion-proof reuse)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await makeGuestToken(privateKey, { purpose: "promotion" });

    const result = await verifyBearerToken(
      request(token),
      guestConfig(publicKey),
      ORIGIN,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects an expired guest token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await makeGuestToken(privateKey, {
      expSecondsFromNow: -120,
    });

    const result = await verifyBearerToken(
      request(token),
      guestConfig(publicKey),
      ORIGIN,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a guest token signed by the wrong key", async () => {
    const signer = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const token = await makeGuestToken(signer.privateKey);

    const result = await verifyBearerToken(
      request(token),
      guestConfig(other.publicKey),
      ORIGIN,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects the guest issuer when guest verification is disabled", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    // No `guest` config → the guest issuer is absent from the AuthKit
    // allow-list, so it never resolves a key.
    const config: VerifyConfig = {
      clientId: CLIENT_ID,
      authkitDomain: AUTHKIT_DOMAIN,
      resolveKey: (issuer) =>
        authkitIssuerJwks(CLIENT_ID, AUTHKIT_DOMAIN).has(issuer)
          ? publicKey
          : null,
    };
    const token = await makeGuestToken(privateKey);

    const result = await verifyBearerToken(request(token), config, ORIGIN);

    expect(result.ok).toBe(false);
  });
});
