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
  __resetPrivateAuthorizationServerMaterialCacheForTests,
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
    __resetPrivateAuthorizationServerMaterialCacheForTests();
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

  it("keeps the existing refresh token when the authorization server omits one", async () => {
    // RFC 6749 §6: omitting refresh_token means "keep the one you have".
    // Storing the raw response would drop it, and the NEXT expiry would fail
    // with "missing refresh_token" — the fix breaking itself one cycle later.
    localRefreshMock.mockResolvedValue({
      access_token: "locally-refreshed-token",
      token_type: "Bearer",
    });
    const fetchMock = vi.fn(async (input: any) =>
      String(input).endsWith("/web/oauth/force-refresh")
        ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
        : new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("locally-refreshed-token");

    const importBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(importBody.tokens.refresh_token).toBe("stored-refresh-token");
  });

  it("stores a rotated refresh token when the authorization server issues one", async () => {
    localRefreshMock.mockResolvedValue({
      access_token: "locally-refreshed-token",
      refresh_token: "rotated-refresh-token",
    });
    const fetchMock = vi.fn(async (input: any) =>
      String(input).endsWith("/web/oauth/force-refresh")
        ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
        : new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    );

    const importBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(importBody.tokens.refresh_token).toBe("rotated-refresh-token");
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

  it("declares a local runtime, which is what makes the backend hand the material over", async () => {
    // Without this the backend answers 409 with no `refresh` and the fallback
    // has nothing to work with — the feature silently does nothing.
    let forceRefreshBody = "";
    const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      if (String(input).includes("/force-refresh")) {
        forceRefreshBody = String(init?.body ?? "");
      }
      return privateAuthServer409({ refresh: REFRESH_MATERIAL });
    });
    vi.stubGlobal("fetch", fetchMock);
    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });

    await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    );

    expect(JSON.parse(forceRefreshBody).localRuntime).toBe(true);
  });

  it("still refreshes locally when the backend refresh budget is exhausted", async () => {
    // Every fallback spends one of 10/min per subject and server on a call
    // that structurally cannot succeed. Once the bucket empties the backend
    // answers 429 BEFORE it ever resolves the private address — locking the
    // user out of a refresh that needs nothing from the backend at all.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        if (String(input).includes("/import-tokens")) {
          return new Response("{}", { status: 200 });
        }
        call += 1;
        return call === 1
          ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
          : new Response(
              JSON.stringify({
                success: false,
                code: "RATE_LIMITED",
                message: "Too many OAuth refresh attempts.",
              }),
              { status: 429, headers: { "Content-Type": "application/json" } }
            );
      })
    );
    localRefreshMock.mockResolvedValue({
      access_token: "locally-refreshed",
      refresh_token: "rotated-refresh-token",
    });

    // First refresh learns what this server needs.
    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("locally-refreshed");

    // Second one is rate limited by the backend and must not be blocked by it.
    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-1"
      )
    ).resolves.toBe("locally-refreshed");

    // ...and it replayed the token in effect, not the one the backend first
    // handed over, which the authorization server has since rotated away.
    expect(localRefreshMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshToken: "rotated-refresh-token" })
    );
  });

  it("does not blame the credential when another process rotated it out from under the cache", async () => {
    // The cache is per PROCESS; the credential is not. A second local inspector
    // (desktop alongside npx), or another replica of a self-hosted deployment,
    // can refresh the same credential and rotate the refresh token away. This
    // copy then holds a dead token while the vault holds a good one — so an
    // invalid_grant here says nothing about the stored credential, and telling
    // the user to reconnect would send them to re-run a flow they don't need.
    let call = 0;
    const rateLimited = () =>
      new Response(
        JSON.stringify({
          success: false,
          code: "RATE_LIMITED",
          message: "Too many OAuth refresh attempts.",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        if (String(input).includes("/import-tokens")) {
          return new Response("{}", { status: 200 });
        }
        call += 1;
        return call === 1
          ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
          : rateLimited();
      })
    );

    // First refresh populates the cache.
    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });
    await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    );

    // Now the backend is rate limited AND the cached token has been rotated
    // away by someone else.
    localRefreshMock.mockRejectedValue(
      Object.assign(new Error("Token refresh failed"), {
        code: "invalid_grant",
      })
    );

    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    // The backend's own (transient) error, not a reconnect prompt.
    expect(error.status).toBe(429);
    expect(error.details?.refreshTokenInvalid).toBeUndefined();

    // ...and the dead guess is gone, so the next attempt goes back to the
    // backend for authoritative material rather than replaying it.
    localRefreshMock.mockResolvedValue({ access_token: "second-wind" });
    const afterDrop = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);
    expect(afterDrop.status).toBe(429);
    expect(localRefreshMock).toHaveBeenCalledTimes(2);
  });

  it("still reports a reconnect when the BACKEND's own material is rejected", async () => {
    // The contrast to the test above: material handed over moments ago is
    // authoritative, so an invalid_grant against it really does mean the
    // stored refresh token is dead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );
    localRefreshMock.mockRejectedValue(
      Object.assign(new Error("Token refresh failed"), {
        code: "invalid_grant",
      })
    );

    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.details?.refreshTokenInvalid).toBe(true);
  });

  it("does not use the cache for an unrelated backend failure on an unknown server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code: "RATE_LIMITED",
              message: "Too many OAuth refresh attempts.",
            }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(
      refreshHostedOAuthAccessTokenWithLocalFallback(
        "bearer-token",
        "project-1",
        "server-never-seen"
      )
    ).rejects.toMatchObject({ status: 429 });
    expect(localRefreshMock).not.toHaveBeenCalled();
  });

  it("does not use the cache when the backend REFUSES rather than fails", async () => {
    // GUARDRAIL. The cache exists for a backend that could not answer (429, or
    // unreachable). A 401 is an answer: the credential was revoked, the bearer
    // expired, or the user pressed Disconnect. Serving that from cache kept a
    // revoked connection minting tokens until the process restarted.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        if (String(input).includes("/import-tokens")) {
          return new Response("{}", { status: 200 });
        }
        call += 1;
        return call === 1
          ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
          : new Response(
              JSON.stringify({
                success: false,
                code: "refresh_token_invalid",
                message: "Hosted OAuth refresh token is invalid.",
              }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            );
      })
    );

    // First call populates the cache for this exact subject/project/server.
    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });
    await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    );
    expect(localRefreshMock).toHaveBeenCalledTimes(1);

    // Second call: the backend now refuses. The cached material must not be
    // touched, and the refusal must reach the caller intact.
    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.details?.refreshTokenInvalid).toBe(true);
    expect(localRefreshMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one subject's cached material to another", async () => {
    // GUARDRAIL. The credential is (userId, projectId, serverId), and one
    // local process outlives one signed-in user — sign out, sign in as someone
    // else with access to the same project. On a subject-less key the second
    // user's rate-limited refresh was answered with the first's refresh token,
    // and importRefreshedTokens then wrote the rotated result into the second
    // user's credential.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        if (String(input).includes("/import-tokens")) {
          return new Response("{}", { status: 200 });
        }
        call += 1;
        return call === 1
          ? privateAuthServer409({ refresh: REFRESH_MATERIAL })
          : new Response(
              JSON.stringify({
                success: false,
                code: "RATE_LIMITED",
                message: "Too many OAuth refresh attempts.",
              }),
              { status: 429, headers: { "Content-Type": "application/json" } }
            );
      })
    );

    localRefreshMock.mockResolvedValue({ access_token: "locally-refreshed" });
    await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-a",
      "project-1",
      "server-1"
    );
    expect(localRefreshMock).toHaveBeenCalledTimes(1);

    // Same project and server, DIFFERENT bearer. Nothing cached for them.
    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-b",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error.status).toBe(429);
    expect(localRefreshMock).toHaveBeenCalledTimes(1);
  });

  it("does not read a rejected-grant code out of a raw response body", async () => {
    // The SDK embeds a non-JSON error response verbatim
    // (`Invalid OAuth error response: ${body}`). A dev proxy's HTML error page
    // that merely mentions invalid_grant used to become "your refresh token
    // was rejected, please reconnect" — on a credential that was fine.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );
    localRefreshMock.mockRejectedValue(
      new Error(
        "HTTP 502: Invalid OAuth error response: " +
          "<html><body>Bad gateway. See docs on invalid_grant.</body></html>"
      )
    );

    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error.status).toBe(502);
    expect(error.details?.refreshTokenInvalid).toBeUndefined();
  });

  it("does not mistake invalid_client_metadata for a rejected grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privateAuthServer409({ refresh: REFRESH_MATERIAL }))
    );
    localRefreshMock.mockRejectedValue(
      new Error("Registration failed: invalid_client_metadata")
    );

    const error = await refreshHostedOAuthAccessTokenWithLocalFallback(
      "bearer-token",
      "project-1",
      "server-1"
    ).catch((e) => e);

    expect(error.status).toBe(502);
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
