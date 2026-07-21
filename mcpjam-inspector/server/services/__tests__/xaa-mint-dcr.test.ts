import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeProxyMock, fetchMetadataMock, issueIdJagMock } = vi.hoisted(
  () => ({
    executeProxyMock: vi.fn(),
    fetchMetadataMock: vi.fn(),
    issueIdJagMock: vi.fn(() => ({ token: "signed-id-jag" })),
  })
);

vi.mock("../../utils/oauth-proxy.js", () => ({
  executeOAuthProxy: (...args: unknown[]) => executeProxyMock(...args),
  fetchOAuthMetadata: (...args: unknown[]) => fetchMetadataMock(...args),
  validateUrl: vi.fn(async (url: string) => ({ url })),
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return { ...actual, issueIdJag: issueIdJagMock };
});

import {
  discoverServerTargetTokenEndpoint,
  mintXaaAccessToken,
} from "../xaa-mint.js";

const discoveryMetadata = {
  issuer: "https://as.example",
  token_endpoint: "https://as.example/token",
  registration_endpoint: "https://as.example/register",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
};

beforeEach(() => {
  executeProxyMock.mockReset();
  fetchMetadataMock.mockReset();
  issueIdJagMock.mockClear();
  fetchMetadataMock.mockResolvedValue({ metadata: discoveryMetadata });
  executeProxyMock.mockResolvedValue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { access_token: "resource-token" },
  });
});

describe("XAA Connect DCR mint integration", () => {
  it("resolves the authorized target, ensures DCR, and uses its auth method", async () => {
    const resolveServerSecret = vi.fn();
    const resolveDcrTarget = vi.fn().mockResolvedValue({
      serverUrl: "https://resource.example/mcp",
      xaaAuthzIssuer: "https://as.example",
      xaaAllowPathScopedIssuer: false,
    });
    const ensureDcrRegistration = vi.fn().mockResolvedValue({
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
    });

    await expect(
      mintXaaAccessToken({
        resolveServerSecret,
        resolveDcrTarget,
        ensureDcrRegistration,
        registrationMode: "dcr",
        httpsOnly: true,
        issuer: "https://inspector.example/api/web/xaa",
        serverId: "server-1",
        projectId: "project-1",
        bearerToken: "user-bearer",
        subject: "user-1",
        email: "user@example.com",
        scope: "read",
      })
    ).resolves.toEqual({
      accessToken: "resource-token",
      tokenEndpoint: "https://as.example/token",
    });

    expect(resolveServerSecret).not.toHaveBeenCalled();
    expect(resolveDcrTarget).toHaveBeenCalledTimes(1);
    expect(ensureDcrRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://resource.example/mcp",
        registrationEndpoint: "https://as.example/register",
        issuer: "https://as.example",
        scope: "read",
      })
    );
    const tokenRequest = executeProxyMock.mock.calls[0]?.[0];
    expect(tokenRequest.headers.Authorization).toMatch(/^Basic /);
    expect(tokenRequest.body.client_secret).toBeUndefined();
    expect(tokenRequest.body.client_id).toBeUndefined();
    expect(tokenRequest.body.assertion).toBe("signed-id-jag");
  });

  it("keeps auto on the preregistered path and never invokes DCR", async () => {
    const ensureDcrRegistration = vi.fn();
    const resolveDcrTarget = vi.fn();
    const resolveServerSecret = vi.fn().mockResolvedValue({
      serverUrl: "https://resource.example/mcp",
      xaaAuthzIssuer: "https://as.example",
      xaaAllowPathScopedIssuer: false,
      clientId: "stored-client",
      clientSecret: "stored-secret",
    });

    await mintXaaAccessToken({
      resolveServerSecret,
      resolveDcrTarget,
      ensureDcrRegistration,
      registrationMode: "auto",
      httpsOnly: true,
      issuer: "https://inspector.example/api/web/xaa",
      serverId: "server-1",
      projectId: "project-1",
      bearerToken: "user-bearer",
      subject: "user-1",
    });
    expect(resolveServerSecret).toHaveBeenCalledTimes(1);
    expect(resolveDcrTarget).not.toHaveBeenCalled();
    expect(ensureDcrRegistration).not.toHaveBeenCalled();
  });

  it("redacts a DCR client secret echoed by a token endpoint error", async () => {
    executeProxyMock.mockResolvedValue({
      status: 401,
      headers: { "content-type": "application/json" },
      body: {
        error: "invalid_client",
        error_description: "rejected dcr-secret-value",
      },
    });
    let caught: unknown;
    try {
      await mintXaaAccessToken({
        resolveServerSecret: vi.fn(),
        resolveDcrTarget: vi.fn().mockResolvedValue({
          serverUrl: "https://resource.example/mcp",
          xaaAuthzIssuer: "https://as.example",
          xaaAllowPathScopedIssuer: false,
        }),
        ensureDcrRegistration: vi.fn().mockResolvedValue({
          clientId: "dcr-client",
          clientSecret: "dcr-secret-value",
          tokenEndpointAuthMethod: "client_secret_post",
        }),
        registrationMode: "dcr",
        httpsOnly: true,
        issuer: "https://inspector.example/api/web/xaa",
        serverId: "server-1",
        projectId: "project-1",
        bearerToken: "user-bearer",
        subject: "user-1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(JSON.stringify(caught)).not.toContain("dcr-secret-value");
    expect((caught as Error).message).toContain("[REDACTED]");
  });

  it("rejects an off-origin registration endpoint under path-scoped relaxation", async () => {
    fetchMetadataMock.mockResolvedValue({
      metadata: {
        ...discoveryMetadata,
        issuer: "https://as.example",
        token_endpoint: "https://as.example/tenant/token",
        registration_endpoint: "https://evil.example/register",
      },
    });

    await expect(
      discoverServerTargetTokenEndpoint(
        {
          resource: "https://as.example/tenant/resource",
          explicitIssuer: "https://as.example/tenant",
          allowPathScopedIssuer: true,
        },
        true
      )
    ).rejects.toThrow(/registration endpoint.*different origin/i);
  });
});
