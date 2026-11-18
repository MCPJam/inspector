import { describe, expect, it } from "vitest";
import {
  connectedTesterServerNames,
  oauthRequiredFromChatError,
  withSingleServerName,
  type TesterChatRules,
} from "../tester-chat";

function rules(
  names: Array<[string, "connected" | "failed" | "connecting"]>,
): TesterChatRules {
  return {
    hostedContext: { scenarioId: "sbx_1", projectId: "ws_1" },
    executionConfig: { modelId: "openai/gpt-5-mini" },
    selectedServerNames: names.map(([name]) => name),
    serverConfigs: Object.fromEntries(
      names.map(([name, connectionStatus]) => [
        name,
        {
          name,
          config: { url: "https://scenario-chat.invalid" },
          lastConnectionTime: new Date(),
          connectionStatus,
          retryCount: 0,
          enabled: true,
        },
      ]),
    ),
    composerBlocked: false,
  };
}

describe("connectedTesterServerNames", () => {
  it("sends only servers that answered", () => {
    expect(
      connectedTesterServerNames(
        rules([
          ["asana", "connected"],
          ["down", "failed"],
          ["pending", "connecting"],
        ]),
      ),
    ).toEqual(["asana"]);
  });
});

describe("oauthRequiredFromChatError", () => {
  it("reads a structured oauth failure", () => {
    const error = new Error(
      JSON.stringify({
        details: {
          oauthRequired: true,
          serverId: "srv_asana",
          serverName: "asana",
          serverUrl: "https://mcp.asana.com/sse",
        },
      }),
    );
    expect(oauthRequiredFromChatError(error)).toEqual({
      required: true,
      details: {
        serverId: "srv_asana",
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      },
    });
  });

  it("recognizes the server's plain oauth phrases", () => {
    expect(
      oauthRequiredFromChatError(
        new Error("Server requires OAuth authentication"),
      ),
    ).toEqual({ required: true });
    expect(
      oauthRequiredFromChatError(
        new Error("Authentication failed: invalid_token"),
      ),
    ).toEqual({ required: true });
    expect(
      oauthRequiredFromChatError(new Error("the model refused")),
    ).toEqual({ required: false });
  });
});

describe("withSingleServerName", () => {
  it("fills the only connected server when the error named none", () => {
    expect(withSingleServerName(undefined, ["asana"])).toEqual({
      serverName: "asana",
    });
    expect(
      withSingleServerName({ serverName: "linear" }, ["asana"]),
    ).toEqual({ serverName: "linear" });
    expect(withSingleServerName(undefined, ["asana", "linear"])).toBeUndefined();
  });
});
