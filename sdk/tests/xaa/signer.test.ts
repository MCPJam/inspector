import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, createVerify, type JsonWebKey } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  getXAAIdpJwks,
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../src/xaa/mint/keypair.js";
import {
  issueAccessToken,
  issueAuthorizationCode,
  issueIdJag,
  issueMockIdToken,
  issueNegativeIdJag,
  verifyXaaJwt,
  XAA_ACCESS_TOKEN_TYP,
  XAA_CODE_JWT_TYP,
} from "../../src/xaa/mint/signer.js";
import {
  NEGATIVE_TEST_MODES,
  XAA_IDP_KID,
  type NegativeTestMode,
} from "../../src/xaa/constants.js";

function decodeJwt(token: string): {
  header: Record<string, any>;
  payload: Record<string, any>;
  signature: Buffer;
  signingInput: string;
} {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");

  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf-8")),
    payload: JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf-8"),
    ),
    signature: Buffer.from(encodedSignature, "base64url"),
    signingInput: `${encodedHeader}.${encodedPayload}`,
  };
}

function verifyWithPublishedKey(token: string): boolean {
  const jwk = getXAAIdpJwks().keys[0];
  const publicKey = createPublicKey({
    key: jwk as unknown as JsonWebKey,
    format: "jwk",
  });
  const { signature, signingInput } = decodeJwt(token);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  return verifier.verify(publicKey, signature);
}

describe("xaa-idjag-signer", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-idp-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("issues a valid ID-JAG with the published signing key", () => {
    const result = issueIdJag({
      issuer: "https://issuer.example/api/web/xaa",
      subject: "user-12345",
      audience: "https://auth.example.com",
      resource: "https://mcp.example.com",
      clientId: "mcpjam-debugger",
      scope: "read:tools",
    });

    const decoded = decodeJwt(result.token);

    expect(decoded.header).toMatchObject({
      alg: "RS256",
      typ: "oauth-id-jag+jwt",
      kid: XAA_IDP_KID,
    });
    expect(decoded.payload).toMatchObject({
      iss: "https://issuer.example/api/web/xaa",
      sub: "user-12345",
      aud: "https://auth.example.com",
      resource: "https://mcp.example.com",
      client_id: "mcpjam-debugger",
      scope: "read:tools",
    });
    expect(decoded.payload.jti).toEqual(expect.any(String));
    expect(verifyWithPublishedKey(result.token)).toBe(true);
  });

  it("issues a mock ID token with the published signing key", () => {
    const result = issueMockIdToken({
      issuer: "https://issuer.example/api/web/xaa",
      subject: "user-12345",
      email: "demo.user@example.com",
      audience: "mcpjam-debugger",
    });

    const decoded = decodeJwt(result.token);
    expect(decoded.header).toMatchObject({
      alg: "RS256",
      typ: "JWT",
      kid: XAA_IDP_KID,
    });
    expect(decoded.payload).toMatchObject({
      iss: "https://issuer.example/api/web/xaa",
      sub: "user-12345",
      email: "demo.user@example.com",
      aud: "mcpjam-debugger",
    });
    expect(verifyWithPublishedKey(result.token)).toBe(true);
  });

  const assertions: Record<
    NegativeTestMode,
    (decoded: ReturnType<typeof decodeJwt>) => void
  > = {
    valid: () => {},
    bad_signature: () => {},
    wrong_audience: (decoded) =>
      expect(decoded.payload.aud).toBe("https://wrong-audience.example.com"),
    expired: (decoded) =>
      expect(decoded.payload.exp).toBeLessThan(Math.floor(Date.now() / 1000)),
    missing_claims: (decoded) => {
      expect(decoded.payload).not.toHaveProperty("sub");
      expect(decoded.payload).not.toHaveProperty("resource");
    },
    invalid_type_header: (decoded) =>
      expect(decoded.header.typ).toBe("JWT"),
    wrong_issuer: (decoded) =>
      expect(decoded.payload.iss).toBe("https://wrong-issuer.example.com"),
    resource_mismatch: (decoded) =>
      expect(decoded.payload.resource).toBe(
        "https://wrong-resource.example.com",
      ),
    client_id_mismatch: (decoded) =>
      expect(decoded.payload.client_id).toBe("wrong-client-id"),
    unknown_kid: (decoded) =>
      expect(decoded.header.kid).toBe("nonexistent-key-id"),
    unknown_sub: (decoded) =>
      expect(decoded.payload.sub).toBe("unknown-user-00000"),
    scope_denial: (decoded) =>
      expect(decoded.payload.scope).toBe("admin:superuser offline_access"),
  };

  for (const mode of NEGATIVE_TEST_MODES.filter(
    (candidate) => candidate !== "valid",
  )) {
    it(`issues ${mode} ID-JAGs with the expected defect`, () => {
      const result = issueNegativeIdJag(
        {
          issuer: "https://issuer.example/api/web/xaa",
          subject: "user-12345",
          audience: "https://auth.example.com",
          resource: "https://mcp.example.com",
          clientId: "mcpjam-debugger",
          scope: "read:tools",
        },
        mode,
      );

      const decoded = decodeJwt(result.token);
      assertions[mode](decoded);

      if (mode === "bad_signature") {
        expect(verifyWithPublishedKey(result.token)).toBe(false);
      } else {
        expect(verifyWithPublishedKey(result.token)).toBe(true);
      }
    });
  }
});

describe("mock OIDC token minting + verification", () => {
  const ISSUER = "https://app.mcpjam.com/api/web/xaa";
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-oidc-signer-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("issues an authorization code with the expected claims, typ and TTL", () => {
    const issued = issueAuthorizationCode({
      issuer: ISSUER,
      subject: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      redirectUri: "https://rp.example.com/callback",
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
    });

    const { header, payload } = decodeJwt(issued.token);
    expect(header.typ).toBe(XAA_CODE_JWT_TYP);
    expect(payload).toMatchObject({
      iss: ISSUER,
      sub: "user-1",
      email: "u@example.com",
      client_id: "client-1",
      redirect_uri: "https://rp.example.com/callback",
      nonce: "nonce-1",
      code_challenge: "challenge-1",
    });
    expect(payload.exp - payload.iat).toBe(60);
  });

  it("issues an access token redeemable at userinfo", () => {
    const issued = issueAccessToken({
      issuer: ISSUER,
      subject: "user-1",
      email: "u@example.com",
      clientId: "client-1",
    });
    const { header, payload } = decodeJwt(issued.token);
    expect(header.typ).toBe(XAA_ACCESS_TOKEN_TYP);
    expect(payload.aud).toBe("client-1");
    expect(payload.scope).toBe("openid profile email");

    const verified = verifyXaaJwt(issued.token, {
      issuer: ISSUER,
      typ: XAA_ACCESS_TOKEN_TYP,
    });
    expect(verified.sub).toBe("user-1");
  });

  it("echoes a caller-provided nonce into the mock id token", () => {
    const issued = issueMockIdToken({
      issuer: ISSUER,
      subject: "user-1",
      email: "u@example.com",
      audience: "client-1",
      nonce: "rp-nonce",
    });
    expect(decodeJwt(issued.token).payload.nonce).toBe("rp-nonce");
  });

  it("verifyXaaJwt enforces typ segregation", () => {
    const code = issueAuthorizationCode({
      issuer: ISSUER,
      subject: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      redirectUri: "https://rp.example.com/callback",
    });
    // A code can never be redeemed as an access token.
    expect(() =>
      verifyXaaJwt(code.token, { issuer: ISSUER, typ: XAA_ACCESS_TOKEN_TYP }),
    ).toThrow(/type/i);
    // An ID-JAG can never be a code.
    const idJag = issueIdJag({
      issuer: ISSUER,
      subject: "user-1",
      audience: "https://as.example.com",
      resource: "https://rs.example.com",
      clientId: "client-1",
    });
    expect(() =>
      verifyXaaJwt(idJag.token, { issuer: ISSUER, typ: XAA_CODE_JWT_TYP }),
    ).toThrow(/type/i);
  });

  it("verifyXaaJwt rejects a wrong issuer and a foreign signature", () => {
    const issued = issueAccessToken({
      issuer: ISSUER,
      subject: "user-1",
      email: "u@example.com",
      clientId: "client-1",
    });
    expect(() =>
      verifyXaaJwt(issued.token, {
        issuer: "https://other.example.com",
        typ: XAA_ACCESS_TOKEN_TYP,
      }),
    ).toThrow(/issuer/i);

    // Re-keying the IdP invalidates previously-signed tokens (foreign key).
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-oidc-rekey-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    initXAAIdpKeyPair();
    expect(() =>
      verifyXaaJwt(issued.token, { issuer: ISSUER, typ: XAA_ACCESS_TOKEN_TYP }),
    ).toThrow(/signature/i);
  });
});
