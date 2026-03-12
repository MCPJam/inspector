import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  HOSTED_MODE: true,
}));

import {
  buildHostedServerBatchRequest,
  buildHostedServerRequest,
  setHostedApiContext,
} from "../apis/web/context";

describe("hosted web context", () => {
  afterEach(() => {
    setHostedApiContext(null);
    localStorage.removeItem("mcp-tokens-myServer");
  });

  it("includes share token and chat_v2 scope for shared-chat requests", () => {
    setHostedApiContext({
      workspaceId: "ws_shared",
      serverIdsByName: { bench: "srv_bench" },
      getAccessToken: async () => null,
      shareToken: "share_tok_123",
    });

    expect(buildHostedServerRequest("bench")).toEqual({
      workspaceId: "ws_shared",
      serverId: "srv_bench",
      accessScope: "chat_v2",
      shareToken: "share_tok_123",
    });

    expect(buildHostedServerBatchRequest(["bench"])).toEqual({
      workspaceId: "ws_shared",
      serverIds: ["srv_bench"],
      accessScope: "chat_v2",
      shareToken: "share_tok_123",
    });
  });

  it("omits share scope fields when no share token is present", () => {
    setHostedApiContext({
      workspaceId: "ws_regular",
      serverIdsByName: { bench: "srv_bench" },
      getAccessToken: async () => null,
    });

    expect(buildHostedServerRequest("bench")).toEqual({
      workspaceId: "ws_regular",
      serverId: "srv_bench",
    });
  });

  it("builds guest request from serverConfigs when in guest mode", () => {
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {
        myServer: {
          url: "https://example.com/mcp",
          requestInit: { headers: { "X-Api-Key": "key123" } },
        },
      },
    });

    expect(buildHostedServerRequest("myServer")).toEqual({
      serverUrl: "https://example.com/mcp",
      serverHeaders: { "X-Api-Key": "key123" },
    });
  });

  it("keeps using direct guest requests when AuthKit still reports a session", () => {
    setHostedApiContext({
      workspaceId: null,
      hasSession: true,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {
        myServer: {
          url: "https://example.com/mcp",
          requestInit: { headers: { "X-Api-Key": "key123" } },
        },
      },
    });

    expect(buildHostedServerRequest("myServer")).toEqual({
      serverUrl: "https://example.com/mcp",
      serverHeaders: { "X-Api-Key": "key123" },
    });
  });

  it("includes the latest guest OAuth token separately from server headers", () => {
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      guestOauthTokensByServerName: {
        myServer: "fresh-access-token",
      },
      serverConfigs: {
        myServer: {
          url: "https://example.com/mcp",
          requestInit: {
            headers: {
              Authorization: "Bearer stale-access-token",
              "X-Api-Key": "key123",
            },
          },
        },
      },
    });

    expect(buildHostedServerRequest("myServer")).toEqual({
      serverUrl: "https://example.com/mcp",
      serverHeaders: {
        Authorization: "Bearer stale-access-token",
        "X-Api-Key": "key123",
      },
      oauthAccessToken: "fresh-access-token",
    });
  });

  it("prefers persisted guest OAuth token from localStorage when available", () => {
    localStorage.setItem(
      "mcp-tokens-myServer",
      JSON.stringify({
        access_token: "storage-access-token",
      }),
    );

    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      guestOauthTokensByServerName: {
        myServer: "context-access-token",
      },
      serverConfigs: {
        myServer: {
          url: "https://example.com/mcp",
          requestInit: {
            headers: {
              "X-Api-Key": "key123",
            },
          },
        },
      },
    });

    expect(buildHostedServerRequest("myServer")).toEqual({
      serverUrl: "https://example.com/mcp",
      serverHeaders: {
        "X-Api-Key": "key123",
      },
      oauthAccessToken: "storage-access-token",
    });
  });

  it("handles URL objects in guest server configs", () => {
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {
        myServer: {
          url: new URL("https://example.com/mcp"),
          requestInit: { headers: {} },
        },
      },
    });

    expect(buildHostedServerRequest("myServer")).toEqual({
      serverUrl: "https://example.com/mcp",
    });
  });

  it("throws when guest server config is not found", () => {
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {},
    });

    expect(() => buildHostedServerRequest("unknown")).toThrow(
      'No guest server config found for "unknown"',
    );
  });
});
