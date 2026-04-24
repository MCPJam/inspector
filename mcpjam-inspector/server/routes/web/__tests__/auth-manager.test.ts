import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mcpClientManagerMock, disconnectAllServersMock } = vi.hoisted(() => ({
  mcpClientManagerMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
    })),
  };
});

import { createAuthorizedManager } from "../auth.js";
import { WebRouteError } from "../errors.js";

describe("web auth manager batching", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("surfaces the first batch failure in input order", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-a": {
              ok: false,
              status: 403,
              code: "FORBIDDEN",
              message: "server-a failed",
            },
            "server-b": {
              ok: false,
              status: 404,
              code: "NOT_FOUND",
              message: "server-b failed",
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await expect(
      createAuthorizedManager(
        "bearer-token",
        "workspace-1",
        ["server-b", "server-a"],
        10_000
      )
    ).rejects.toMatchObject<WebRouteError>({
      status: 404,
      code: "NOT_FOUND",
      message: "server-b failed",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the request oauth token when the batch response does not include one", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "workspace_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://server-1.example.com/mcp",
                headers: { "X-Test": "yes" },
                useOAuth: true,
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    const result = await createAuthorizedManager(
      "bearer-token",
      "workspace-1",
      ["server-1"],
      10_000,
      {
        "server-1": "request-token",
      }
    );

    expect(result.oauthServerUrls).toEqual({
      "server-1": "https://server-1.example.com/mcp",
    });
    expect(mcpClientManagerMock).toHaveBeenCalledWith(
      {
        "server-1": expect.objectContaining({
          url: "https://server-1.example.com/mcp",
          requestInit: {
            headers: {
              "X-Test": "yes",
              Authorization: "Bearer request-token",
            },
          },
        }),
      },
      expect.any(Object)
    );
  });

  it("preserves oauthRequired error details when no token is available", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "workspace_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://server-1.example.com/mcp",
                headers: {},
                useOAuth: true,
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await expect(
      createAuthorizedManager(
        "bearer-token",
        "workspace-1",
        ["server-1"],
        10_000,
        undefined,
        undefined,
        {
          serverNames: ["Asana"],
        }
      )
    ).rejects.toMatchObject<WebRouteError>({
      status: 401,
      code: "UNAUTHORIZED",
      message:
        'Server "Asana" requires OAuth authentication. Please complete the OAuth flow first.',
      details: {
        oauthRequired: true,
        serverId: "server-1",
        serverName: "Asana",
        serverUrl: "https://server-1.example.com/mcp",
      },
    });
  });
});
