import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toMCPServerConfig } from "../local-server-resolver.js";

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
      return new Response(
        JSON.stringify({ accessToken: "new-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
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
      vi.fn(async () =>
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
