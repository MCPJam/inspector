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

import type { Context } from "hono";
import { createAuthorizedManager, callerContextFromHono } from "../auth.js";
import { WebRouteError } from "../errors.js";

// Faithful Hono Context stub: `get`, `var`, and `set` all read/write the same
// store (in real Hono `c.get(k)` === `c.var[k]`). The delegated-auth header
// builder reads `c.get("authMethod")`, so the mock must implement `get`.
const mockVars: Record<string, unknown> = { requestLogContext: undefined };
const mockContext = {
  var: mockVars,
  get: (key: string) => mockVars[key],
  set: vi.fn((key: string, value: unknown) => {
    mockVars[key] = value;
  }),
} as unknown as Context;

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

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
        callerContextFromHono(mockContext),
        "bearer-token",
        "project-1",
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
              accessLevel: "project_member",
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
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000,
      {
        "server-1": "request-token",
      }
    );

    expect(result.oauthServerUrls).toEqual({
      "server-1": "https://server-1.example.com/mcp",
    });
    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config.onUnauthorized).toBeUndefined();
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

  it("attaches hosted OAuth onUnauthorized and force-refreshes through Convex", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = fetchUrl(input);
      if (url.endsWith("/web/authorize-batch")) {
        return new Response(
          JSON.stringify({
            results: {
              "server-1": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                oauthAccessToken: "old-hosted-token",
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
      }

      expect(url).toBe("https://example.convex.site/web/oauth/force-refresh");
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer bearer-token",
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        projectId: "project-1",
        serverId: "server-1",
      });
      return new Response(
        JSON.stringify({
          success: true,
          accessToken: "new-hosted-token",
          expiresAt: null,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000
    );

    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config).toEqual(
      expect.objectContaining({
        requestInit: {
          headers: {
            Authorization: "Bearer old-hosted-token",
          },
        },
        onUnauthorized: expect.any(Function),
      })
    );

    await expect(
      config.onUnauthorized({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).resolves.toEqual({ accessToken: "new-hosted-token" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("maps invalid hosted refresh tokens to reconnect details", async () => {
    global.fetch = vi.fn(async (input) => {
      const url = fetchUrl(input);
      if (url.endsWith("/web/authorize-batch")) {
        return new Response(
          JSON.stringify({
            results: {
              "server-1": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                oauthAccessToken: "old-hosted-token",
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
      }

      return new Response(
        JSON.stringify({
          success: false,
          code: "refresh_token_invalid",
          message: "Please reconnect.",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000,
      undefined,
      undefined,
      { serverNames: ["Asana"] }
    );

    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    await expect(
      config.onUnauthorized({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).rejects.toMatchObject<WebRouteError>({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Please reconnect.",
      details: {
        oauthRequired: true,
        refreshTokenInvalid: true,
        serverId: "server-1",
        serverName: "Asana",
      },
    });
  });

  it("preserves oauthRequired error details when no token is available", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
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
        callerContextFromHono(mockContext),
        "bearer-token",
        "project-1",
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

  // Codex P2 regression: client now forwards
  // `mcpProfile.initialize.clientInfo` and `supportedProtocolVersions`
  // on every hosted route call. Verify `createAuthorizedManager`
  // threads `initializePins` into the per-server HttpServerConfig so
  // the SDK Client honors the pins on `initialize`. Without this,
  // hosted connects silently fell back to SDK defaults even when the
  // active profile pinned an explicit identity.
  it("threads mcpProfile.initialize pins into the SDK Client config", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://server-1.example.com/mcp",
                headers: {},
                useOAuth: false,
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

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000,
      undefined,
      undefined,
      {
        initializePins: {
          clientInfo: {
            name: "chatgpt",
            version: "1.0.0",
            // Forward-compat extras (e.g. SEP `title`) must survive.
            title: "ChatGPT",
          },
          supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
        },
      }
    );

    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config).toMatchObject({
      url: "https://server-1.example.com/mcp",
      clientInfo: {
        name: "chatgpt",
        version: "1.0.0",
        title: "ChatGPT",
      },
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
    });
  });

  it("omits mcpProfile.initialize pins when no profile is set", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://server-1.example.com/mcp",
                headers: {},
                useOAuth: false,
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

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000
      // No options.initializePins → SDK Client uses its hardcoded
      // `LATEST_PROTOCOL_VERSION` and default clientInfo.
    );

    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config).not.toHaveProperty("clientInfo");
    expect(config).not.toHaveProperty("supportedProtocolVersions");
  });

  // Verify the public `projectServerSchema` declares the two new
  // optional fields so Zod doesn't strip them at the route boundary.
  // The earlier shape declared neither, which is exactly what dropped
  // the wire payload before it reached toHttpConfig.
  it("projectServerSchema accepts clientInfo and supportedProtocolVersions", async () => {
    const { projectServerSchema } = await import("../auth.js");
    const parsed = projectServerSchema.parse({
      projectId: "project-1",
      serverId: "server-1",
      clientInfo: {
        name: "chatgpt",
        version: "1.0.0",
        // passthrough extras (future spec fields) must survive
        title: "ChatGPT",
      },
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
    });
    expect(parsed.clientInfo).toEqual({
      name: "chatgpt",
      version: "1.0.0",
      title: "ChatGPT",
    });
    expect(parsed.supportedProtocolVersions).toEqual([
      "2025-11-25",
      "2025-06-18",
    ]);
  });
});
