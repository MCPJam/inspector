import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import {
  authkitIssuerJwks,
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
    if (result.ok) expect(result.verified.payload.sub).toBe("user_123");
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
});
