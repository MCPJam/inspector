import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createAppToolsRegistry } from "../app-tools-registry";
import { createAppToolDiscovery } from "../app-tool-discovery";

const move = {
  name: "move",
  description: "Move",
  inputSchema: { type: "object" as const },
};
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
function fixture(legacy = false) {
  const bridge = new AppBridge(null, { name: "test", version: "1" }, {});
  vi.spyOn(bridge, "getAppCapabilities").mockReturnValue(
    legacy ? { tools: {} } : {},
  );
  const list = vi
    .spyOn(bridge, "listTools")
    .mockResolvedValue({ tools: [move] });
  const request = vi
    .spyOn(bridge, "request")
    .mockResolvedValue({ tools: [move] });
  const registry = createAppToolsRegistry();
  const onError = vi.fn();
  const refresh = createAppToolDiscovery({
    registry,
    onError,
    context: () => ({
      chatSessionId: "chat",
      parentToolCallId: "render",
      serverId: "server",
    }),
  });
  return { bridge, list, request, registry, onError, refresh };
}

describe.each(["inline", "modal"] as const)("%s discovery", (surface) => {
  it("registers WebMCP tools with source and keeps legacy requests separate", async () => {
    const f = fixture();
    await f.refresh(f.bridge, "bridge", { surface, isLive: () => true });
    expect(f.list).not.toHaveBeenCalled();
    expect(
      f.registry.getState().instancesByBridgeId.get("bridge"),
    ).toMatchObject({ toolSource: "webmcp", surface });
    const legacy = fixture(true);
    await legacy.refresh(legacy.bridge, "legacy", {
      surface,
      isLive: () => true,
    });
    expect(legacy.request).not.toHaveBeenCalled();
    expect(
      legacy.registry.getState().instancesByBridgeId.get("legacy")?.toolSource,
    ).toBe("mcp-apps");
  });

  it("falls back on initial method-not-found and keeps that source", async () => {
    const f = fixture(true);
    f.list.mockRejectedValueOnce(
      Object.assign(new Error("not implemented"), { code: -32601 }),
    );
    await f.refresh(f.bridge, "bridge", { surface, isLive: () => true });
    await f.refresh(f.bridge, "bridge", {
      surface,
      force: true,
      isLive: () => true,
    });
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(
      f.registry.getState().instancesByBridgeId.get("bridge")?.toolSource,
    ).toBe("webmcp");
  });

  it("keeps no registry slot while empty and discovers late registration", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ tools: [] });
    await f.refresh(f.bridge, "bridge", { surface, isLive: () => true });
    expect(f.registry.getState().instancesByBridgeId.size).toBe(0);
    await f.refresh(f.bridge, "bridge", {
      surface,
      force: true,
      isLive: () => true,
    });
    expect(f.registry.getState().snapshotForChatBody("chat")).toHaveLength(1);
  });
});

it("never falls back on timeout, malformed results or later legacy errors", async () => {
  const f = fixture(true);
  f.list.mockRejectedValueOnce(new Error("timeout"));
  await f.refresh(f.bridge, "bridge", { isLive: () => true });
  f.list.mockRejectedValueOnce(
    Object.assign(new Error("later"), { code: -32601 }),
  );
  await f.refresh(f.bridge, "bridge", { force: true, isLive: () => true });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledTimes(2);
});

it("preserves empty-string legacy paging cursors", async () => {
  const f = fixture(true);
  f.list
    .mockResolvedValueOnce({ tools: [move], nextCursor: "" })
    .mockResolvedValueOnce({ tools: [] });
  await f.refresh(f.bridge, "bridge", { isLive: () => true });
  expect(f.list.mock.calls.map((call) => call[0])).toEqual([
    {},
    { cursor: "" },
  ]);
});

it("withdraws WebMCP tools when a refresh cannot validate the live registry", async () => {
  const f = fixture();
  await f.refresh(f.bridge, "bridge", { isLive: () => true });
  f.request.mockResolvedValueOnce({ tools: "invalid" });
  await f.refresh(f.bridge, "bridge", { force: true, isLive: () => true });
  expect(f.registry.getState().instancesByBridgeId.size).toBe(0);
  expect(f.onError).toHaveBeenCalledOnce();
});

it("coalesces change events during discovery and ignores unmounted results", async () => {
  const f = fixture();
  let finish: (value: { tools: (typeof move)[] }) => void = () => {
    throw new Error("not started");
  };
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let live = true;
  const first = f.refresh(f.bridge, "bridge", { isLive: () => live });
  const second = f.refresh(f.bridge, "bridge", {
    force: true,
    isLive: () => live,
  });
  finish({ tools: [] });
  await Promise.all([first, second]);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.registry.getState().snapshotForChatBody("chat")).toHaveLength(1);
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stale = f.refresh(f.bridge, "other", {
    force: true,
    isLive: () => live,
  });
  live = false;
  finish({ tools: [move] });
  await stale;
  expect(f.registry.getState().instancesByBridgeId.has("other")).toBe(false);
});

it("keeps identical tool names on separate renders and retires only the closed render", async () => {
  const registry = createAppToolsRegistry();
  let render = "A";
  const refresh = createAppToolDiscovery({
    registry, onError: error => { throw error; },
    context: () => ({ chatSessionId: "chat", parentToolCallId: render, serverId: "server" }),
  });
  const first = fixture();
  const second = fixture();
  await refresh(first.bridge, "A", { isLive: () => true });
  render = "B";
  await refresh(second.bridge, "B", { isLive: () => true });
  const entries = registry.getState().snapshotForChatBody("chat");
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map(entry => entry.alias)).size).toBe(2);
  const old = entries.find(entry => entry.parentToolCallId === "A")!;
  registry.getState().unregisterInstance("A");
  expect(registry.getState().resolve(old.alias, "chat")).toBeNull();
  expect(registry.getState().snapshotForChatBody("chat")).toHaveLength(1);
  expect(registry.getState().snapshotForChatBody("other-chat")).toHaveLength(0);
});
