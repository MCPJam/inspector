import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/telemetry-context", () => ({
  currentTelemetryActor: () => "user_1",
}));

import {
  trackChatToolCallsCompleted,
  trackToolCallCompleted,
} from "../tool-call-telemetry";

function assistant(parts: unknown[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as UIMessage;
}

describe("tool_call_completed", () => {
  beforeEach(() => {
    track.mockClear();
    localStorage.clear();
  });

  it("marks only the actor's first call as first_for_user", () => {
    trackToolCallCompleted({ source: "tools_tab", isError: false });
    trackToolCallCompleted({ source: "tools_tab", isError: true });

    expect(track).toHaveBeenNthCalledWith(1, "tool_call_completed", {
      location: "tools_tab",
      source: "tools_tab",
      is_error: false,
      first_for_user: true,
      hosted: true,
    });
    expect(track.mock.calls[1][1]).toMatchObject({
      is_error: true,
      first_for_user: false,
    });
  });

  it("fires once per MCP server tool call id across repeated finishes", () => {
    const message = assistant([
      { type: "text", text: "Calling tools" },
      {
        type: "tool-search",
        toolCallId: "call-a",
        state: "output-available",
        input: {},
        output: { content: [] },
      },
      {
        type: "dynamic-tool",
        toolName: "get_issue",
        toolCallId: "call-b",
        state: "output-available",
        input: {},
        callProviderMetadata: { mcpjam: { serverId: "linear" } },
        output: { content: [], isError: true },
      },
      {
        type: "tool-wipe",
        toolCallId: "call-c",
        state: "output-error",
        input: {},
        errorText: "boom",
      },
      {
        type: "tool-pending",
        toolCallId: "call-d",
        state: "input-available",
        input: {},
      },
    ]);

    const toolServerMap = { search: "linear", wipe: "linear", pending: "x" };
    trackChatToolCallsCompleted(message, toolServerMap);
    trackChatToolCallsCompleted(message, toolServerMap);

    expect(track).toHaveBeenCalledTimes(3);
    expect(track.mock.calls.map(([, props]) => props.is_error)).toEqual([
      false,
      true,
      true,
    ]);
    expect(track.mock.calls.every(([, props]) => props.source === "chat")).toBe(
      true,
    );
  });

  it("fires nothing for a harness built-in such as bash", () => {
    trackChatToolCallsCompleted(
      assistant([
        {
          type: "tool-bash",
          toolCallId: "call-bash",
          state: "output-available",
          input: { command: "npm test" },
          output: { stdout: "ok" },
        },
      ]),
      { search: "linear" },
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("fires nothing for the bash built-in when a connected server also has a bash tool", () => {
    trackChatToolCallsCompleted(
      assistant([
        {
          type: "tool-bash",
          toolCallId: "call-bash-collision",
          state: "output-available",
          input: { command: "npm test" },
          output: { stdout: "ok" },
        },
      ]),
      { bash: "shell-server" },
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("counts a server's bash tool when the call carries its server origin", () => {
    trackChatToolCallsCompleted(
      assistant([
        {
          type: "tool-bash",
          toolCallId: "call-bash-mcp",
          state: "output-available",
          input: { command: "ls" },
          output: { content: [] },
          callProviderMetadata: { mcpjam: { serverId: "shell-server" } },
        },
      ]),
      { bash: "shell-server" },
    );
    expect(track).toHaveBeenCalledOnce();
  });

  it("remembers only the most recent 500 call ids", () => {
    const report = (toolCallId: string) =>
      trackToolCallCompleted({ source: "chat", isError: false, toolCallId });
    report("cap-oldest");
    for (let i = 0; i < 500; i++) report(`cap-${i}`);
    track.mockClear();

    report("cap-499");
    expect(track).not.toHaveBeenCalled();
    report("cap-oldest");
    expect(track).toHaveBeenCalledOnce();
  });
});
