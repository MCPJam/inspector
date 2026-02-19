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
});
