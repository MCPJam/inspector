import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mcpClientManagerMock, disconnectAllServersMock, localRefreshMock } =
  vi.hoisted(() => ({
    mcpClientManagerMock: vi.fn(),
    disconnectAllServersMock: vi.fn(),
    localRefreshMock: vi.fn(),
  }));

// The authorization-server round trip belongs to local-oauth-refresh's own
// tests; here it is mocked so these are about the connect path.
vi.mock("../../../utils/local-oauth-refresh.js", () => ({
  refreshTokensAgainstPrivateAuthorizationServer: localRefreshMock,
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
import { __resetPrivateAuthorizationServerMaterialCacheForTests } from "../../../utils/hosted-oauth-refresh.js";

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
    __resetPrivateAuthorizationServerMaterialCacheForTests();
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

  it("diverts stdio servers to the local resolver in local mode (mixed batch)", async () => {
    // This suite runs with HOSTED_MODE unset (local). The hosted authorize
    // batch answers for BOTH servers but strips the stdio row's
    // command/args/env by contract; the divert re-reads that one server
    // through /web/authorize-batch-local with the same bearer and builds a
    // spawnable stdio config, while the http sibling stays on the hosted
    // mint path untouched.
    //
    // Captured, not asserted inside the mock: `authorizeBatchLocal` wraps any
    // throw from fetch (including a failed expect) into a 502 WebRouteError,
    // which would surface as a misleading transport error.
    let localInit: RequestInit | undefined;
    global.fetch = vi.fn(async (input, init) => {
      const url = fetchUrl(input);
      if (url.endsWith("/web/authorize-batch")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-http": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://srv-http.example.com/mcp",
                  headers: { "X-Test": "yes" },
                },
              },
              "srv-stdio": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "stdio",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/authorize-batch-local")) {
        localInit = init;
        return new Response(
          JSON.stringify({
            results: {
              "srv-stdio": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "stdio",
                  command: "node",
                  args: ["plugin-server.js"],
                  env: { FOO: "bar" },
                  cwd: "/srv/plugin-root",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["srv-http", "srv-stdio"],
      10_000
    );

    expect((localInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer bearer-token"
    );
    expect(JSON.parse(localInit?.body as string)).toEqual({
      projectId: "project-1",
      serverIds: ["srv-stdio"],
    });
    expect(mcpClientManagerMock).toHaveBeenCalledWith(
      {
        "srv-http": expect.objectContaining({
          url: "https://srv-http.example.com/mcp",
        }),
        "srv-stdio": expect.objectContaining({
          command: "node",
          args: ["plugin-server.js"],
          env: { FOO: "bar" },
          cwd: "/srv/plugin-root",
          timeout: 10_000,
        }),
      },
      expect.any(Object)
    );
  });

  // Codex P2 regression: the harness proxy authenticates via WorkOS API key
  // and deliberately passes an EMPTY bearer — the caller context carries the
  // service-token + acting-as exchange instead. The stdio divert's local
  // reread must forward that delegated identity, not send `Bearer ` verbatim
  // (which failed every local harness turn against a stdio server).
  it("diverts stdio with the delegated exchange when the caller used a WorkOS API key", async () => {
    const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    mockVars.authMethod = "workos_api_key";
    mockVars.workosUserId = "user_workos_1";
    mockVars.mcpjamOrganizationId = "org_1";

    let hostedInit: RequestInit | undefined;
    let localInit: RequestInit | undefined;
    global.fetch = vi.fn(async (input, init) => {
      const url = fetchUrl(input);
      if (url.endsWith("/web/authorize-batch")) {
        hostedInit = init;
        return new Response(
          JSON.stringify({
            results: {
              "srv-stdio": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: { transportType: "stdio" },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/authorize-batch-local")) {
        localInit = init;
        return new Response(
          JSON.stringify({
            results: {
              "srv-stdio": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "stdio",
                  command: "node",
                  args: ["server.js"],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      await createAuthorizedManager(
        callerContextFromHono(mockContext),
        "", // bearer ignored on the workos_api_key path (harness proxy)
        "project-1",
        ["srv-stdio"],
        10_000
      );

      // Both the hosted batch and the local reread ride the same exchange.
      for (const init of [hostedInit, localInit]) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer service-token");
        expect(headers["x-mcpjam-acting-as"]).toBe("user_workos_1");
        expect(headers["x-mcpjam-acting-in-org"]).toBe("org_1");
      }
    } finally {
      delete mockVars.authMethod;
      delete mockVars.workosUserId;
      delete mockVars.mcpjamOrganizationId;
      if (originalServiceToken === undefined) {
        delete process.env.INSPECTOR_SERVICE_TOKEN;
      } else {
        process.env.INSPECTOR_SERVICE_TOKEN = originalServiceToken;
      }
    }
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
        // This builder is shared with the hosted /web routes, but in LOCAL
        // mode this process is the one that can reach a private authorization
        // server — so it declares that, exactly as the /api/mcp resolver does.
        // Without it, every surface routed through createAuthorizedManager
        // (chat-v2, evals, environments, swarm runs, harness-mcp) still died
        // at the first token expiry against a localhost OAuth server.
        localRuntime: true,
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

  it("recovers a private-authorization-server credential BEFORE connecting", async () => {
    // The batch cannot return a token — the backend structurally cannot refresh
    // an authorization server on the user's machine — so it reports why. Without
    // this pre-connect pass the fallback only ever covered a mid-session 401,
    // and the FIRST connect after expiry failed with "requires OAuth
    // authentication. Please complete the OAuth flow first", to a user who had.
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
                // No token, and the reason it is missing.
                oauthUnavailableReason: "private_authorization_server",
                serverConfig: {
                  transportType: "http",
                  url: "http://localhost:8000/mcp",
                  headers: {},
                  useOAuth: true,
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        expect(JSON.parse(init?.body as string).localRuntime).toBe(true);
        return new Response(
          JSON.stringify({
            success: false,
            code: "private_authorization_server",
            message: "Authorization server is on a private address.",
            refresh: {
              authorizationServerUrl: "http://localhost:9000",
              serverUrl: "http://localhost:8000/mcp",
              oauthResourceUrl: "http://localhost:8000",
              clientId: "client-1",
              refreshToken: "stored-refresh-token",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/oauth/import-tokens")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    localRefreshMock.mockResolvedValue({
      access_token: "locally-refreshed",
      token_type: "Bearer",
    });

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000
    );

    // The connect carries the locally-minted token, and the live-401 handler is
    // attached even though the batch returned none.
    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config).toEqual(
      expect.objectContaining({
        requestInit: {
          headers: { Authorization: "Bearer locally-refreshed" },
        },
        onUnauthorized: expect.any(Function),
      })
    );
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

  it("connects a tokenless auto (discover) server unauthenticated and tags a live 401", async () => {
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
                authMethod: "auto",
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

    // No pre-connect throw: discover attempts the server without credentials.
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
    expect(config.requestInit?.headers?.Authorization).toBeUndefined();
    // A live 401 converts into the tagged oauthRequired shape via the
    // discover onUnauthorized handler.
    await expect(
      config.onUnauthorized({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).rejects.toMatchObject<WebRouteError>({
      status: 401,
      code: "UNAUTHORIZED",
      message: 'Server "Asana" requires authorization.',
      details: {
        oauthRequired: true,
        serverId: "server-1",
        serverName: "Asana",
        serverUrl: "https://server-1.example.com/mcp",
      },
    });
  });

  it("keeps the oauth path for an auto (discover) server whose batch returned a token", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-1": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              oauthAccessToken: "stored-token",
              serverConfig: {
                transportType: "http",
                url: "https://server-1.example.com/mcp",
                headers: {},
                authMethod: "auto",
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
      { serverNames: ["Asana"] }
    );

    const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
    expect(config.requestInit?.headers?.Authorization).toBe(
      "Bearer stored-token"
    );
    // Stored-token rung: the refresh handler is attached, not the tagging one.
    expect(typeof config.onUnauthorized).toBe("function");
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

  // CONTRACT: the swarm runner threads each pinned server's
  // `requestTimeoutOverride` through `options.requestTimeoutByServerId`. Each
  // server's connection `timeout` must reflect ITS pin (falling back to the
  // host-level timeout when absent) — before the fix every server got the
  // single host-level timeout uniformly.
  it("applies per-server requestTimeoutByServerId overrides to each connection", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: {
            "server-fast": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://fast.example.com/mcp",
                headers: {},
                useOAuth: false,
              },
            },
            "server-default": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://default.example.com/mcp",
                headers: {},
                useOAuth: false,
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-fast", "server-default"],
      10_000,
      undefined,
      undefined,
      {
        accessScope: "project_member",
        // Only server-fast is pinned; server-default falls back to 10_000.
        requestTimeoutByServerId: { "server-fast": 3_000 },
      }
    );

    const configs = mcpClientManagerMock.mock.calls[0]?.[0] as Record<
      string,
      { timeout: number }
    >;
    expect(configs["server-fast"]!.timeout).toBe(3_000);
    expect(configs["server-default"]!.timeout).toBe(10_000);

    // Manager-level defaultTimeout stays the host-level timeout.
    const managerOpts = mcpClientManagerMock.mock.calls[0]?.[1] as {
      defaultTimeout: number;
    };
    expect(managerOpts.defaultTimeout).toBe(10_000);
  });
});
