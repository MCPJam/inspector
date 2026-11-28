import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { flushSync } from "react-dom";
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
    appSessionScopeId: "chat-1",
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
  it.each(["compare", "read-only"])("revokes pending manual access in %s mode", async (mode) => {
    const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
    const { result, call, instance } = await mount();
    const late = Promise.withResolvers<typeof answer>();
    call.mockReturnValueOnce(late.promise);
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    const key = result.current.selectedKey;
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.run(); });
    const controller = [...registry.getState().pendingControllers.get(instance.bridgeId)!][0];
    act(() => useActiveChatSessionStore.setState(mode === "compare" ? { compareActive: true } : { viewOnly: true }));
    await act(async () => pending);
    expect(controller.signal.aborted).toBe(true);
    expect(result.current.canRun).toBe(false);
    expect(result.current.invoking).toBe(false);
    expect(result.current.result).toBeNull();
    expect(registry.getState().pendingControllers.size).toBe(0);
    expect(useAppToolInvocationLog.getState().records).toHaveLength(0);
    expect(track).not.toHaveBeenCalled();
    expect(addLog).not.toHaveBeenCalled();
    if (mode === "compare") {
      expect(result.current.groups).toEqual([]);
      expect(result.current.selectedKey).toBeNull();
      expect(result.current.fields).toEqual([]);
      await act(async () => { late.resolve(answer); await Promise.resolve(); });
    } else {
      expect(result.current.selectedKey).toBe(key);
      expect(result.current.fields.find((field) => field.name === "san")?.value).toBe("e4");
      act(() => useActiveChatSessionStore.setState({ viewOnly: false }));
      expect(result.current.canRun).toBe(true);
      const retry = Promise.withResolvers<typeof answer>();
      call.mockReturnValueOnce(retry.promise);
      let retryPending: Promise<void> = Promise.resolve();
      act(() => { retryPending = result.current.run(); });
      await act(async () => { late.resolve(answer); await Promise.resolve(); });
      expect(result.current.invoking).toBe(true);
      expect(result.current.result).toBeNull();
      await act(async () => {
        retry.resolve({ content: [{ type: "text", text: "new execution" }], structuredContent: { fen: "e4" } });
        await retryPending;
      });
      expect(result.current.result?.text).toContain("new execution");
      expect(call).toHaveBeenCalledTimes(2);
    }
    if (mode === "compare") expect(result.current.result).toBeNull();
    else expect(result.current.result?.text).toContain("new execution");
    expect(result.current.invoking).toBe(false);
    expect(useAppToolInvocationLog.getState().records).toHaveLength(mode === "compare" ? 1 : 2);
    expect(track).toHaveBeenCalledTimes(mode === "compare" ? 1 : 2);
    expect(addLog).toHaveBeenCalledTimes(mode === "compare" ? 1 : 2);
    for (const [log] of addLog.mock.calls) {
      expect(log.message).toMatchObject({
        chatSessionId: "chat-1",
        appSessionScopeId: "chat-1",
        initiatedBy: "user",
      });
    }
    for (const record of useAppToolInvocationLog.getState().records) {
      expect(record).toMatchObject({
        chatSessionId: "chat-1",
        appSessionScopeId: "chat-1",
      });
    }
  });

  it.each([true, false])(
    "keeps both invocation identities when the cancelled result arrives first=%s",
    async (oldFirst) => {
      const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
      const { result, call } = await mount();
      const old = Promise.withResolvers<typeof answer>();
      const retry = Promise.withResolvers<typeof answer>();
      call.mockReturnValueOnce(old.promise).mockReturnValueOnce(retry.promise);
      let pending = Promise.resolve();
      act(() => { pending = result.current.run(); });
      act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
      await act(async () => pending);
      expect(addLog).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();

      // A conflict fork changes the durable row while retaining the App scope.
      act(() => useActiveChatSessionStore.setState({
        sessionId: "fork-row",
        viewOnly: false,
      }));
      let retried = Promise.resolve();
      act(() => { retried = result.current.run(); });
      const newAnswer = {
        ...answer,
        content: [{ type: "text" as const, text: "new execution" }],
      };
      if (oldFirst) {
        await act(async () => { old.resolve(answer); });
        expect(result.current.invoking).toBe(true);
        expect(result.current.result).toBeNull();
      }
      await act(async () => { retry.resolve(newAnswer); await retried; });
      if (!oldFirst) await act(async () => { old.resolve(answer); });

      expect(call).toHaveBeenCalledTimes(2);
      expect(result.current.invoking).toBe(false);
      expect(result.current.result?.text).toContain("new execution");
      const records = useAppToolInvocationLog.getState().records;
      expect(records).toHaveLength(2);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          chatSessionId: "chat-1", appSessionScopeId: "chat-1", raw: answer,
        }),
        expect.objectContaining({
          chatSessionId: "fork-row", appSessionScopeId: "chat-1", raw: newAnswer,
        }),
      ]));
      expect(addLog).toHaveBeenCalledTimes(2);
      for (const chatSessionId of ["chat-1", "fork-row"]) {
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({
          message: expect.objectContaining({
            chatSessionId, appSessionScopeId: "chat-1", initiatedBy: "user",
          }),
        }));
      }
      expect(track).toHaveBeenCalledTimes(2);
      for (const [, event] of vi.mocked(track).mock.calls) {
        expect(event).toMatchObject({ success: true });
      }
    },
  );

  it.each(["tool-error", "transport-error"])(
    "records the actual late %s once after read-only cancellation",
    async (outcome) => {
      const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
      const { result, call } = await mount();
      const failed = { ...answer, isError: true };
      const late = Promise.withResolvers<typeof failed>();
      call.mockReturnValueOnce(late.promise);
      let pending: Promise<void> = Promise.resolve();
      act(() => { pending = result.current.run(); });
      act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
      await act(async () => pending);
      expect(track).not.toHaveBeenCalled();
      expect(addLog).not.toHaveBeenCalled();
      await act(async () => {
        if (outcome === "tool-error") late.resolve(failed);
        else late.reject(new Error("late transport failure"));
      });
      expect(useAppToolInvocationLog.getState().records).toHaveLength(
        outcome === "tool-error" ? 1 : 0,
      );
      expect(track).toHaveBeenCalledExactlyOnceWith(
        "app_builder_tool_executed",
        expect.objectContaining({ success: false }),
      );
      expect(addLog).toHaveBeenCalledTimes(outcome === "tool-error" ? 1 : 0);
      if (outcome === "tool-error") {
        expect(addLog).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.objectContaining({
              chatSessionId: "chat-1",
              appSessionScopeId: "chat-1",
              result: expect.objectContaining({ isError: true }),
            }),
          }),
        );
      }
      expect(result.current.result).toBeNull();
      expect(result.current.invoking).toBe(false);
      expect(registry.getState().pendingControllers.size).toBe(0);
      expect(call).toHaveBeenCalledOnce();
    },
  );

  it.each(["compare", "read-only", "scope", "source reopen"])(
    "records a resolved App call when %s changes before its result is displayed",
    async (change) => {
      if (change === "source reopen") {
        useActiveChatSessionStore.setState({ sessionId: "fork-row" });
      }
      const invocationSessionId = useActiveChatSessionStore.getState().sessionId;
      const addLog = vi.spyOn(useTrafficLogStore.getState(), "addLog");
      const { result, call } = await mount();
      const completed = Promise.withResolvers<typeof answer>();
      call.mockReturnValueOnce(completed.promise);
      let pending: Promise<void> = Promise.resolve();
      act(() => { pending = result.current.run(); });
      await act(async () => {
        completed.resolve(answer);
        await Promise.resolve();
        flushSync(() => useActiveChatSessionStore.setState(
          change === "compare" ? { compareActive: true }
            : change === "read-only" ? { viewOnly: true }
              : change === "scope" ? { sessionId: "other", appSessionScopeId: "other" }
                : { sessionId: "chat-1" },
        ));
        await pending;
      });
      expect(call).toHaveBeenCalledOnce();
      expect(result.current.result).toBeNull();
      expect(useAppToolInvocationLog.getState().records).toEqual([
        expect.objectContaining({
          raw: answer,
          chatSessionId: invocationSessionId,
          appSessionScopeId: "chat-1",
          initiatedBy: "user",
        }),
      ]);
      expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        method: "tools/call",
        message: expect.objectContaining({
          chatSessionId: invocationSessionId,
          appSessionScopeId: "chat-1",
          result: { content: answer.content },
        }),
      }));
      expect(track).toHaveBeenCalledExactlyOnceWith(
        "app_builder_tool_executed",
        expect.objectContaining({ success: true }),
      );
    },
  );

  it("keeps the rail on a conflict but clears it when the user reopens the source", async () => {
    const { result, call } = await mount();
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    await act(async () => result.current.run());
    const selection = result.current.selectedKey;
    const completed = result.current.result;
    const runFromFork = result.current.run;
    expect(completed?.ok).toBe(true);

    act(() => useActiveChatSessionStore.setState({ sessionId: "fork-row" }));
    expect(result.current.selectedKey).toBe(selection);
    expect(
      result.current.fields.find((field) => field.name === "san")?.value,
    ).toBe("e4");
    expect(result.current.result).toEqual(completed);

    act(() => useActiveChatSessionStore.setState({ sessionId: "chat-1" }));
    expect(result.current.selectedKey).toBeNull();
    expect(result.current.fields).toEqual([]);
    expect(result.current.result).toBeNull();

    act(() => result.current.select(result.current.groups[0].tools[0].key));
    await act(async () => runFromFork());
    expect(call).toHaveBeenCalledOnce();
  });

  it("preserves selected detail, input draft and completed result across read-only and writable transitions", async () => {
    const { result, call } = await mount();
    act(() => result.current.detailProps?.onFieldChange("san", "e4"));
    const key = result.current.selectedKey;
    await act(async () => result.current.run());
    const completed = result.current.result;
    expect(completed?.ok).toBe(true);
    const writableRun = result.current.run;
    act(() => useActiveChatSessionStore.setState({ viewOnly: true }));
    expect(result.current.selectedKey).toBe(key);
    expect(result.current.fields.find((field) => field.name === "san")?.value).toBe("e4");
    expect(result.current.result).toEqual(completed);
    expect(result.current.canRun).toBe(false);
    expect(result.current.detailProps?.status).toBe("This session only allows viewing.");
    await act(async () => { await writableRun(); await result.current.run(); });
    expect(call).toHaveBeenCalledOnce();
    act(() => useActiveChatSessionStore.setState({ viewOnly: false }));
    expect(result.current.selectedKey).toBe(key);
    expect(result.current.result).toEqual(completed);
    expect(result.current.canRun).toBe(true);
    await act(async () => result.current.run());
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith({ name: "make_move", arguments: { san: "e4" } });
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
          ? useActiveChatSessionStore.getState().setSessionId("chat-2")
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
    act(() => useActiveChatSessionStore.getState().setSessionId("chat-2"));
    act(() => useActiveChatSessionStore.getState().setSessionId("chat-1"));
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
