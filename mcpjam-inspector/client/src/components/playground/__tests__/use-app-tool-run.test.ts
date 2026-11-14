import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppToolRun } from "../use-app-tool-run";
import { makeAppInstance } from "@/test/factories";
import {
  useAppToolsRegistry,
  useAppToolInvocationLog,
} from "@mcpjam/widget-react";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { usePlaygroundChatHistoryBridgeStore } from "../playground-chat-history-bridge";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { APP_CLOSED_MESSAGE, appToolResult } from "../app-tool-result";
import { track } from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const registry = useAppToolsRegistry;
const answer = {
  content: [{ type: "text" as const, text: "moved" }],
  structuredContent: { fen: "e4" },
};
async function mount() {
  const instance = makeAppInstance();
  const call = vi.spyOn(instance.bridge, "callTool").mockResolvedValue(answer);
  await act(async () => registry.getState().registerInstance(instance));
  const hook = renderHook(() => useAppToolRun());
  act(() =>
    hook.result.current.select(hook.result.current.groups[0].tools[0].key),
  );
  return { ...hook, instance, call };
}
beforeEach(() => {
  registry.getState().setEnabled(true);
  registry.setState({
    aliases: new Map(),
    instancesByBridgeId: new Map(),
    activeBridgeByParent: new Map(),
    pendingControllers: new Map(),
  });
  useAppToolInvocationLog.getState().clear();
  useActiveChatSessionStore.setState({
    sessionId: "chat-1",
    viewOnly: false,
    compareActive: false,
  });
  usePlaygroundChatHistoryBridgeStore.setState({ bridge: null });
  vi.clearAllMocks();
});
describe("manual app runs", () => {
  it("dispatches once with form arguments, logs user attribution and tracks the rail", async () => {
    const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
    const { result, call } = await mount();
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    await act(async () =>
      Promise.all([result.current.run(), result.current.run()]),
    );
    expect(call).toHaveBeenCalledExactlyOnceWith({
      name: "make_move",
      arguments: { san: "e4" },
    });
    expect(result.current.result).toEqual({
      ok: true,
      text: 'moved\n\n{\n  "fen": "e4"\n}',
    });
    expect(useAppToolInvocationLog.getState().records[0]).toMatchObject({
      initiatedBy: "user",
      raw: answer,
    });
    expect(addLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ initiatedBy: "user" }),
      }),
    );
    expect(track).toHaveBeenCalledWith(
      "app_builder_tool_executed",
      expect.objectContaining({
        location: "playground_tools_rail",
        success: true,
      }),
    );
    expect(registry.getState().pendingControllers.size).toBe(0);
  });
  it("blocks runs while chat streams and surfaces thrown tool errors", async () => {
    const { result, call } = await mount();
    act(() =>
      usePlaygroundChatHistoryBridgeStore.setState({
        bridge: {
          activeSessionId: "chat-1",
          hostStyle: undefined,
          isAuthenticated: false,
          isStreaming: true,
          projectId: null,
          enabled: true,
          refreshSignal: 0,
          onSelectThread: vi.fn(),
          onNewChat: vi.fn(),
        },
      }),
    );
    expect(result.current.canRun).toBe(false);
    await act(async () => result.current.run());
    expect(call).not.toHaveBeenCalled();
    act(() => usePlaygroundChatHistoryBridgeStore.setState({ bridge: null }));
    call.mockRejectedValue(new Error("Invalid SAN. Choose a legal move."));
    await act(async () => result.current.run());
    expect(result.current.result).toEqual({
      ok: false,
      text: "Invalid SAN. Choose a legal move.",
    });
  });
  it("keeps the form when selecting the same row again", async () => {
    const { result } = await mount();
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    act(() => result.current.select(result.current.selectedKey!));
    expect(
      result.current.fields.find((field) => field.name === "san")?.value,
    ).toBe("e4");
  });
  it("keeps the detail and closed message after an unreasoned registry abort", async () => {
    const { result, call, instance } = await mount();
    call.mockImplementation(() => new Promise(() => {}));
    let pending: Promise<void>;
    act(() => {
      pending = result.current.run();
    });
    await act(async () => {
      registry.getState().unregisterInstance(instance.bridgeId);
      await pending;
    });
    expect(result.current.selected?.rawName).toBe("make_move");
    expect(result.current.canRun).toBe(false);
    expect(result.current.result?.text).toBe(APP_CLOSED_MESSAGE);
    expect(result.current.detailProps?.status).toBe("This tool's app closed.");
  });
  it("keeps a completed result after close", async () => {
    const { result, instance } = await mount();
    await act(async () => result.current.run());
    act(() => registry.getState().unregisterInstance(instance.bridgeId));
    expect(result.current.result?.text).toContain("moved");
  });
  it.each(["selection", "chat"])(
    "drops stale results after switching %s",
    async (change) => {
      const { result, call } = await mount();
      let finish: (value: typeof answer) => void = () => {
        throw new Error("not started");
      };
      call.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let pending: Promise<void>;
      act(() => {
        pending = result.current.run();
      });
      act(() =>
        change === "chat"
          ? useActiveChatSessionStore.setState({ sessionId: "chat-2" })
          : result.current.clear(),
      );
      await act(async () => {
        finish(answer);
        await pending;
      });
      expect(result.current.selected).toBeNull();
      expect(result.current.result).toBeNull();
      expect(result.current.invoking).toBe(false);
    },
  );
  it("does not restore a stale selection when returning to a previous chat", async () => {
    const { result } = await mount();
    act(() => useActiveChatSessionStore.setState({ sessionId: "chat-2" }));
    act(() => useActiveChatSessionStore.setState({ sessionId: "chat-1" }));
    expect(result.current.selected).toBeNull();
  });
  it("uses the active modal bridge under the stable row key", async () => {
    const { result, instance, call } = await mount();
    const key = result.current.selectedKey;
    const modal = makeAppInstance({
      ...instance,
      bridgeId: "modal",
      surface: "modal",
      bridge: makeAppInstance().bridge,
    });
    const modalCall = vi
      .spyOn(modal.bridge, "callTool")
      .mockResolvedValue(answer);
    await act(async () => registry.getState().registerInstance(modal));
    expect(result.current.selectedKey).toBe(key);
    await act(async () => result.current.run());
    expect(modalCall).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });
  it("regenerates the schema, retaining only matching field types", async () => {
    const { result, instance } = await mount();
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    await act(async () =>
      registry.getState().registerInstance({
        ...instance,
        tools: [
          {
            name: "make_move",
            inputSchema: {
              type: "object",
              properties: {
                san: { type: "string" },
                count: { type: "number" },
              },
            },
          },
        ],
      }),
    );
    expect(
      result.current.fields.find((field) => field.name === "san")?.value,
    ).toBe("e4");
    expect(result.current.fields.map((field) => field.name)).toEqual([
      "san",
      "count",
    ]);
    await act(async () =>
      registry.getState().registerInstance({
        ...instance,
        tools: [
          {
            name: "make_move",
            inputSchema: {
              type: "object",
              properties: { san: { type: "number" } },
            },
          },
        ],
      }),
    );
    expect(result.current.fields[0].value).not.toBe("e4");
  });
  it("runs a dropped tool and disables Run in a view-only session or disabled registry", async () => {
    const { result, instance, call } = await mount();
    await act(async () =>
      registry.getState().registerInstance({
        ...instance,
        tools: [
          {
            name: "make_move",
            inputSchema: { type: "object", description: "x".repeat(9000) },
          },
        ],
      }),
    );
    expect(result.current.selected?.availability).toBe("schema_too_large");
    await act(async () => result.current.run());
    expect(call).toHaveBeenCalledOnce();
    act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
    expect(result.current.canRun).toBe(false);
    act(() => {
      useActiveChatSessionStore.setState({ viewOnly: false });
      registry.getState().setEnabled(false);
    });
    expect(result.current.canRun).toBe(false);
  });
});
describe("result display", () => {
  it("shows structured-only, non-text, empty and error results", () => {
    expect(
      appToolResult({ content: [], structuredContent: { ok: true } }).text,
    ).toContain('"ok": true');
    expect(
      appToolResult({
        content: [
          { type: "image", data: "", mimeType: "image/png" },
          { type: "audio", data: "", mimeType: "audio/wav" },
          {
            type: "resource",
            resource: { uri: "test://resource", text: "hello" },
          },
        ],
      }).text,
    ).toBe("[image]\n\n[audio]\n\n[resource: test://resource]");
    expect(appToolResult({ content: [] }).text).toBe(
      "The tool returned nothing.",
    );
    expect(appToolResult({ content: [], isError: true }).ok).toBe(false);
  });
  it("limits display bytes", () => {
    const result = appToolResult({
      content: [{ type: "text", text: "x".repeat(30000) }],
    });
    expect(result.text).toBe(
      "x".repeat(20480) + "\n\nShowing the first 20 KB.",
    );
  });
});
