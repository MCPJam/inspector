import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  type JsonWebKey,
} from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  getXAAIdpJwks,
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../xaa-idp-keypair.js";
import { issueIdJag } from "../xaa-idjag-signer.js";

function publishedModulus(): string {
  const jwk = getXAAIdpJwks().keys[0] as JsonWebKey & { n: string };
  return jwk.n;
}

function modulusOf(privatePem: string): string {
  const jwk = createPublicKey(privatePem).export({ format: "jwk" }) as {
    n: string;
  };
  return jwk.n;
}

function verifyWithPublishedKey(token: string): boolean {
  const jwk = getXAAIdpJwks().keys[0];
  const publicKey = createPublicKey({
    key: jwk as unknown as JsonWebKey,
    format: "jwk",
  });
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  return verifier.verify(publicKey, Buffer.from(encodedSignature, "base64url"));
}

describe("xaa-idp-keypair secret loading", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalSecret = process.env.XAA_IDP_PRIVATE_KEY;
  let tempDir: string;
  let secretPem: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-idp-secret-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    secretPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    resetXAAIdpKeyPairForTests();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    if (originalSecret === undefined) delete process.env.XAA_IDP_PRIVATE_KEY;
    else process.env.XAA_IDP_PRIVATE_KEY = originalSecret;
  });

  it("publishes the secret key in JWKS, taking priority over the local file", () => {
    process.env.XAA_IDP_PRIVATE_KEY = secretPem;
    initXAAIdpKeyPair();
    expect(publishedModulus()).toBe(modulusOf(secretPem));
  });

  it("signs ID-JAGs that verify against the published JWKS", () => {
    process.env.XAA_IDP_PRIVATE_KEY = secretPem;
    initXAAIdpKeyPair();
    const { token } = issueIdJag({
      issuer: "https://issuer.example/api/web/xaa",
      subject: "user-12345",
      audience: "https://auth.example.com",
      resource: "https://mcp.example.com",
      clientId: "mcpjam-debugger",
      scope: "read:tools",
    });
    expect(verifyWithPublishedKey(token)).toBe(true);
  });

  it("accepts a base64-encoded PEM secret", () => {
    process.env.XAA_IDP_PRIVATE_KEY = Buffer.from(secretPem, "utf-8").toString(
      "base64",
    );
    initXAAIdpKeyPair();
    expect(publishedModulus()).toBe(modulusOf(secretPem));
  });

  it("accepts a PEM whose newlines are escaped as literal \\n", () => {
    process.env.XAA_IDP_PRIVATE_KEY = secretPem.replace(/\n/g, "\\n");
    initXAAIdpKeyPair();
    expect(publishedModulus()).toBe(modulusOf(secretPem));
  });

  it("falls back to the local file when the secret is unset", () => {
    delete process.env.XAA_IDP_PRIVATE_KEY;
    initXAAIdpKeyPair();
    expect(publishedModulus()).not.toBe(modulusOf(secretPem));
  });

  it("falls back when the secret is unparseable", () => {
    process.env.XAA_IDP_PRIVATE_KEY = "not-a-valid-key";
    initXAAIdpKeyPair();
    expect(publishedModulus()).not.toBe(modulusOf(secretPem));
  });
});
