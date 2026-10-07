import { beforeEach, describe, expect, it } from "vitest";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { logPluginChatFailure } from "../use-chat-session";

const rows = () => useTrafficLogStore.getState().mcpServerItems;

describe("plugin chat failures in the Logs panel", () => {
  beforeEach(() => useTrafficLogStore.getState().clear());

  it("logs a plugin workspace refusal under its code with the plain message", () => {
    logPluginChatFailure(
      new Error(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message:
            "MCPJam couldn't reach its backend to check plugin access (a network problem or timeout). Check your connection and try again.",
          details: { pluginCode: "PLUGIN_WORKSPACE_UNREACHABLE" },
        }),
      ),
      false,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      method: "plugin-extensions/PLUGIN_WORKSPACE_UNREACHABLE",
      payload: {
        level: "error",
        message: expect.stringContaining("couldn't reach its backend"),
      },
    });
  });

  it("logs a failed turn an App sent, and nothing for an ordinary failure", () => {
    logPluginChatFailure(new Error("Model provider timed out"), false);
    expect(rows()).toHaveLength(0);
    logPluginChatFailure(new Error("Model provider timed out"), true);
    expect(rows()[0]).toMatchObject({
      method: "plugin-extensions/APP_MESSAGE_TURN_FAILED",
      payload: {
        message:
          "The message an App sent to this chat didn't get a reply. Model provider timed out",
      },
    });
  });

  it("ignores a stopped turn", () => {
    const stopped = new Error("aborted");
    stopped.name = "AbortError";
    logPluginChatFailure(stopped, true);
    expect(rows()).toHaveLength(0);
  });
});
