import { createPrivateKey, generateKeyPairSync, createSign } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type JwtPayload = Record<string, unknown>;

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signRs256Token(options: {
  privateKeyPem: string;
  kid: string;
  payload: JwtPayload;
}) {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: options.kid,
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(options.payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(createPrivateKey(options.privateKeyPem))
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

describe("hosted-jwt-verifier", () => {
  const originalEnv = {
    hostedMode: process.env.VITE_MCPJAM_HOSTED_MODE,
    jwksUrl: process.env.MCPJAM_JWKS_URL,
    issuer: process.env.MCPJAM_JWT_ISSUER,
    audience: process.env.MCPJAM_JWT_AUDIENCE,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (originalEnv.hostedMode === undefined) {
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
    } else {
      process.env.VITE_MCPJAM_HOSTED_MODE = originalEnv.hostedMode;
    }

    if (originalEnv.jwksUrl === undefined) {
      delete process.env.MCPJAM_JWKS_URL;
    } else {
      process.env.MCPJAM_JWKS_URL = originalEnv.jwksUrl;
    }

    if (originalEnv.issuer === undefined) {
      delete process.env.MCPJAM_JWT_ISSUER;
    } else {
      process.env.MCPJAM_JWT_ISSUER = originalEnv.issuer;
    }

    if (originalEnv.audience === undefined) {
      delete process.env.MCPJAM_JWT_AUDIENCE;
    } else {
      process.env.MCPJAM_JWT_AUDIENCE = originalEnv.audience;
    }
  });

  it("verifies a valid RS256 token against JWKS", async () => {
    process.env.MCPJAM_JWKS_URL = "https://issuer.example.com/jwks";
    process.env.MCPJAM_JWT_ISSUER = "https://issuer.example.com";
    process.env.MCPJAM_JWT_AUDIENCE = "mcpjam-web";

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" }) as {
      n: string;
      e: string;
      kty: string;
    };

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        keys: [
          {
            kty: "RSA",
            kid: "key-1",
            n: publicJwk.n,
            e: publicJwk.e,
          },
        ],
      }),
    } as Response);

    const token = signRs256Token({
      privateKeyPem: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      kid: "key-1",
      payload: {
        sub: "user_123",
        iss: "https://issuer.example.com",
        aud: "mcpjam-web",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
    });

    const { resetHostedJwtVerifierForTests, verifyHostedJwt } =
      await import("../hosted-jwt-verifier.js");
    resetHostedJwtVerifierForTests();

    const payload = await verifyHostedJwt(token);
    expect(payload.sub).toBe("user_123");
  });

  it("rejects token with invalid audience", async () => {
    process.env.MCPJAM_JWKS_URL = "https://issuer.example.com/jwks";
    process.env.MCPJAM_JWT_ISSUER = "https://issuer.example.com";
    process.env.MCPJAM_JWT_AUDIENCE = "mcpjam-web";

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" }) as {
      n: string;
      e: string;
      kty: string;
    };

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        keys: [
          {
            kty: "RSA",
            kid: "key-1",
            n: publicJwk.n,
            e: publicJwk.e,
          },
        ],
      }),
    } as Response);

    const token = signRs256Token({
      privateKeyPem: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      kid: "key-1",
      payload: {
        sub: "user_123",
        iss: "https://issuer.example.com",
        aud: "different-audience",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
    });

    const { resetHostedJwtVerifierForTests, verifyHostedJwt } =
      await import("../hosted-jwt-verifier.js");
    resetHostedJwtVerifierForTests();

    await expect(verifyHostedJwt(token)).rejects.toMatchObject({
      code: "invalid_claims",
      status: 401,
    });
  });
});
