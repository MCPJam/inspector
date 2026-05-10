import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHostedOAuthUnauthorizedHandler,
  forceRefreshHostedOAuthAccessToken,
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

  it("prefers workspaceId over projectId in the body when supplied", async () => {
    const fetchMock = vi.fn(async (_input: any, init?: any) => {
      expect(JSON.parse(init?.body)).toEqual({
        workspaceId: "ws-1",
        serverId: "server-1",
        accessScope: "chat_v2",
        chatboxToken: "chat-tok",
      });
      return new Response(
        JSON.stringify({ accessToken: "fresh-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forceRefreshHostedOAuthAccessToken(
        "bearer-token",
        "project-1",
        "server-1",
        {
          accessScope: "chat_v2",
          workspaceId: "ws-1",
          chatboxToken: "chat-tok",
        }
      )
    ).resolves.toBe("fresh-token");
  });

  it("maps refresh_token_invalid to a WebRouteError with reconnect details", async () => {
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

  it("propagates a non-refresh error code as the WebRouteError code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
      vi.fn(async () =>
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
      return new Response(
        JSON.stringify({ accessToken: "fresh-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
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
