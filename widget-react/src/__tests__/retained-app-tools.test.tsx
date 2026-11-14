import { StrictMode } from "react";
import { useAppToolInvocationLogApi, useAppToolsRegistryApi } from "../app-tools-registry";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createAppToolDiscovery } from "../app-tool-discovery";
import { dispatchAppToolCall } from "../app-tool-dispatch";
import { useWidgetWorkspace, WidgetWorkspaceProvider } from "../widget-workspace";

vi.mock("../mcp-apps-renderer", () => ({ MCPAppsRendererSurface: () => null }));
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Workspace = ReturnType<typeof useWidgetWorkspace>;
function Capture({ capture }: { capture: (workspace: Workspace) => void }) {
  const workspace = useWidgetWorkspace();
  expect(useAppToolsRegistryApi()).toBe(workspace.registry);
  expect(useAppToolInvocationLogApi()).toBe(workspace.invocations);
  capture(workspace);
  return null;
}
async function discover(workspace: Workspace, id: string, target: () => string) {
  const bridge = new AppBridge(null, { name: id, version: "1" }, {});
  vi.spyOn(bridge, "getAppCapabilities").mockReturnValue({ tools: {} });
  vi.spyOn(bridge, "listTools").mockResolvedValue({
    tools: [{ name: "read_view", inputSchema: { type: "object" } }],
  });
  const call = vi.spyOn(bridge, "callTool").mockResolvedValue({
    content: [{ type: "text", text: id }],
  });
  const onError = vi.fn();
  await createAppToolDiscovery({
    registry: workspace.registry,
    context: () => ({
      chatSessionId: workspace.workspaceId,
      getModelChatSessionId: target,
      parentToolCallId: id,
      serverId: "fixture",
    }),
    onError,
  })(bridge, id, { isLive: () => true });
  expect(onError).not.toHaveBeenCalled();
  return call;
}

it("shares retained tools with the chat without sharing surfaces or destroying sibling tools", async () => {
  let chat!: Workspace;
  let global!: Workspace;
  let thread!: Workspace;
  let activeChat = "chat-a";
  function View({ showGlobal = true }: { showGlobal?: boolean }) {
    return (
      <WidgetWorkspaceProvider workspaceId="chat-root">
        <Capture capture={(value) => { chat = value; }} />
        {showGlobal && (
          <WidgetWorkspaceProvider workspaceId="global-owner" inheritAppTools>
            <Capture capture={(value) => { global = value; }} />
          </WidgetWorkspaceProvider>
        )}
        <WidgetWorkspaceProvider workspaceId="thread-owner" inheritAppTools>
          <Capture capture={(value) => { thread = value; }} />
        </WidgetWorkspaceProvider>
      </WidgetWorkspaceProvider>
    );
  }
  const view = render(<StrictMode><View /></StrictMode>);
  expect(global.surfaces).not.toBe(chat.surfaces);
  expect(thread.surfaces).not.toBe(global.surfaces);
  expect(global.registry).toBe(chat.registry);
  expect(thread.registry).toBe(chat.registry);
  const globalCall = await discover(global, "global-bridge", () => activeChat);
  await discover(thread, "thread-bridge", () => "chat-a");
  const first = chat.registry.getState().snapshotForChatBody("chat-a");
  expect(first.map((entry) => entry.bridgeId)).toEqual(["global-bridge", "thread-bridge"]);
  const resolved = chat.registry.getState().resolve(first[0].alias, "chat-a");
  expect(resolved).not.toBeNull();
  if (!resolved) throw new Error("Expected the retained App to resolve");
  expect(await dispatchAppToolCall(resolved, {})).toEqual({
    content: [{ type: "text", text: "global-bridge" }],
  });
  expect(globalCall).toHaveBeenCalledTimes(1);
  activeChat = "chat-b";
  expect(chat.registry.getState().snapshotForChatBody("chat-b").map((entry) => entry.bridgeId)).toEqual(["global-bridge"]);
  expect(chat.registry.getState().resolve(first[1].alias, "chat-b")).toBeNull();
  const globalPending = new AbortController();
  const threadPending = new AbortController();
  chat.registry.getState().registerPendingCall("global-bridge", globalPending);
  chat.registry.getState().registerPendingCall("thread-bridge", threadPending);
  view.rerender(<StrictMode><View showGlobal={false} /></StrictMode>);
  await waitFor(() => expect(globalPending.signal.aborted).toBe(true));
  expect(threadPending.signal.aborted).toBe(false);
  expect(chat.registry.getState().enabled).toBe(true);
  expect(chat.registry.getState().snapshotForChatBody("chat-a").map((entry) => entry.bridgeId)).toEqual(["thread-bridge"]);
  expect(chat.registry.getState().snapshotForChatBody("chat-b")).toEqual([]);
});

it("inherits the legacy chat registry when no workspace surrounds the Playground", async () => {
  let registry!: ReturnType<typeof useAppToolsRegistryApi>;
  let owner!: Workspace;
  function Chat() { registry = useAppToolsRegistryApi(); return null; }
  const view = render(<>
    <Chat />
    <WidgetWorkspaceProvider workspaceId="legacy-retained-owner" inheritAppTools>
      <Capture capture={(value) => { owner = value; }} />
    </WidgetWorkspaceProvider>
  </>);
  expect(owner.registry).toBe(registry);
  await discover(owner, "legacy-retained", () => "legacy-chat");
  expect(registry.getState().snapshotForChatBody("legacy-chat")).toHaveLength(1);
  view.unmount();
  await waitFor(() => expect(registry.getState().snapshotForChatBody("legacy-chat")).toEqual([]));
  expect(registry.getState().enabled).toBe(true);
});

it("keeps default workspace and compare-lane registries isolated", async () => {
  let first!: Workspace;
  let second!: Workspace;
  render(<>
    <WidgetWorkspaceProvider workspaceId="lane-a">
      <Capture capture={(value) => { first = value; }} />
    </WidgetWorkspaceProvider>
    <WidgetWorkspaceProvider workspaceId="lane-b">
      <Capture capture={(value) => { second = value; }} />
    </WidgetWorkspaceProvider>
  </>);
  expect(first.registry).not.toBe(second.registry);
  await act(async () => { await discover(first, "lane-a-bridge", () => "same-chat"); });
  expect(first.registry.getState().snapshotForChatBody("same-chat")).toHaveLength(1);
  expect(second.registry.getState().snapshotForChatBody("same-chat")).toEqual([]);
});
