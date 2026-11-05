// The capture policy in xaa-connect-error.ts keys on the marker the mint puts
// in `details.authorizationServer`. These tests drive the real mint so a
// renamed or dropped marker fails here instead of silently sending refusals
// back to the paging rule.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeProxyMock, fetchMetadataMock, issueIdJagMock } = vi.hoisted(
  () => ({
    executeProxyMock: vi.fn(),
    fetchMetadataMock: vi.fn(),
    issueIdJagMock: vi.fn(() => ({ token: "signed-id-jag" })),
  }),
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

import { mintXaaAccessToken } from "../xaa-mint.js";
import { ErrorCode } from "../../routes/web/errors.js";

const discoveryMetadata = {
  issuer: "https://as.example",
  token_endpoint: "https://as.example/token",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
};

function mint() {
  return mintXaaAccessToken({
    resolveServerSecret: vi.fn().mockResolvedValue({
      serverUrl: "https://resource.example/mcp",
      xaaAuthzIssuer: "https://as.example",
      xaaAllowPathScopedIssuer: false,
      clientId: "stored-client",
      clientSecret: "stored-secret",
      targetEnforced: true,
    }),
    resolveDcrTarget: vi.fn(),
    ensureDcrRegistration: vi.fn(),
    registrationMode: "auto",
    httpsOnly: true,
    issuer: "https://inspector.example/api/web/xaa",
    serverId: "server-1",
    projectId: "project-1",
    bearerToken: "user-bearer",
    subject: "user-1",
  });
}

beforeEach(() => {
  executeProxyMock.mockReset();
  fetchMetadataMock.mockReset();
  fetchMetadataMock.mockResolvedValue({ metadata: discoveryMetadata });
});

describe("mintXaaAccessToken refusal markers", () => {
  it("marks a token-endpoint rejection with the AS status and its RFC 6749 error code", async () => {
    executeProxyMock.mockResolvedValue({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "invalid_grant", error_description: "issuer not trusted" },
    });

    await expect(mint()).rejects.toMatchObject({
      status: 502,
      code: ErrorCode.SERVER_UNREACHABLE,
      details: {
        authorizationServer: "rejected",
        status: 400,
        oauthError: "invalid_grant",
      },
    });
  });

  it("keeps the marker and drops the code when the AS error is not an RFC 6749 code", async () => {
    executeProxyMock.mockResolvedValue({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: 'not a code "with quotes"'.padEnd(80, "x") },
    });

    const failure = await mint().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      details: { authorizationServer: "rejected", status: 400 },
    });
    expect(
      (failure as { details?: Record<string, unknown> }).details,
    ).not.toHaveProperty("oauthError");
  });

  it("marks a discovery that found no authorization server", async () => {
    fetchMetadataMock.mockResolvedValue({ error: "metadata fetch failed" });

    await expect(mint()).rejects.toMatchObject({
      status: 404,
      code: ErrorCode.NOT_FOUND,
      details: { authorizationServer: "undiscovered" },
    });
    expect(executeProxyMock).not.toHaveBeenCalled();
  });
});
