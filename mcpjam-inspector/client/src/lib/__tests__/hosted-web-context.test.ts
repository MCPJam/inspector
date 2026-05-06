import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "../client-config";

vi.mock("../config", () => ({
  HOSTED_MODE: true,
}));

import {
  buildHostedEvalServerBatchRequest,
  buildServerBatchRequest,
  buildServerRequest,
  setApiContext,
} from "../apis/web/context";

describe("hosted web context", () => {
  const defaultClientCapabilities = getDefaultClientCapabilities() as Record<
    string,
    unknown
  >;

  afterEach(() => {
    setApiContext(null);
    localStorage.removeItem("mcp-tokens-myServer");
  });

  it("includes share token and chat_v2 scope for shared-chat requests", () => {
    setApiContext({
      projectId: "ws_shared",
      serverIdsByName: { bench: "srv_bench" },
      getAccessToken: async () => null,
      shareToken: "share_tok_123",
    });

    expect(buildServerRequest("bench")).toEqual({
      projectId: "ws_shared",
      serverId: "srv_bench",
      serverName: "bench",
      clientCapabilities: defaultClientCapabilities,
      accessScope: "chat_v2",
      shareToken: "share_tok_123",
    });

    expect(buildServerBatchRequest(["bench"])).toEqual({
      projectId: "ws_shared",
      serverIds: ["srv_bench"],
      serverNames: ["bench"],
      clientCapabilities: defaultClientCapabilities,
      accessScope: "chat_v2",
      shareToken: "share_tok_123",
    });

    expect(buildHostedEvalServerBatchRequest(["bench"])).toEqual({
      projectId: "ws_shared",
      serverIds: ["srv_bench"],
      serverNames: ["bench"],
      clientCapabilities: defaultClientCapabilities,
      accessScope: "chat_v2",
      shareToken: "share_tok_123",
    });
  });

  it("omits share scope fields when no share token is present", () => {
    setApiContext({
      projectId: "ws_regular",
      serverIdsByName: { bench: "srv_bench" },
      getAccessToken: async () => null,
    });

    expect(buildServerRequest("bench")).toEqual({
      projectId: "ws_regular",
      serverId: "srv_bench",
      serverName: "bench",
      clientCapabilities: defaultClientCapabilities,
    });
  });

  it("throws BootstrapNotReadyError when projectId is missing", () => {
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
    });

    expect(() => buildServerRequest("myServer")).toThrow(
      "hosted projectId is not in the API context yet",
    );
    expect(() => buildServerBatchRequest(["myServer"])).toThrow(
      "hosted projectId is not in the API context yet",
    );
    expect(() => buildHostedEvalServerBatchRequest(["myServer"])).toThrow(
      "hosted projectId is not in the API context yet",
    );
  });

  it("ignores persisted guest OAuth token from localStorage", () => {
    localStorage.setItem(
      "mcp-tokens-myServer",
      JSON.stringify({
        access_token: "storage-access-token",
      }),
    );

    setApiContext({
      projectId: "ws_regular",
      isAuthenticated: false,
      serverIdsByName: { myServer: "srv_myServer" },
    });

    expect(buildServerRequest("myServer")).toEqual({
      projectId: "ws_regular",
      serverId: "srv_myServer",
      serverName: "myServer",
      clientCapabilities: defaultClientCapabilities,
    });
  });

  it("uses explicit client capabilities overrides when provided", () => {
    const clientCapabilities = {
      elicitation: {},
      experimental: { inspectorProfile: true },
    } as Record<string, unknown>;

    setApiContext({
      projectId: "ws_override",
      serverIdsByName: { bench: "srv_bench" },
      clientCapabilities,
      getAccessToken: async () => null,
    });

    expect(buildServerRequest("bench")).toEqual({
      projectId: "ws_override",
      serverId: "srv_bench",
      serverName: "bench",
      clientCapabilities,
    });
  });

  it("blocks hosted project requests while client config sync is pending", () => {
    setApiContext({
      projectId: "ws_pending",
      serverIdsByName: { bench: "srv_bench" },
      clientConfigSyncPending: true,
      getAccessToken: async () => null,
    });

    expect(() => buildServerRequest("bench")).toThrow(
      CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
    );
    expect(() => buildServerBatchRequest(["bench"])).toThrow(
      CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
    );
    expect(() => buildHostedEvalServerBatchRequest(["bench"])).toThrow(
      CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
    );
  });

  it("keeps hosted eval server names aligned with deduped server ids", () => {
    setApiContext({
      projectId: "ws_eval",
      isAuthenticated: true,
      serverIdsByName: {
        asana: "srv_asana",
        github: "srv_github",
      },
      getAccessToken: async () => null,
    });

    expect(
      buildHostedEvalServerBatchRequest(["asana", "srv_asana", "github"]),
    ).toEqual({
      projectId: "ws_eval",
      serverIds: ["srv_asana", "srv_github"],
      serverNames: ["asana", "github"],
      clientCapabilities: defaultClientCapabilities,
    });
  });
});
