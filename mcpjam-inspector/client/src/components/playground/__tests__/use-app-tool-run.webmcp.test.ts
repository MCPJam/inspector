import { act, renderHook } from "@testing-library/react";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppToolInvocationLog, useAppToolsRegistry } from "@mcpjam/widget-react";
import { track } from "@/lib/analytics";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { makeAppInstance } from "@/test/factories";
import { usePlaygroundChatHistoryBridgeStore } from "../playground-chat-history-bridge";
import { useAppToolRun } from "../use-app-tool-run";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

beforeEach(() => {
  useAppToolsRegistry.getState().setEnabled(true);
  useAppToolsRegistry.setState({
    aliases: new Map(),
    instancesByBridgeId: new Map(),
    activeBridgeByParent: new Map(),
    pendingControllers: new Map(),
  });
  useAppToolInvocationLog.getState().clear();
  useTrafficLogStore.getState().clear();
  useActiveChatSessionStore.setState({
    sessionId: "chat-1",
    appSessionScopeId: "chat-1",
    viewOnly: false,
    compareActive: false,
  });
  usePlaygroundChatHistoryBridgeStore.setState({ bridge: null });
  vi.clearAllMocks();
});

describe("manual WebMCP calls over a real AppBridge", () => {
  it.each([
    { readOnly: false, outcome: "success" },
    { readOnly: true, outcome: "success" },
    { readOnly: true, outcome: "tool-error" },
    { readOnly: true, outcome: "transport-error" },
  ])("records the actual $outcome after read-only=$readOnly", async ({
    readOnly,
    outcome,
  }) => {
    const instance = makeAppInstance({ toolSource: "webmcp" });
    const [host, app] = InMemoryTransport.createLinkedPair();
    const messages: JSONRPCMessage[] = [];
    app.onmessage = (message) => messages.push(message);
    await instance.bridge.connect(host);
    await app.start();
    await act(async () =>
      useAppToolsRegistry.getState().registerInstance(instance),
    );
    const { result, unmount } = renderHook(() => useAppToolRun());
    const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
    try {
      act(() => result.current.select(result.current.groups[0].tools[0].key));
      act(() => result.current.detailProps?.onFieldChange("san", "e4"));
      const selectedKey = result.current.selectedKey;
      let pending = Promise.resolve();
      act(() => {
        pending = result.current.run();
      });
      const request = messages.find(
        (message) =>
          "method" in message && message.method === "ui/sandbox-call-tool",
      );
      if (!request || !("id" in request) || request.id == null) {
        throw new Error("The App tool request was not dispatched");
      }
      expect(request).toMatchObject({
        params: { name: "make_move", arguments: { san: "e4" } },
      });
      if (readOnly) {
        act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
        await act(async () => pending);
        expect(result.current.invoking).toBe(false);
        expect(result.current.canRun).toBe(false);
        expect(result.current.selectedKey).toBe(selectedKey);
        expect(
          result.current.fields.find((field) => field.name === "san")?.value,
        ).toBe("e4");
        expect(track).not.toHaveBeenCalled();
        expect(addLog).not.toHaveBeenCalled();
      }
      const answer = {
        content: [{ type: "text" as const, text: "moved" }],
        isError: outcome === "tool-error",
      };
      await act(async () => {
        await app.send(
          outcome === "transport-error"
            ? {
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32603, message: "App failed" },
              }
            : { jsonrpc: "2.0", id: request.id, result: answer },
        );
        await pending;
      });
      expect(messages).toHaveLength(1);
      expect(track).toHaveBeenCalledExactlyOnceWith(
        "app_builder_tool_executed",
        expect.objectContaining({ success: outcome === "success" }),
      );
      const records = useAppToolInvocationLog.getState().records;
      expect(records).toHaveLength(outcome === "transport-error" ? 0 : 1);
      expect(addLog).toHaveBeenCalledTimes(records.length);
      if (records.length) {
        expect(records[0]).toMatchObject({
          chatSessionId: "chat-1",
          appSessionScopeId: "chat-1",
          raw: answer,
        });
      }
      if (readOnly) expect(result.current.result).toBeNull();
      else expect(result.current.result).toEqual({ ok: true, text: "moved" });
      expect(useAppToolsRegistry.getState().pendingControllers.size).toBe(0);
    } finally {
      unmount();
      await instance.bridge.close();
    }
  });
});
