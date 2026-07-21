import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  createDerivedConfidentialCimdProviderFactory,
  decodeConfidentialCimdKey,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  type ConfidentialCimdProvider,
} from "@mcpjam/sdk";

const { executeOAuthProxyMock, fetchOAuthMetadataMock, loggerErrorMock } =
  vi.hoisted(() => ({
    executeOAuthProxyMock: vi.fn(),
    fetchOAuthMetadataMock: vi.fn(),
    loggerErrorMock: vi.fn(),
  }));

vi.mock("../../utils/logger.js", () => ({
  logger: { error: loggerErrorMock },
}));

vi.mock("../../utils/oauth-proxy.js", () => ({
  executeOAuthProxy: executeOAuthProxyMock,
  fetchOAuthMetadata: fetchOAuthMetadataMock,
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    issueIdJag: vi.fn(() => ({ token: "signed-id-jag" })),
  };
});

import { mintXaaAccessToken } from "../xaa-mint.js";

const baseArgs = {
  httpsOnly: true,
  issuer: "https://app.mcpjam.com/api/web/xaa/o/org-1",
  serverId: "server-1",
  projectId: "project-1",
  bearerToken: "bearer-1",
  resource: "https://mcp.example.com/mcp",
  explicitIssuer: "https://auth.example.com",
  subject: "user-1",
};

function advertiseCimd(supported = true) {
  fetchOAuthMetadataMock.mockResolvedValue({
    metadata: {
      issuer: "https://auth.example.com",
      token_endpoint: "https://auth.example.com/token",
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      client_id_metadata_document_supported: supported,
    },
  });
}

describe("mintXaaAccessToken Connect client identity", () => {
  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
    loggerErrorMock.mockReset();
    executeOAuthProxyMock.mockResolvedValue({
      status: 200,
      body: { access_token: "access-1" },
    });
    advertiseCimd();
  });

  it("preserves the preregistered client-secret-post request", async () => {
    const resolveServerSecret = vi.fn().mockResolvedValue({
      serverUrl: baseArgs.resource,
      xaaAuthzIssuer: baseArgs.explicitIssuer,
      clientId: "client-1",
      clientSecret: "secret-1",
    });

    await mintXaaAccessToken({
      ...baseArgs,
      registrationMode: "preregistered",
      resolveServerSecret,
    });

    expect(resolveServerSecret).toHaveBeenCalledTimes(1);
    expect(executeOAuthProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          client_id: "client-1",
          client_secret: "secret-1",
          assertion: "signed-id-jag",
        }),
      })
    );
  });

  it("uses public CIMD without resolving or sending a stored secret", async () => {
    const resolveServerSecret = vi.fn();

    await mintXaaAccessToken({
      ...baseArgs,
      registrationMode: "cimd",
      xaaClientAuth: "none",
      resolveServerSecret,
    });

    expect(resolveServerSecret).not.toHaveBeenCalled();
    const request = executeOAuthProxyMock.mock.calls[0][0];
    expect(request.body.client_id).toBe(XAA_DEBUG_CLIENT_ID_METADATA_URL);
    expect(request.body.client_secret).toBeUndefined();
    expect(request.body.client_assertion).toBeUndefined();
  });

  it("uses the bound provider for confidential CIMD without resolving a secret", async () => {
    const resolveServerSecret = vi.fn();
    const provider: ConfidentialCimdProvider = {
      getClientIdMetadataUrl: vi.fn(() => "https://app.mcpjam.com/cimd/key-1"),
      signClientAssertion: vi.fn(() => "client-assertion-1"),
    };

    await mintXaaAccessToken({
      ...baseArgs,
      registrationMode: "cimd",
      xaaClientAuth: "private_key_jwt",
      confidentialCimdProvider: provider,
      resolveServerSecret,
    });

    expect(resolveServerSecret).not.toHaveBeenCalled();
    expect(provider.signClientAssertion).toHaveBeenCalledWith({
      clientId: "https://app.mcpjam.com/cimd/key-1",
      tokenEndpoint: "https://auth.example.com/token",
    });
    expect(executeOAuthProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          client_id: "https://app.mcpjam.com/cimd/key-1",
          client_assertion: "client-assertion-1",
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        }),
      })
    );
  });

  it("emits a confidential client assertion verifiable by the reflected public key", async () => {
    const provider = createDerivedConfidentialCimdProviderFactory(
      Buffer.alloc(32, 7),
    )("org-1");

    await mintXaaAccessToken({
      ...baseArgs,
      registrationMode: "cimd",
      xaaClientAuth: "private_key_jwt",
      confidentialCimdProvider: provider,
    });

    const request = executeOAuthProxyMock.mock.calls[0][0];
    const assertion = request.body.client_assertion as string;
    const clientId = request.body.client_id as string;
    const [header, payload, signature] = assertion.split(".");
    const encodedJwk = new URL(clientId).pathname.split("/").pop();
    const publicJwk = decodeConfidentialCimdKey(encodedJwk!);

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
  });

  it("fails closed when confidential CIMD is selected without a provider", async () => {
    const resolveServerSecret = vi.fn();

    await expect(
      mintXaaAccessToken({
        ...baseArgs,
        registrationMode: "cimd",
        xaaClientAuth: "private_key_jwt",
        resolveServerSecret,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(resolveServerSecret).not.toHaveBeenCalled();
    expect(executeOAuthProxyMock).not.toHaveBeenCalled();
  });

  it("reports the client-ID failure once and preserves it as the generic error cause", async () => {
    const underlying = new Error("private key import failed");
    const provider: ConfidentialCimdProvider = {
      getClientIdMetadataUrl: vi.fn(() => {
        throw underlying;
      }),
      signClientAssertion: vi.fn(),
    };

    await expect(
      mintXaaAccessToken({
        ...baseArgs,
        registrationMode: "cimd",
        xaaClientAuth: "private_key_jwt",
        confidentialCimdProvider: provider,
      })
    ).rejects.toMatchObject({
      status: 500,
      message: "Could not prepare the confidential CIMD client identity",
      cause: underlying,
    });

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("client identity resolution failed"),
      underlying,
      expect.objectContaining({
        serverId: "server-1",
        projectId: "project-1",
        resource: "https://mcp.example.com/mcp",
      })
    );
  });

  it("reports the signing failure once and preserves it as the generic error cause", async () => {
    const underlying = new Error("signing service unavailable");
    const provider: ConfidentialCimdProvider = {
      getClientIdMetadataUrl: vi.fn(() => "https://app.mcpjam.com/cimd/key-1"),
      signClientAssertion: vi.fn(() => {
        throw underlying;
      }),
    };

    await expect(
      mintXaaAccessToken({
        ...baseArgs,
        registrationMode: "cimd",
        xaaClientAuth: "private_key_jwt",
        confidentialCimdProvider: provider,
      })
    ).rejects.toMatchObject({
      status: 500,
      message: "Could not sign the confidential CIMD token request",
      cause: underlying,
    });

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("assertion signing failed"),
      underlying,
      expect.objectContaining({
        serverId: "server-1",
        projectId: "project-1",
        clientId: "https://app.mcpjam.com/cimd/key-1",
      })
    );
  });

  it("fails before exchange when the authorization server does not advertise CIMD", async () => {
    advertiseCimd(false);

    await expect(
      mintXaaAccessToken({
        ...baseArgs,
        registrationMode: "cimd",
        xaaClientAuth: "none",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(executeOAuthProxyMock).not.toHaveBeenCalled();
  });

  it("rejects DCR before secret resolution, discovery, or exchange", async () => {
    const resolveServerSecret = vi.fn();

    await expect(
      mintXaaAccessToken({
        ...baseArgs,
        registrationMode: "dcr",
        resolveServerSecret,
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(resolveServerSecret).not.toHaveBeenCalled();
    expect(fetchOAuthMetadataMock).not.toHaveBeenCalled();
    expect(executeOAuthProxyMock).not.toHaveBeenCalled();
  });
});
