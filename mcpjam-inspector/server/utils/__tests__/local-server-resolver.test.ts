import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeBatchLocal,
  executeLocalServerConnect,
  parseConnectionDefaults,
  resolveLocalServerForConnect,
  resolveLocalStdioServerConfig,
  toMCPServerConfig,
} from "../local-server-resolver.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("authorizeBatchLocal actor metadata parsing", () => {
  const context = { set: vi.fn(), get: vi.fn(() => undefined) } as any;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it.each([
    [true, true],
    [false, false],
    ["false", undefined],
    [null, undefined],
  ])("parses isAnonymous=%j as %j", async (raw, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ isAnonymous: raw, results: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    await expect(
      authorizeBatchLocal(context, "bearer", "project-1", [])
    ).resolves.toMatchObject({ isAnonymous: expected });
  });
});

const httpHostedOAuthAuth = {
  ok: true as const,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig: {
    transportType: "http" as const,
    url: "https://hosted-oauth.example.com/mcp",
    headers: { "X-Convex-Stored": "yes" },
    useOAuth: true,
  },
  oauthAccessToken: "old-hosted-token",
};

const httpHeaderOnlyAuth = {
  ok: true as const,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig: {
    transportType: "http" as const,
    url: "https://header-only.example.com/mcp",
    headers: { Authorization: "Bearer static-token" },
    useOAuth: false,
  },
};

const stdioAuth = {
  ok: true as const,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig: {
    transportType: "stdio" as const,
    command: "node",
    args: ["server.js"],
    env: { FOO: "bar" },
  },
};

describe("toMCPServerConfig — onUnauthorized wiring", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it("attaches onUnauthorized for hosted-OAuth HTTP servers when refreshContext is supplied", () => {
    const config: any = toMCPServerConfig(httpHostedOAuthAuth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
        serverName: "Asana",
      },
    });

    expect(config.onUnauthorized).toEqual(expect.any(Function));
    expect(config.requestInit.headers).toMatchObject({
      "X-Convex-Stored": "yes",
      Authorization: "Bearer old-hosted-token",
    });
  });

  it("does not attach onUnauthorized when no refreshContext is supplied", () => {
    const config: any = toMCPServerConfig(httpHostedOAuthAuth);
    expect(config.onUnauthorized).toBeUndefined();
  });

  it("does not attach onUnauthorized for header-auth-only HTTP servers", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-2",
        serverName: "Header Server",
      },
    });
    expect(config.onUnauthorized).toBeUndefined();
  });

  it("does not attach onUnauthorized for stdio servers", () => {
    const config: any = toMCPServerConfig(stdioAuth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-3",
        serverName: "Stdio Server",
      },
    });
    expect(config.onUnauthorized).toBeUndefined();
  });

  it("does not attach onUnauthorized when useOAuth is true but no oauthAccessToken is present", () => {
    const auth = {
      ...httpHostedOAuthAuth,
      oauthAccessToken: null,
    };
    const config: any = toMCPServerConfig(auth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
        serverName: "Asana",
      },
    });
    expect(config.onUnauthorized).toBeUndefined();
  });

  it("attached handler POSTs to /web/oauth/force-refresh and returns the new token", async () => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      expect(String(input)).toBe(
        "https://example.convex.site/web/oauth/force-refresh"
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer bearer-token",
      });
      expect(JSON.parse(init?.body)).toEqual({
        projectId: "project-1",
        serverId: "server-1",
        // The local resolver runs on the user's own machine, so it declares
        // that — which is what lets the backend hand back the material to
        // refresh an authorization server it cannot reach itself.
        localRuntime: true,
      });
      return new Response(JSON.stringify({ accessToken: "new-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: any = toMCPServerConfig(httpHostedOAuthAuth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
        serverName: "Asana",
      },
    });

    await expect(
      config.onUnauthorized({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).resolves.toEqual({ accessToken: "new-token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces refresh_token_invalid via the attached handler with serverName", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: "refresh_token_invalid",
              message: "Please reconnect.",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const config: any = toMCPServerConfig(httpHostedOAuthAuth, {
      refreshContext: {
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
        serverName: "Asana",
      },
    });

    await expect(
      config.onUnauthorized({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      details: {
        oauthRequired: true,
        refreshTokenInvalid: true,
        serverId: "server-1",
        serverName: "Asana",
      },
    });
  });
});

describe("toMCPServerConfig — declared httpVariant mapping", () => {
  it("maps a declared sse transport to preferSSE", () => {
    const config: any = toMCPServerConfig({
      ...httpHeaderOnlyAuth,
      serverConfig: { ...httpHeaderOnlyAuth.serverConfig, httpVariant: "sse" },
    });
    expect(config.preferSSE).toBe(true);
    expect(config.disableSseFallback).toBeUndefined();
  });

  it("maps a declared streamable-http transport to disableSseFallback", () => {
    const config: any = toMCPServerConfig({
      ...httpHeaderOnlyAuth,
      serverConfig: {
        ...httpHeaderOnlyAuth.serverConfig,
        httpVariant: "streamable-http" as const,
      },
    });
    expect(config.disableSseFallback).toBe(true);
    // Explicitly false, not merely absent — see below.
    expect(config.preferSSE).toBe(false);
  });

  it("pins preferSSE false so a /sse URL cannot override the declaration", () => {
    // The SDK resolves `config.preferSSE ?? url.pathname.endsWith("/sse")`.
    // Leaving preferSSE undefined here would hand a DECLARED streamable-http
    // server straight to SSE on URL shape alone, and `disableSseFallback`
    // could not save it — it only guards the post-attempt fallback.
    const config: any = toMCPServerConfig({
      ...httpHeaderOnlyAuth,
      serverConfig: {
        ...httpHeaderOnlyAuth.serverConfig,
        url: "https://plugin.example.com/sse",
        httpVariant: "streamable-http" as const,
      },
    });
    expect(config.preferSSE).toBe(false);
    expect(config.disableSseFallback).toBe(true);
  });

  it("sets neither flag when no transport was declared", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth);
    expect(config.preferSSE).toBeUndefined();
    expect(config.disableSseFallback).toBeUndefined();
  });
});

describe("resolveLocalServerForConnect — refresh on missing access token", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  // Minimal hono-like context used by the resolver's setRequestLogContext
  // calls; we don't assert on log routing here.
  const fakeContext = { set: () => {}, get: () => undefined } as any;

  function authorizeBatchLocalResponse(payload: {
    serverId: string;
    serverConfig: {
      transportType: "http";
      url: string;
      useOAuth?: boolean;
      authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
      headers?: Record<string, string>;
      hasHeaders?: boolean;
    };
    oauthAccessToken: string | null;
  }) {
    return new Response(
      JSON.stringify({
        results: {
          [payload.serverId]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: payload.serverConfig,
            oauthAccessToken: payload.oauthAccessToken,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("calls /web/oauth/force-refresh when authorize-batch-local returns no token, and uses the refreshed token", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-1",
          serverConfig: {
            transportType: "http",
            url: "https://hosted.example.com/mcp",
            useOAuth: true,
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({ accessToken: "refreshed-token" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-1",
      { serverDisplayName: "Excalidraw" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer refreshed-token",
    });
    expect(config.onUnauthorized).toEqual(expect.any(Function));
    // Two outbound calls: authorize-batch-local, then force-refresh.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes a private authorization server itself when the backend says it cannot", async () => {
    // End to end for the localhost case: the backend structurally cannot reach
    // the authorization server, so it hands back the material and THIS process
    // — which can reach it — does the grant and stores the result.
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-local",
          serverConfig: {
            transportType: "http",
            url: "http://localhost:8001/mcp",
            useOAuth: true,
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({
            success: false,
            code: "private_authorization_server",
            message: "Authorization server is on a private address.",
            refresh: {
              authorizationServerUrl: "http://localhost:8001",
              serverUrl: "http://localhost:8001/mcp",
              oauthResourceUrl: "http://localhost:8001",
              clientId: "client-1",
              refreshToken: "stored-refresh-token",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/.well-known/")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:8001",
            authorization_endpoint: "http://localhost:8001/authorize",
            token_endpoint: "http://localhost:8001/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "http://localhost:8001/token") {
        expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe(
          "refresh_token"
        );
        return new Response(
          JSON.stringify({
            access_token: "locally-refreshed-token",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/oauth/import-tokens")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-local",
      { serverDisplayName: "Local server" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer locally-refreshed-token",
    });
    // The refreshed pair went back to the backend, so the next connect from
    // anywhere finds it.
    expect(seen.some((u) => u.endsWith("/web/oauth/import-tokens"))).toBe(true);
    expect(seen.some((u) => u === "http://localhost:8001/token")).toBe(true);
  });

  it("does NOT call force-refresh when authorize-batch-local already returned a token", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-2",
          serverConfig: {
            transportType: "http",
            url: "https://hosted.example.com/mcp",
            useOAuth: true,
          },
          oauthAccessToken: "fresh-token",
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-2",
      { serverDisplayName: "Excalidraw" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discover (tokenless auto): swallows a failed silent refresh and connects unauthenticated", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-auto",
          serverConfig: {
            transportType: "http",
            url: "https://open.example.com/mcp",
            authMethod: "auto",
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        // Never-OAuth'd server: no stored credential to refresh.
        return new Response(
          JSON.stringify({
            success: false,
            code: "refresh_token_invalid",
            message: "No hosted OAuth credential found.",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config, effectiveAuth }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-auto",
      { serverDisplayName: "Open Server" }
    );

    expect(effectiveAuth).toBe("discover");
    expect(config.requestInit.headers.Authorization).toBeUndefined();
    expect(config.onUnauthorized).toBeUndefined();
  });

  it("discover (tokenless auto): a broken refresh helper also degrades to unauthenticated, not a throw", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-auto-2",
          serverConfig: {
            transportType: "http",
            url: "https://open.example.com/mcp",
            authMethod: "auto",
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response("backend exploded", { status: 500 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config, effectiveAuth }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-auto-2",
      { serverDisplayName: "Open Server" }
    );

    expect(effectiveAuth).toBe("discover");
    expect(config.requestInit.headers.Authorization).toBeUndefined();
  });

  it("discover (auto with a stored token): rides the oauth rails with the refresh hook", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-auto-3",
          serverConfig: {
            transportType: "http",
            url: "https://hosted.example.com/mcp",
            authMethod: "auto",
          },
          oauthAccessToken: "stored-token",
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config, effectiveAuth }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-auto-3",
      { serverDisplayName: "Hosted Server" }
    );

    expect(effectiveAuth).toBe("discover");
    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer stored-token",
    });
    expect(config.onUnauthorized).toEqual(expect.any(Function));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses plaintext headers from authorize-batch-local without runtime reveal", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-headers",
          serverConfig: {
            transportType: "http",
            url: "https://header.example.com/mcp",
            useOAuth: false,
            headers: { Authorization: "Bearer static-token" },
            hasHeaders: true,
          },
          oauthAccessToken: null,
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-headers",
      { serverDisplayName: "Header Server" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer static-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reveals runtime headers only when authorize-batch-local omits them", async () => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-hidden-headers",
          serverConfig: {
            transportType: "http",
            url: "https://hidden-header.example.com/mcp",
            useOAuth: false,
            headers: {},
            hasHeaders: true,
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/server/reveal-secrets")) {
        expect(init?.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer bearer-xyz",
        });
        expect(JSON.parse(init?.body)).toMatchObject({
          purpose: "runtime",
          projectId: "proj-1",
          serverId: "srv-hidden-headers",
        });
        return new Response(
          JSON.stringify({
            success: true,
            env: null,
            headers: { Authorization: "Bearer revealed-token" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-hidden-headers",
      { serverDisplayName: "Hidden Header Server" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer revealed-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reveals runtime stdio env without a service token", async () => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-hidden-env": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "stdio",
                  command: "node",
                  args: ["server.js"],
                  env: {},
                  hasEnv: true,
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/server/reveal-secrets")) {
        expect(init?.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer bearer-xyz",
        });
        expect(JSON.parse(init?.body)).toMatchObject({
          purpose: "runtime",
          projectId: "proj-1",
          serverId: "srv-hidden-env",
        });
        return new Response(
          JSON.stringify({
            success: true,
            env: { FOO: "revealed" },
            headers: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-hidden-env",
      { serverDisplayName: "Hidden Env Server" }
    );

    expect(config.env).toMatchObject({ FOO: "revealed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws 401 with refreshTokenInvalid when force-refresh reports refresh_token_invalid", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-3",
          serverConfig: {
            transportType: "http",
            url: "https://hosted.example.com/mcp",
            useOAuth: true,
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({
            success: false,
            code: "refresh_token_invalid",
            message: "Reconnect required.",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(
        fakeContext,
        "bearer-xyz",
        "proj-1",
        "srv-3",
        { serverDisplayName: "Excalidraw" }
      )
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      details: {
        oauthRequired: true,
        refreshTokenInvalid: true,
        serverId: "srv-3",
      },
    });
  });

  it("bubbles up transient force-refresh errors instead of telling the user to reconnect", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return authorizeBatchLocalResponse({
          serverId: "srv-4",
          serverConfig: {
            transportType: "http",
            url: "https://hosted.example.com/mcp",
            useOAuth: true,
          },
          oauthAccessToken: null,
        });
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({
            success: false,
            code: "rate_limited",
            message: "Too many refresh requests.",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(
        fakeContext,
        "bearer-xyz",
        "proj-1",
        "srv-4",
        { serverDisplayName: "Excalidraw" }
      )
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});

describe("executeLocalServerConnect — live 401 handling", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  function fakeExecutorContext(managerOverrides?: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    const manager = {
      disconnectServer: vi.fn().mockResolvedValue(undefined),
      connectToServer: vi.fn().mockRejectedValue(
        Object.assign(new Error("HTTP 401 Unauthorized"), {
          statusCode: 401,
        })
      ),
      removeServer: vi.fn().mockResolvedValue(undefined),
      ...managerOverrides,
    };
    const c = {
      set: () => {},
      get: () => undefined,
      mcpClientManager: manager,
      header: (key: string, value: string) => {
        headers[key] = value;
      },
      json: (body: unknown, status?: number) => ({
        body,
        status: status ?? 200,
      }),
    } as any;
    return { c, headers, manager };
  }

  function stubAuthorizeBatch(authMethod: "auto" | "none") {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-live": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://target.example.com/mcp",
                  authMethod,
                },
                oauthAccessToken: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({
            success: false,
            code: "refresh_token_invalid",
            message: "No hosted OAuth credential found.",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  const params = {
    serverId: "srv-live",
    projectId: "proj-1",
    serverDisplayName: "Live Server",
    bearer: "bearer-xyz",
  };

  it("tags a discover 401 as oauthRequired with the X-MCP-Auth-Required header", async () => {
    stubAuthorizeBatch("auto");
    const { c, headers } = fakeExecutorContext();

    const response: any = await executeLocalServerConnect(c, params, {
      removeOnFailure: true,
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      oauthRequired: true,
      serverId: "srv-live",
      serverName: "Live Server",
    });
    expect(headers["X-MCP-Auth-Required"]).toBe("oauth");
  });

  it("returns 401 with a hint (no escalation tag) for an explicit-none server", async () => {
    stubAuthorizeBatch("none");
    const { c, headers } = fakeExecutorContext();

    const response: any = await executeLocalServerConnect(c, params, {
      removeOnFailure: true,
    });

    // Status parity with the hosted mapping (mapRuntimeError → 401), but no
    // oauthRequired: the user chose No Authentication, nothing auto-escalates.
    expect(response.status).toBe(401);
    expect(response.body.oauthRequired).toBeUndefined();
    expect(response.body.upstreamAuthRequired).toBe(true);
    expect(response.body.error).toContain(
      "Switch Authentication to Auto or OAuth"
    );
    // The header still suppresses authFetch's session/guest retries.
    expect(headers["X-MCP-Auth-Required"]).toBe("oauth");
  });

  it("keeps non-401 connect failures on the generic 500 envelope", async () => {
    stubAuthorizeBatch("auto");
    const { c, headers } = fakeExecutorContext({
      connectToServer: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9999")),
    });

    const response: any = await executeLocalServerConnect(c, params, {
      removeOnFailure: true,
    });

    expect(response.status).toBe(500);
    expect(response.body.oauthRequired).toBeUndefined();
    expect(headers["X-MCP-Auth-Required"]).toBeUndefined();
  });
});

describe("resolveLocalServerForConnect — backend-resolved XAA identity error", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  const fakeContext = { set: () => {}, get: () => undefined } as any;

  it("fails the connect with the backend's message and never mints", async () => {
    const identityError =
      "Complete or clear the server identity override: this server has a partial legacy override";
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-xaa": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://xaa.example.com/mcp",
                  headers: {},
                  useOAuth: false,
                  useXaa: true,
                  authServerMode: "mcpjam",
                  clientId: "xaa-client",
                  // Backend omitted BOTH identity members and sent the
                  // actionable error instead (legacy partial override).
                  xaaIdentityError: identityError,
                },
                oauthAccessToken: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(
        fakeContext,
        "bearer-xyz",
        "proj-1",
        "srv-xaa",
        {
          serverDisplayName: "Legacy XAA server",
        }
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      // Framed for the surface that is connecting: names the server, keeps the
      // backend's actionable sentence as the reason clause, and carries the
      // classified reason so a swarm banner can pick its tone.
      message: expect.stringContaining(identityError),
      details: expect.objectContaining({
        reason: "xaa_configuration_invalid",
        serverId: "srv-xaa",
        serverName: "Legacy XAA server",
      }),
    });

    // Exactly one outbound call — the authorize batch. No secret reveal, no
    // token-endpoint discovery, no mint: the configuration error is
    // surfaced BEFORE any mint work (and there is no silent fallback to the
    // demo identity or to OAuth).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("enterprise-managed authorization policy (xaaPolicy)", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  const fakeContext = { set: () => {}, get: () => undefined } as any;
  const POLICY = { idp: "mcpjam" } as const;

  describe("parseConnectionDefaults", () => {
    it("accepts a well-formed policy and omits an absent one", () => {
      expect(parseConnectionDefaults({ xaaPolicy: { idp: "mcpjam" } })).toEqual(
        { xaaPolicy: { idp: "mcpjam" } }
      );
      expect(parseConnectionDefaults({ timeoutMs: 5 })?.xaaPolicy).toBe(
        undefined
      );
    });

    it("throws 409 on a malformed or unsupported policy — enforcement is never advisory", () => {
      for (const bad of [
        { idp: "okta" },
        { idp: 1 },
        {},
        "on",
        ["mcpjam"],
        null,
      ]) {
        let thrown: any;
        try {
          parseConnectionDefaults({ xaaPolicy: bad });
        } catch (error) {
          thrown = error;
        }
        expect(thrown, JSON.stringify(bad)).toBeDefined();
        expect(thrown.status).toBe(409);
        expect(thrown.details?.reason).toBe("xaa_policy_invalid");
      }
    });
  });

  describe("toMCPServerConfig — host-wide EMA advertisement", () => {
    const EMA = "io.modelcontextprotocol/enterprise-managed-authorization";

    it("advertises EMA on an explicit-oauth HTTP server when the policy is on", () => {
      const config: any = toMCPServerConfig(
        {
          ...httpHostedOAuthAuth,
          serverConfig: {
            ...httpHostedOAuthAuth.serverConfig,
            authMethod: "oauth" as const,
          },
        },
        { xaaPolicy: POLICY }
      );
      expect(config.clientCapabilities.extensions[EMA]).toEqual({});
    });

    it("advertises EMA on stdio servers under the policy (declare-support is host-wide)", () => {
      const config: any = toMCPServerConfig(stdioAuth, { xaaPolicy: POLICY });
      expect(config.clientCapabilities.extensions[EMA]).toEqual({});
    });

    it("does not advertise EMA on non-XAA servers without the policy", () => {
      const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {});
      expect(config.clientCapabilities?.extensions?.[EMA]).toBeUndefined();
    });
  });

  describe("resolveLocalServerForConnect — not-configured failure", () => {
    function authorizeResponse(serverConfig: Record<string, unknown>) {
      return new Response(
        JSON.stringify({
          results: {
            "srv-1": {
              ok: true,
              role: "owner",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig,
              oauthAccessToken: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    it("throws 409 XAA_CONNECTION_NOT_CONFIGURED for a policy-forced unconfigured auto server, before any mint or refresh", async () => {
      const fetchMock = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.endsWith("/web/authorize-batch-local")) {
          return authorizeResponse({
            transportType: "http",
            url: "https://plain.example.com/mcp",
            authMethod: "auto",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      let thrown: any;
      try {
        await resolveLocalServerForConnect(
          fakeContext,
          "b",
          "proj-1",
          "srv-1",
          {
            serverDisplayName: "Plain",
            defaults: { xaaPolicy: POLICY },
          }
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.status).toBe(409);
      expect(thrown?.code).toBe("XAA_CONNECTION_NOT_CONFIGURED");
      expect(thrown?.details?.reason).toBe("xaa_connection_not_configured");
      expect(thrown?.details?.serverId).toBe("srv-1");
      // Fails first-class: only the authorize call went out — no discover
      // refresh, no mint, no secret reveal.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("explicit-oauth server under the policy connects on the OAuth rails (override wins)", async () => {
      const fetchMock = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.endsWith("/web/authorize-batch-local")) {
          return authorizeResponse({
            transportType: "http",
            url: "https://oauth.example.com/mcp",
            authMethod: "oauth",
            useOAuth: true,
          });
        }
        if (url.endsWith("/web/oauth/force-refresh")) {
          return new Response(
            JSON.stringify({ accessToken: "refreshed-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { config, effectiveAuth }: any = await resolveLocalServerForConnect(
        fakeContext,
        "b",
        "proj-1",
        "srv-1",
        { serverDisplayName: "OAuth", defaults: { xaaPolicy: POLICY } }
      );
      expect(effectiveAuth).toBe("oauth");
      expect(config.requestInit.headers.Authorization).toBe(
        "Bearer refreshed-token"
      );
      // Host-wide declare-support rides along even on the override.
      expect(
        config.clientCapabilities.extensions[
          "io.modelcontextprotocol/enterprise-managed-authorization"
        ]
      ).toEqual({});
    });

    it("stdio server under the policy connects unchanged (XAA is HTTP-only)", async () => {
      const fetchMock = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.endsWith("/web/authorize-batch-local")) {
          return authorizeResponse({
            transportType: "stdio",
            command: "node",
            args: ["server.js"],
            env: { FOO: "bar" },
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { config, effectiveAuth }: any = await resolveLocalServerForConnect(
        fakeContext,
        "b",
        "proj-1",
        "srv-1",
        { defaults: { xaaPolicy: POLICY } }
      );
      expect(effectiveAuth).toBe("none");
      expect(config.command).toBe("node");
    });
  });
});

describe("toMCPServerConfig — elicitation url mode is era-gated", () => {
  const CAPS = { elicitation: { form: {}, url: {} } };

  it("keeps url on an unpinned HTTP connection (auto-negotiation can land modern)", () => {
    // The common case: the default MCPJam client with Protocol version
    // "Automatic". Pruning url here made every url-mode tool on a 2026 server
    // fail with -32021 before the server could ask.
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
    });
    expect(config.clientCapabilities.elicitation).toEqual({
      form: {},
      url: {},
    });
  });

  it("keeps url on a modern pin", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      mcpProtocolVersion: "2026-07-28" as any,
    });
    expect(config.clientCapabilities.elicitation).toEqual({
      form: {},
      url: {},
    });
  });

  it("strips url on a legacy pin — the inbound SSE bridge is form-only", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      mcpProtocolVersion: "2025-11-25" as any,
    });
    expect(config.clientCapabilities.elicitation).toEqual({ form: {} });
  });

  it("strips url when the accept-list names no stateless version", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
    });
    expect(config.clientCapabilities.elicitation).toEqual({ form: {} });
  });

  it("keeps url when the accept-list includes a stateless version", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
    });
    expect(config.clientCapabilities.elicitation).toEqual({
      form: {},
      url: {},
    });
  });

  it("strips url on stdio — the modern era is HTTP-only", () => {
    // The SDK factory throws StatelessRequiresHttpTransport for a stateless
    // pin on stdio, so a stdio connection is always fulfilled by the legacy
    // form-only bridge.
    const config: any = toMCPServerConfig(stdioAuth, {
      clientCapabilities: CAPS,
    });
    expect(config.clientCapabilities.elicitation).toEqual({ form: {} });
  });
});

describe("toMCPServerConfig — malformed protocol versions fail closed", () => {
  const CAPS = { elicitation: { form: {}, url: {} } };

  it("strips url when the accept-list holds only unrecognized versions", () => {
    // `isStatelessProtocolVersion` is a DENY-list: unrecognized strings answer
    // `true`. Without the membership check first, a typo would advertise url
    // on a connection that lands legacy.
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      supportedProtocolVersions: ["2025-11-52", "totally-bogus"],
    });
    expect(config.clientCapabilities.elicitation).toEqual({ form: {} });
  });

  it("keeps url when a real stateless version sits beside a typo", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      supportedProtocolVersions: ["2026-07-28", "2025-11-52"],
    });
    expect(config.clientCapabilities.elicitation).toEqual({
      form: {},
      url: {},
    });
  });

  it("strips url on an unrecognized pin", () => {
    const config: any = toMCPServerConfig(httpHeaderOnlyAuth, {
      clientCapabilities: CAPS,
      mcpProtocolVersion: "2025-11-52" as any,
    });
    expect(config.clientCapabilities.elicitation).toEqual({ form: {} });
  });
});

describe("resolveLocalStdioServerConfig — web-route stdio divert", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  function localBatchResponse(serverConfig: Record<string, unknown>) {
    return new Response(
      JSON.stringify({
        results: {
          "srv-stdio": {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("builds a stdio SDK config from authorize-batch-local, threading cwd/timeout/capabilities", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return localBatchResponse({
          transportType: "stdio",
          command: "node",
          args: ["server.js"],
          env: { FOO: "bar" },
          cwd: "/srv/plugin-root",
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: any = await resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
      {
        timeoutMs: 12_345,
        clientCapabilities: { sampling: {} },
        serverDisplayName: "Stdio Server",
      }
    );

    expect(config).toMatchObject({
      command: "node",
      args: ["server.js"],
      env: { FOO: "bar" },
      cwd: "/srv/plugin-root",
      timeout: 12_345,
    });
    expect(config.url).toBeUndefined();
    expect(config.capabilities).toMatchObject({ sampling: {} });
    // The bearer is re-checked against the LOCAL endpoint — one call, no
    // secret/plugin reads for a plain stdio server.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(String(calledUrl)).toContain("/web/authorize-batch-local");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer bearer-xyz"
    );
  });

  it("refuses an http row instead of silently building one", async () => {
    const fetchMock = vi.fn(async () =>
      localBatchResponse({
        transportType: "http",
        url: "https://hosted.example.com/mcp",
        headers: {},
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalStdioServerConfig("bearer-xyz", "proj-1", "srv-stdio")
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  // The stated invariant of the shared runtime resolution: a row with
  // `hasEnv: true` and an empty env means the values live in the vault —
  // the reveal must run and its env must land on the SDK config, carrying
  // the same scope fields the hosted mint path would send.
  it("reveals deferred secrets (hasEnv with empty env) with the caller's scope", async () => {
    let revealInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return localBatchResponse({
          transportType: "stdio",
          command: "node",
          args: ["server.js"],
          hasEnv: true,
          env: {},
        });
      }
      if (url.endsWith("/web/server/reveal-secrets")) {
        revealInit = init;
        return new Response(
          JSON.stringify({ success: true, env: { API_KEY: "vault-value" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: any = await resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
      {
        accessScope: "chat_v2",
        scenarioId: "scenario-1",
        accessVersion: 7,
      }
    );

    expect(config.env).toEqual({ API_KEY: "vault-value" });
    expect((revealInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer bearer-xyz"
    );
    expect(JSON.parse(revealInit?.body as string)).toMatchObject({
      purpose: "runtime",
      projectId: "proj-1",
      serverId: "srv-stdio",
      accessScope: "chat_v2",
      scenarioId: "scenario-1",
      accessVersion: 7,
    });
  });

  // Plugin runtime reads ride the Convex QUERY protocol (user JWT), which
  // cannot carry the service-token acting-as exchange. A delegated caller
  // hitting a plugin component must get the real reason, not an
  // unauthenticated-query failure.
  it("fails closed when a delegated caller resolves a plugin component", async () => {
    const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return localBatchResponse({
          transportType: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server/index.js"],
          env: {},
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        resolveLocalStdioServerConfig("", "proj-1", "srv-stdio", {
          workosApiKeyActingAs: {
            workosUserId: "user_workos_1",
            mcpjamOrganizationId: "org_1",
          },
        })
      ).rejects.toMatchObject({
        status: 501,
        code: "FEATURE_NOT_SUPPORTED",
      });
    } finally {
      if (originalServiceToken === undefined) {
        delete process.env.INSPECTOR_SERVICE_TOKEN;
      } else {
        process.env.INSPECTOR_SERVICE_TOKEN = originalServiceToken;
      }
    }
  });
});
