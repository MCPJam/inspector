import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  buildXaaJwtBearerRequest,
  createDerivedConfidentialCimdProviderFactory,
  getLocalConfidentialCimdProvider,
  type ConfidentialCimdProvider,
} from "../../src/xaa/confidential-cimd-provider.js";
import { deriveOrgConfidentialCimdKey } from "../../src/xaa/mint/derived-client-key.js";
import { decodeConfidentialCimdKey } from "../../src/oauth/client-identity.js";
import {
  getXaaClientJwks,
  resetXaaClientKeyPairForTests,
} from "../../src/xaa/mint/client-keypair.js";

describe("confidential CIMD provider", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalClientPrivateKey = process.env.XAA_CLIENT_PRIVATE_KEY;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-client-provider-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    delete process.env.XAA_CLIENT_PRIVATE_KEY;
    resetXaaClientKeyPairForTests();
  });

  afterEach(() => {
    resetXaaClientKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    if (originalClientPrivateKey === undefined)
      delete process.env.XAA_CLIENT_PRIVATE_KEY;
    else process.env.XAA_CLIENT_PRIVATE_KEY = originalClientPrivateKey;
  });

  it("derives the client metadata URL from the same key it owns", () => {
    const url = getLocalConfidentialCimdProvider().getClientIdMetadataUrl(
      "https://inspector.example.com"
    );
    const encoded = new URL(url).pathname.split("/").pop();

    expect(encoded).toBeTruthy();
    expect(decodeConfidentialCimdKey(encoded!)).toMatchObject({
      x: getXaaClientJwks().keys[0].x,
      y: getXaaClientJwks().keys[0].y,
    });
  });

  it("delegates private_key_jwt signing to the injected provider", () => {
    const provider: ConfidentialCimdProvider = {
      getClientIdMetadataUrl: vi.fn(),
      signClientAssertion: vi.fn(() => "signed.client.assertion"),
    };

    const request = buildXaaJwtBearerRequest(
      {
        assertion: "the.id.jag",
        tokenEndpoint: "https://as.example.com/token",
        clientId: "https://client.example.com/metadata.json",
        scope: "mcp.access",
        tokenEndpointAuthMethod: "private_key_jwt",
      },
      provider
    );

    expect(provider.signClientAssertion).toHaveBeenCalledWith({
      clientId: "https://client.example.com/metadata.json",
      tokenEndpoint: "https://as.example.com/token",
    });
    expect(request.body).toMatchObject({
      assertion: "the.id.jag",
      client_id: "https://client.example.com/metadata.json",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "signed.client.assertion",
    });
  });

  it("fails closed when private_key_jwt has no provider", () => {
    expect(() =>
      buildXaaJwtBearerRequest({
        assertion: "the.id.jag",
        tokenEndpoint: "https://as.example.com/token",
        clientId: "https://client.example.com/metadata.json",
        tokenEndpointAuthMethod: "private_key_jwt",
      })
    ).toThrow(/no confidential CIMD provider/);
  });

  it("derives a stable, org-bound confidential client with a fixed test vector", () => {
    const master = Buffer.alloc(32, 7);
    const derived = deriveOrgConfidentialCimdKey(master, "org_abc123");
    expect(derived.publicJwk).toMatchObject({
      kty: "EC",
      crv: "P-256",
      x: "2aR08xQYfSSnrVVkLPnuEtXRJI0Hjvj9qWMjfz6Ka6Y",
      y: "rIRb4HDKj-bFtzrZquMyQj43BOagS8jyggiCALGxKx0",
      kid: "xaa-client-1",
      alg: "ES256",
      use: "sig",
    });
    expect(deriveOrgConfidentialCimdKey(master, "org_abc123").publicJwk).toEqual(
      derived.publicJwk,
    );
    expect(deriveOrgConfidentialCimdKey(master, "org_other").publicJwk).not.toEqual(
      derived.publicJwk,
    );
    expect(
      deriveOrgConfidentialCimdKey(Buffer.alloc(32, 8), "org_abc123").publicJwk,
    ).not.toEqual(derived.publicJwk);
  });

  it("signs only for its derived client_id", () => {
    const provider = createDerivedConfidentialCimdProviderFactory(
      Buffer.alloc(32, 9),
    )("org_abc123");
    const clientId = provider.getClientIdMetadataUrl();
    const tokenEndpoint = "https://auth.example.com/token";
    const assertion = provider.signClientAssertion({ clientId, tokenEndpoint });
    const [header, payload, signature] = assertion.split(".");
    const encoded = new URL(clientId).pathname.split("/").pop();
    const publicJwk = decodeConfidentialCimdKey(encoded!);

    expect(publicJwk).not.toBeNull();
    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: createPublicKey({ key: publicJwk!, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(() =>
      provider.signClientAssertion({
        clientId: "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/other",
        tokenEndpoint,
      }),
    ).toThrow(/organization-bound/);
  });

  it("rejects malformed derived-key master material", () => {
    expect(() => createDerivedConfidentialCimdProviderFactory(Buffer.alloc(31))).toThrow(
      /32 bytes/,
    );
  });
});
