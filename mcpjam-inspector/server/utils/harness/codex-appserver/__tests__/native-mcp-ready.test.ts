import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeMcpRuntime } from "../bridge/native-mcp-refresh";
import { waitForNativeMcpServers } from "../bridge/native-mcp-ready";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const runtime = {
    request: vi.fn<NativeMcpRuntime["request"]>(),
    kill: vi.fn(async () => undefined),
  };
  const controller = new AbortController();
  return {
    runtime,
    controller,
    options: {
      runtime,
      signal: controller.signal,
      threadId: "thread",
      serverNames: ["server"],
    },
  };
}

const ready = {
  data: [
    {
      name: "server",
      runtimeStatus: "connected",
      tools: {},
      toolsError: null,
      authStatus: "unsupported",
    },
  ],
};

it("accepts an empty ready inventory on the exact thread and server", async () => {
  const f = fixture();
  f.runtime.request.mockResolvedValue(ready);
  await waitForNativeMcpServers(f.options);
  expect(f.runtime.request).toHaveBeenCalledWith("mcpServerStatus/list", {
    threadId: "thread",
    serverName: "server",
    detail: "toolsAndAuthOnly",
  });
  expect(f.runtime.kill).not.toHaveBeenCalled();
});

it("waits for matching inventory instead of accepting an unrelated server", async () => {
  const f = fixture();
  f.runtime.request
    .mockResolvedValueOnce({ data: [{ ...ready.data[0], name: "other" }] })
    .mockResolvedValue(ready);
  const pending = waitForNativeMcpServers(f.options);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(f.runtime.request).toHaveBeenCalledTimes(2);
});

it("rejects failed tool discovery without exposing its error", async () => {
  const f = fixture();
  f.runtime.request.mockResolvedValue({
    data: [{ ...ready.data[0], toolsError: "private upstream detail" }],
  });
  await expect(waitForNativeMcpServers(f.options)).rejects.toThrow(
    "configured native MCP servers did not become ready",
  );
});

it.each(["timeout", "abort"])(
  "bounds a blocked status request on %s",
  async (reason) => {
    const f = fixture();
    f.runtime.request.mockImplementation(() => new Promise(() => {}));
    const failed = expect(
      waitForNativeMcpServers({ ...f.options, timeoutMs: 20 }),
    ).rejects.toThrow("did not become ready");
    if (reason === "abort") f.controller.abort();
    else await vi.advanceTimersByTimeAsync(20);
    await failed;
  },
);
