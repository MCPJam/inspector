import { describe, expect, it, vi } from "vitest";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
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
});
