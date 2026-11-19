import { describe, expect, it, vi } from "vitest";
import { createAppToolsRegistry, type AppInstance } from "@mcpjam/widget-react";
import { makeAppInstance } from "@/test/factories";
import { fulfillHarnessAppTool } from "../fulfill-harness-app-tool";

async function setup(overrides: Partial<AppInstance> = {}) {
  const registry = createAppToolsRegistry();
  const instance = makeAppInstance({ chatSessionId: "chat", ...overrides });
  const call = vi.spyOn(instance.bridge, "callTool").mockResolvedValue({
    content: [{ type: "text", text: "visible" }],
    structuredContent: { private: true },
    _meta: { secret: true },
  });
  await registry.getState().registerInstance(instance);
  const descriptor = registry.getState().snapshotForChatBody("chat")[0];
  const event = {
    id: "invocation",
    chatSessionId: "chat",
    alias: descriptor.alias,
    bridgeId: instance.bridgeId,
    expiresAt: Date.now() + 30_000,
  };
  let claimed = false;
  const claim = vi.fn(async () => {
    if (claimed) return null;
    claimed = true;
    return {
      projectId: "project",
      expiresAt: event.expiresAt,
      ...descriptor,
      bridgeId: instance.bridgeId,
      inputJson: "{}",
      chatSessionId: "chat",
    };
  });
  const complete = vi.fn(
    async (_args: { id: string; claim: string; resultJson: string }) =>
      undefined,
  );
  return {
    registry,
    instance,
    call,
    event,
    claim,
    complete,
    chatSessionId: () => "chat",
  };
}
describe("native app-tool fulfillment", () => {
  it("dispatches a global App in the current chat and refuses its old chat after a switch", async () => {
    let targetChat = "chat";
    const s = await setup({
      chatSessionId: "global-workspace",
      getModelChatSessionId: () => targetChat,
    });
    await fulfillHarnessAppTool(s.event, s);
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.registry.getState().instancesByBridgeId.get(s.instance.bridgeId)).toBe(s.instance);

    const stale = await setup({
      chatSessionId: "global-workspace",
      getModelChatSessionId: () => targetChat,
    });
    targetChat = "other-chat";
    await fulfillHarnessAppTool(stale.event, stale);
    expect(stale.call).not.toHaveBeenCalled();
    expect(JSON.parse(stale.complete.mock.calls[0][0].resultJson).isError).toBe(true);
    expect(stale.registry.getState().snapshotForChatBody("chat")).toEqual([]);
    expect(stale.registry.getState().snapshotForChatBody("other-chat")).toHaveLength(1);
  });
  it("claims once, dispatches the exact live instance, and excludes private model data", async () => {
    const s = await setup();
    await Promise.all([
      fulfillHarnessAppTool(s.event, s),
      fulfillHarnessAppTool(s.event, s),
    ]);
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.complete.mock.calls[0][0].resultJson)).toEqual({
      content: [{ type: "text", text: "visible" }],
    });
  });
  it("refuses a different chat and a replaced generation", async () => {
    const s = await setup();
    await fulfillHarnessAppTool({ ...s.event, chatSessionId: "other" }, s);
    expect(s.claim).not.toHaveBeenCalled();
    s.registry.getState().unregisterInstance(s.instance.bridgeId);
    await s.registry
      .getState()
      .registerInstance(
        makeAppInstance({ chatSessionId: "chat", bridgeId: "new" }),
      );
    await fulfillHarnessAppTool(s.event, s);
    expect(s.call).not.toHaveBeenCalled();
    expect(JSON.parse(s.complete.mock.calls[0][0].resultJson).isError).toBe(
      true,
    );
  });
  it("aborts on close and never retries a lost response", async () => {
    const s = await setup();
    s.call.mockImplementation(() => new Promise(() => {}));
    s.complete.mockRejectedValue(new Error("response lost"));
    const pending = fulfillHarnessAppTool(s.event, s);
    await vi.waitFor(() => expect(s.call).toHaveBeenCalledTimes(1));
    s.registry.getState().unregisterInstance(s.instance.bridgeId);
    await expect(pending).rejects.toThrow("response lost");
    await fulfillHarnessAppTool(s.event, s);
    expect(s.call).toHaveBeenCalledTimes(1);
  });
  it("retries delivery of the same result without dispatching the app twice", async () => {
    const s = await setup();
    s.complete.mockRejectedValueOnce(new Error("temporary network failure"));
    await fulfillHarnessAppTool(s.event, s);
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.complete).toHaveBeenCalledTimes(2);
    expect(s.complete.mock.calls[0][0]).toEqual(s.complete.mock.calls[1][0]);
  });
});
