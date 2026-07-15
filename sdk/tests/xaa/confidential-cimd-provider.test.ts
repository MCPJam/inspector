import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  buildXaaJwtBearerRequest,
  getLocalConfidentialCimdProvider,
  type ConfidentialCimdProvider,
} from "../../src/xaa/confidential-cimd-provider.js";
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
});
