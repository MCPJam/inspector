import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The authorization-server round trip is exercised directly in
// local-oauth-refresh.test.ts; here it is mocked so these tests are about the
// orchestration — 409 in, local refresh, re-upload, token out.
const localRefreshMock = vi.hoisted(() => vi.fn());
vi.mock("../local-oauth-refresh.js", () => ({
  refreshTokensAgainstPrivateAuthorizationServer: localRefreshMock,
}));

import {
  PrivateAuthorizationServerRefreshError,
  buildHostedOAuthUnauthorizedHandler,
  forceRefreshHostedOAuthAccessToken,
  refreshHostedOAuthAccessTokenWithLocalFallback,
} from "../hosted-oauth-refresh.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("forceRefreshHostedOAuthAccessToken", () => {
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

  it("returns the trimmed access token on success", async () => {
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
        JSON.stringify({ success: true, accessToken: "  fresh-token  " }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps refresh_token_invalid to a WebRouteError with reconnect details", async () => {
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

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1",
        { serverName: "Asana" }
      )
    ).rejects.toMatchObject({
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

  it("forwards the recorded failure on authorization_server_unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: "authorization_server_unreachable",
              message: "Could not reach the authorization server (HTTP 502).",
              detail: {
                url: "https://eliya.descope.team/oauth2/v1/apps/token",
                status: 502,
                body: '{"title":"Error 502: Bad gateway"}',
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1",
        { serverName: "Descope" }
      )
    ).rejects.toMatchObject({
      status: 503,
      code: "authorization_server_unreachable",
      message: "Could not reach the authorization server (HTTP 502).",
      details: {
        authorizationServerUnreachable: true,
        serverId: "server-1",
        serverName: "Descope",
        failure: {
          url: "https://eliya.descope.team/oauth2/v1/apps/token",
          status: 502,
          body: '{"title":"Error 502: Bad gateway"}',
        },
      },
    });
  });

  it("keeps failure null when the backend recorded nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: "authorization_server_unreachable",
              message: "Could not reach the authorization server.",
              detail: null,
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 503,
      code: "authorization_server_unreachable",
      details: {
        authorizationServerUnreachable: true,
        failure: null,
      },
    });
  });

  it("propagates a non-refresh error code as the WebRouteError code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "slow down",
    });
  });

  it("wraps fetch errors as SERVER_UNREACHABLE (502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 502,
      code: "SERVER_UNREACHABLE",
    });
  });

  it("rejects when the success response lacks an access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, accessToken: "  " }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 502,
      code: "SERVER_UNREACHABLE",
    });
  });

  it("throws when CONVEX_HTTP_URL is missing", async () => {
    delete process.env.CONVEX_HTTP_URL;

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });
});

describe("buildHostedOAuthUnauthorizedHandler", () => {
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

  it("returns a handler that POSTs and resolves to {accessToken}", async () => {
    const fetchMock = vi.fn(async (_input: any, init?: any) => {
      expect(JSON.parse(init?.body)).toEqual({
        projectId: "project-1",
        serverId: "server-1",
      });
      return new Response(JSON.stringify({ accessToken: "fresh-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = buildHostedOAuthUnauthorizedHandler({
      bearerToken: "bearer-token",
      projectId: "project-1",
      serverId: "server-1",
      serverName: "Server One",
    });

    await expect(
      handler({
        serverId: "server-1",
        error: Object.assign(new Error("HTTP 401"), { statusCode: 401 }),
      })
    ).resolves.toEqual({ accessToken: "fresh-token" });
  });

  it("propagates refresh_token_invalid as a WebRouteError", async () => {
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

    const handler = buildHostedOAuthUnauthorizedHandler({
      bearerToken: "bearer-token",
      projectId: "project-1",
      serverId: "server-1",
      serverName: "Asana",
    });

    await expect(
      handler({
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

describe("private authorization server fallback", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    localRefreshMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  const REFRESH_MATERIAL = {
    authorizationServerUrl: "http://localhost:8001",
    serverUrl: "http://localhost:8001/mcp",
    oauthResourceUrl: "http://localhost:8001",
    clientId: "client-1",
    refreshToken: "stored-refresh-token",
  };

  const privateAuthServer409 = (body: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        success: false,
        code: "private_authorization_server",
        message: "Authorization server is on a private address.",
        ...body,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );

  it("types the backend 409 as a CONFLICT carrying the material", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );

    const error = await forceRefreshHostedOAuthAccessToken(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error).toBeInstanceOf(PrivateAuthorizationServerRefreshError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("CONFLICT");
    expect(error.refreshMaterial).toEqual(REFRESH_MATERIAL);
  });

  it("keeps the refresh token out of details, which the local route spreads into the response body", async () => {
    // SECURITY BAR. respondWithLocalRouteError does
    // `{...error.details}` straight into the JSON it returns to the browser.
    // If this material ever moves into `details`, an uncaught path hands the
    // user's refresh token to the page. Keep it on a plain property.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );

    const error = await forceRefreshHostedOAuthAccessToken(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(JSON.stringify(error.details ?? {})).not.toContain(
      "stored-refresh-token"
    );
    expect(JSON.stringify(error.details ?? {})).not.toContain("client-1");
  });

  it("refreshes locally and stores the result, returning the fresh token", async () => {
    localRefreshMock.mockResolvedValue({
      access_token: "locally-refreshed-token",
      refresh_token: "rotated-refresh-token",
    });
    const fetchMock = vi.fn(async (input: any) => {
      if (String(input).endsWith("/web/oauth/force-refresh")) {
        return privateAuthServer409({ refresh: REFRESH_MATERIAL });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("locally-refreshed-token");

    expect(localRefreshMock).toHaveBeenCalledWith(REFRESH_MATERIAL);
    // force-refresh, then import-tokens. The authorization-server round trip
    // happens inside the mocked local refresh.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const importCall = fetchMock.mock.calls[1];
    expect(String(importCall[0])).toBe(
      "https://example.convex.site/web/oauth/import-tokens"
    );
    const importBody = JSON.parse((importCall[1] as any).body);
    // The backend cannot rediscover an AS it can't reach, so the URL must ride
    // along or the stored credential is unusable on the next refresh.
    expect(importBody.authorizationServerUrl).toBe("http://localhost:8001");
    expect(importBody.clientInformation.clientId).toBe("client-1");
    expect(importBody.tokens.access_token).toBe("locally-refreshed-token");
  });

  it("still returns the fresh token when storing it fails", async () => {
    // This connect has a working token; failing it too would help nobody. If
    // the AS rotated the refresh token, the next connect sees invalid_grant
    // and prompts a reconnect — signposted, and recoverable.
    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) =>
        String(input).endsWith("/web/oauth/force-refresh")
          ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
          : new Response("forbidden", { status: 403 })
      )
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("locally-refreshed");
  });

  it("maps an invalid_grant from the authorization server onto the reconnect prompt", async () => {
    localRefreshMock.mockRejectedValue(new Error("invalid_grant"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      details: { oauthRequired: true, refreshTokenInvalid: true },
    });
  });

  it("maps a conforming invalid_grant carried on .code, not in the message", async () => {
    // The SDK throws OAuthResponseError with the OAuth code on `.code` and the
    // server's error_description as the message. Matching the message alone
    // misses this — the common case — and the user never gets the reconnect
    // prompt, just an opaque failure.
    localRefreshMock.mockRejectedValue(
      Object.assign(new Error("Refresh token has expired"), {
        code: "invalid_grant",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      details: { oauthRequired: true, refreshTokenInvalid: true },
    });
  });

  it("names the authorization server when it cannot be reached", async () => {
    localRefreshMock.mockRejectedValue(new Error("fetch failed ECONNREFUSED"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toMatchObject({
      status: 502,
      code: "SERVER_UNREACHABLE",
      message: expect.stringContaining("http://localhost:8001"),
    });
  });

  it("does not attempt a local refresh when the backend withheld the material", async () => {
    // Shared credential, or a browser-shaped caller. Nothing to do here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409())
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).rejects.toBeInstanceOf(PrivateAuthorizationServerRefreshError);
    expect(localRefreshMock).not.toHaveBeenCalled();
  });

  it("only the local call site opts into the fallback", async () => {
    // The handler builder is shared with the hosted /web routes, where there is
    // no user machine to reach a private address from.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );
    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });

    const hosted = buildHostedOAuthUnauthorizedHandler({
      bearerToken: "bearer-token",
      projectId: "project-1",
      serverId: "server-1",
      serverName: "Local",
    });
    await expect(
      hosted({ serverId: "server-1", error: new Error("HTTP 401") })
    ).rejects.toBeInstanceOf(PrivateAuthorizationServerRefreshError);
    expect(localRefreshMock).not.toHaveBeenCalled();

    const local = buildHostedOAuthUnauthorizedHandler({
      bearerToken: "bearer-token",
      projectId: "project-1",
      serverId: "server-1",
      serverName: "Local",
      allowPrivateAuthorizationServerFallback: true,
    });
    await expect(
      local({ serverId: "server-1", error: new Error("HTTP 401") })
    ).resolves.toEqual({ accessToken: "locally-refreshed" });
  });
});
