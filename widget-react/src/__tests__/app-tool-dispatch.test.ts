import { describe, expect, it, vi } from "vitest";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dispatchAppToolCall } from "../app-tool-dispatch";
import type { AppInstance } from "../app-tools-registry";

function fixture(toolSource?: AppInstance["toolSource"]) {
  const bridge = new AppBridge(null, { name: "test", version: "1" }, {});
  const result = { content: [{ type: "text" as const, text: "done" }] };
  const call = vi.spyOn(bridge, "callTool").mockResolvedValue(result);
  const request = vi.spyOn(bridge, "request").mockResolvedValue(result);
  const instance: AppInstance = {
    bridge,
    bridgeId: "bridge",
    parentToolCallId: "render",
    serverId: "server",
    appName: "test",
    surface: "inline",
    tools: [],
    registeredAtMs: 0,
    toolSource,
  };
  return {
    entry: { bridge, instance, rawName: "move", readOnly: false },
    call,
    request,
    result,
  };
}
describe("app tool dispatch", () => {
  it("keeps absent and legacy sources on the existing call", async () => {
    for (const source of [undefined, "mcp-apps"] as const) {
      const f = fixture(source);
      expect(await dispatchAppToolCall(f.entry, { move: "e4" })).toEqual(
        f.result,
      );
      expect(f.call).toHaveBeenCalledWith({
        name: "move",
        arguments: { move: "e4" },
      });
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it("uses the reserved method for WebMCP and never retries failures", async () => {
    const f = fixture("webmcp");
    f.request.mockRejectedValue(new Error("execution failed"));
    await expect(dispatchAppToolCall(f.entry, {})).rejects.toThrow(
      "execution failed",
    );
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0]).toEqual({
      method: "ui/sandbox-call-tool",
      params: { name: "move", arguments: {} },
    });
    expect(f.call).not.toHaveBeenCalled();
  });
  it("settles teardown even when a legacy view never responds", async () => {
    const f = fixture();
    f.call.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = dispatchAppToolCall(
      f.entry,
      {},
      { signal: controller.signal },
    );
    controller.abort(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
  });
  it.each(["success", "tool-error", "rejected"] as const)(
    "observes a late %s after cancellation without dispatching again",
    async (outcome) => {
      const f = fixture();
      let resolve!: (value: typeof f.result) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<typeof f.result>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      f.call.mockReturnValueOnce(promise);
      const controller = new AbortController();
      const onSettled = vi.fn();
      const pending = dispatchAppToolCall(f.entry, {}, {
        signal: controller.signal,
        onSettled,
      });
      controller.abort(new Error("closed"));
      await expect(pending).rejects.toThrow("closed");
      expect(onSettled).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        const error = new Error("late failure");
        reject(error);
        await Promise.resolve();
        expect(onSettled).toHaveBeenCalledExactlyOnceWith({
          status: "rejected",
          reason: error,
        });
      } else {
        const value = { ...f.result, isError: outcome === "tool-error" };
        resolve(value);
        await Promise.resolve();
        expect(onSettled).toHaveBeenCalledExactlyOnceWith({
          status: "fulfilled",
          value,
        });
      }
      expect(f.call).toHaveBeenCalledOnce();
    },
  );
  it.each(["signal", "waitSignal"] as const)(
    "does not report or dispatch with an already cancelled %s",
    async (signalOption) => {
      const f = fixture();
      const controller = new AbortController();
      const onSettled = vi.fn();
      controller.abort(new Error("closed"));
      await expect(
        dispatchAppToolCall(f.entry, {}, {
          [signalOption]: controller.signal,
          onSettled,
        }),
      ).rejects.toThrow("closed");
      expect(f.call).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
    },
  );
  it("can cancel the wire after independently stopping its waiter", async () => {
    const f = fixture("webmcp");
    f.request.mockRestore();
    const [host, app] = InMemoryTransport.createLinkedPair();
    const received = vi.fn();
    app.onmessage = received;
    await f.entry.bridge.connect(host);
    await app.start();
    try {
      const wire = new AbortController();
      const waiter = new AbortController();
      const onSettled = vi.fn();
      const pending = dispatchAppToolCall(f.entry, {}, {
        signal: wire.signal,
        waitSignal: waiter.signal,
        onSettled,
      });
      waiter.abort(new Error("stop waiting"));
      await expect(pending).rejects.toThrow("stop waiting");
      expect(onSettled).not.toHaveBeenCalled();
      expect(received).toHaveBeenCalledOnce();

      wire.abort(new Error("wire closed"));
      await vi.waitFor(() =>
        expect(onSettled).toHaveBeenCalledExactlyOnceWith({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringContaining("wire closed"),
          }),
        }),
      );
      expect(received).toHaveBeenCalledTimes(2);
      expect(received.mock.calls[1][0]).toMatchObject({
        method: "notifications/cancelled",
      });
    } finally {
      await f.entry.bridge.close();
    }
  });
  it("reports synchronous bridge failure exactly once", async () => {
    const f = fixture();
    const error = new Error("sync failure");
    f.call.mockImplementation(() => {
      throw error;
    });
    const onSettled = vi.fn();
    await expect(
      dispatchAppToolCall(f.entry, {}, { onSettled }),
    ).rejects.toBe(error);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({
      status: "rejected",
      reason: error,
    });
    expect(f.call).toHaveBeenCalledOnce();
  });
  it("observes WebMCP outcomes without forwarding the observer to the bridge", async () => {
    const f = fixture("webmcp");
    const controller = new AbortController();
    const onSettled = vi.fn();
    const raw = await dispatchAppToolCall(f.entry, {}, {
      signal: controller.signal,
      onSettled,
    });
    expect(f.request.mock.calls[0][2]).toEqual({ signal: controller.signal });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({
      status: "fulfilled",
      value: raw,
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
  });
});
