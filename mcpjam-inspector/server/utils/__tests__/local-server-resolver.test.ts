import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveLocalServerForConnect,
  toMCPServerConfig,
} from "../local-server-resolver.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

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
