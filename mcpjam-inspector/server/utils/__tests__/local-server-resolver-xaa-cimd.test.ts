import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { localProvider, mintXaaAccessTokenMock, buildXaaMintArgsMock } = vi.hoisted(() => ({
  localProvider: {
    getClientIdMetadataUrl: vi.fn(() => "https://app.mcpjam.com/cimd/local"),
    signClientAssertion: vi.fn(() => "local-client-assertion"),
  },
  mintXaaAccessTokenMock: vi.fn(async () => ({
    accessToken: "minted-local-token",
    tokenEndpoint: "https://auth.example.com/token",
  })),
  buildXaaMintArgsMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    getLocalConfidentialCimdProvider: vi.fn(() => localProvider),
  };
});

vi.mock("../../services/xaa-mint.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../services/xaa-mint.js")
  >();
  return {
    ...actual,
    mintXaaAccessToken: mintXaaAccessTokenMock,
    buildXaaMintArgs: buildXaaMintArgsMock.mockImplementation(
      actual.buildXaaMintArgs
    ),
  };
});

import { resolveLocalServerForConnect } from "../local-server-resolver.js";

const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
const context = {
  req: { url: "http://localhost:6274/api/mcp/connect" },
  set: vi.fn(),
  get: vi.fn(() => undefined),
} as any;

function authorizeResponse(
  serverConfig: Record<string, unknown>,
  context: { organizationId?: unknown; isAnonymous?: unknown } = {}
) {
  return new Response(
    JSON.stringify({
      ...context,
      results: {
        "server-1": {
          ok: true,
          role: "owner",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "http",
            url: "https://resource.example.com/mcp",
            authMethod: "xaa",
            useXaa: true,
            useOAuth: false,
            ...serverConfig,
          },
          oauthAccessToken: null,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("resolveLocalServerForConnect XAA CIMD", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    mintXaaAccessTokenMock.mockClear();
    buildXaaMintArgsMock.mockClear();
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    vi.unstubAllGlobals();
  });

  it("uses the local confidential provider and reuses the same mint args for a 401 remint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        authorizeResponse(
          {
            registrationMode: "cimd",
            xaaClientAuth: "private_key_jwt",
          },
          {
            organizationId: "org-1",
            isAnonymous: false,
          }
        )
      )
    );

    const resolved: any = await resolveLocalServerForConnect(
      context,
      "local-bearer",
      "project-1",
      "server-1"
    );

    expect(mintXaaAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationMode: "cimd",
        xaaClientAuth: "private_key_jwt",
        confidentialCimdProvider: localProvider,
      })
    );
    expect(buildXaaMintArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        isAnonymous: false,
      })
    );
    expect(resolved.config.requestInit.headers.Authorization).toBe(
      "Bearer minted-local-token"
    );

    await expect(resolved.config.onUnauthorized()).resolves.toEqual({
      accessToken: "minted-local-token",
    });
    expect(mintXaaAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(mintXaaAccessTokenMock.mock.calls[1]?.[0]).toBe(
      mintXaaAccessTokenMock.mock.calls[0]?.[0]
    );
  });

  it("rejects DCR before minting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => authorizeResponse({ registrationMode: "dcr" }))
    );

    await expect(
      resolveLocalServerForConnect(
        context,
        "local-bearer",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({ status: 400, code: "FEATURE_NOT_SUPPORTED" });
    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });
});
