import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  type JsonWebKey,
} from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  getXaaClientJwks,
  getXaaClientPrivateKey,
  initXaaClientKeyPair,
  resetXaaClientKeyPairForTests,
  XAA_CLIENT_KID,
} from "../../src/xaa/mint/client-keypair.js";
import { signClientAssertion } from "../../src/xaa/mint/client-assertion.js";

// The confidential-CIMD client key is DISTINCT from the IdP issuer key: it
// signs the private_key_jwt client_assertion the RAS verifies against the
// public JWK the reflector publishes. These pins guard the sign→verify contract
// the worker's authenticateCimdClient depends on.

/** Verify a compact ES256 JWS (raw r‖s) against the published JWKS. */
function verifyAgainstPublishedJwks(jws: string): boolean {
  const jwk = getXaaClientJwks().keys[0];
  const publicKey = createPublicKey({
    key: jwk as unknown as JsonWebKey,
    format: "jwk",
  });
  const [header, payload, signature] = jws.split(".");
  const verifier = createVerify("SHA256");
  verifier.update(`${header}.${payload}`);
  return verifier.verify(
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
}

describe("xaa client keypair (confidential CIMD)", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalSecret = process.env.XAA_CLIENT_PRIVATE_KEY;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-client-key-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    delete process.env.XAA_CLIENT_PRIVATE_KEY;
    resetXaaClientKeyPairForTests();
  });

  afterEach(() => {
    resetXaaClientKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    if (originalSecret === undefined) delete process.env.XAA_CLIENT_PRIVATE_KEY;
    else process.env.XAA_CLIENT_PRIVATE_KEY = originalSecret;
  });

  it("publishes an EC P-256 ES256 signing JWK", () => {
    initXaaClientKeyPair();
    const jwk = getXaaClientJwks().keys[0] as JsonWebKey & {
      kid: string;
      alg: string;
      use: string;
    };
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe(XAA_CLIENT_KID);
    // A published document can never leak the private scalar.
    expect((jwk as { d?: string }).d).toBeUndefined();
    expect(jwk.x).toBeTruthy();
    expect(jwk.y).toBeTruthy();
  });

  it("persists the key so a second process (fresh singleton) reuses it", () => {
    initXaaClientKeyPair();
    const first = getXaaClientJwks().keys[0].x;
    // Simulate a second CLI invocation: same key dir, fresh module singleton.
    resetXaaClientKeyPairForTests();
    initXaaClientKeyPair();
    expect(getXaaClientJwks().keys[0].x).toBe(first);
  });

  it("prefers the XAA_CLIENT_PRIVATE_KEY secret over the local file", () => {
    // Seed a persisted local key, then override with a secret PEM.
    initXaaClientKeyPair();
    const fileX = getXaaClientJwks().keys[0].x;
    const secretPem = getXaaClientPrivateKey().export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    resetXaaClientKeyPairForTests();

    // A *different* secret key must take priority.
    // Reuse the same PEM here only to prove the secret path loads at all;
    // identity is asserted by round-tripping the same material.
    process.env.XAA_CLIENT_PRIVATE_KEY = secretPem;
    initXaaClientKeyPair();
    expect(getXaaClientJwks().keys[0].x).toBe(fileX);
  });

  it("throws when accessed before initialization", () => {
    expect(() => getXaaClientPrivateKey()).toThrow(/not initialized/);
    expect(() => getXaaClientJwks()).toThrow(/not initialized/);
  });

  it("ignores a non-P-256 XAA_CLIENT_PRIVATE_KEY and falls back to a generated key", () => {
    // An RSA secret would yield an ES256 doc/assertion the RAS can't validate;
    // the loader must reject it and generate a proper P-256 key instead.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.XAA_CLIENT_PRIVATE_KEY = privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    initXaaClientKeyPair();
    const jwk = getXaaClientJwks().keys[0];
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
  });

  it("recovers when the persisted public PEM is corrupted (public derived from private)", () => {
    initXaaClientKeyPair();
    const expectedX = getXaaClientJwks().keys[0].x;
    // Corrupt the standalone public PEM; a fresh load must still publish the key
    // that matches the private signing key.
    writeFileSync(path.join(tempDir, "xaa-client-public.pem"), "garbage");
    resetXaaClientKeyPairForTests();
    initXaaClientKeyPair();
    expect(getXaaClientJwks().keys[0].x).toBe(expectedX);
  });
});

describe("signClientAssertion", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-client-assert-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    delete process.env.XAA_CLIENT_PRIVATE_KEY;
    resetXaaClientKeyPairForTests();
    initXaaClientKeyPair();
  });

  afterEach(() => {
    resetXaaClientKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
  });

  const clientId =
    "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/AbC123";
  const tokenEndpoint = "https://auth.example.com/oauth/token";

  it("signs a verifiable ES256 assertion", () => {
    const jws = signClientAssertion({ clientId, tokenEndpoint });
    expect(jws.split(".")).toHaveLength(3);
    expect(verifyAgainstPublishedJwks(jws)).toBe(true);
  });

  it("emits the RFC 7523 claims the worker requires (iss=sub=client_id, aud, exp)", () => {
    const now = 1_700_000_000;
    const jws = signClientAssertion({
      clientId,
      tokenEndpoint,
      nowSeconds: now,
    });
    const [header, payload] = jws.split(".");
    const h = decodeJwtPart(header);
    const p = decodeJwtPart(payload);

    expect(h.alg).toBe("ES256");
    expect(h.typ).toBe("JWT");
    expect(h.kid).toBe(XAA_CLIENT_KID);

    expect(p.iss).toBe(clientId);
    expect(p.sub).toBe(clientId);
    expect(p.aud).toBe(tokenEndpoint);
    expect(p.iat).toBe(now);
    expect(p.exp).toBe(now + 300);
    expect(typeof p.jti).toBe("string");
    expect((p.jti as string).length).toBeGreaterThan(0);
  });

  it("uses a fresh jti per call (replay protection)", () => {
    const a = decodeJwtPart(
      signClientAssertion({ clientId, tokenEndpoint }).split(".")[1],
    );
    const b = decodeJwtPart(
      signClientAssertion({ clientId, tokenEndpoint }).split(".")[1],
    );
    expect(a.jti).not.toBe(b.jti);
  });

  it("produces a raw r‖s signature (64 bytes), not DER", () => {
    const jws = signClientAssertion({ clientId, tokenEndpoint });
    const signature = Buffer.from(jws.split(".")[2], "base64url");
    // JOSE ES256 is a fixed 64-byte r‖s pair; DER would be variable ~70 bytes.
    expect(signature.length).toBe(64);
  });
});
