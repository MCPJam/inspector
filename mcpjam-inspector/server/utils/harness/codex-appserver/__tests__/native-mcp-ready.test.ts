import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeMcpRuntime } from "../bridge/native-mcp-refresh";
import { waitForMcpStartup, waitForNativeMcpServers } from "../bridge/native-mcp-ready";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names";

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

it("waits for the retained relay even when no native servers are configured", async () => {
  const f = fixture();
  f.runtime.request
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValue({ data: [{ ...ready.data[0], name: RELAY_MCP_SERVER_NAME }] });
  let started = false;
  const pending = waitForMcpStartup({ ...f.options, serverNames: [] }).then(() => {
    started = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(f.runtime.request).toHaveBeenLastCalledWith("mcpServerStatus/list", {
    threadId: "thread",
    serverName: RELAY_MCP_SERVER_NAME,
    detail: "toolsAndAuthOnly",
  });
});

it("checks the retained relay and every forwarded server before startup completes", async () => {
  const f = fixture();
  f.runtime.request.mockResolvedValue({
    data: [ready.data[0], { ...ready.data[0], name: RELAY_MCP_SERVER_NAME }],
  });
  await waitForMcpStartup(f.options);
  expect(f.runtime.request).toHaveBeenNthCalledWith(1, "mcpServerStatus/list", {
    threadId: "thread",
    serverName: RELAY_MCP_SERVER_NAME,
    detail: "toolsAndAuthOnly",
  });
  expect(f.runtime.request).toHaveBeenNthCalledWith(2, "mcpServerStatus/list", {
    threadId: "thread",
    serverName: "server",
    detail: "toolsAndAuthOnly",
  });
});

it("refuses startup when the retained relay fails discovery", async () => {
  const f = fixture();
  f.runtime.request.mockResolvedValue({
    data: [{ ...ready.data[0], name: RELAY_MCP_SERVER_NAME, toolsError: "private" }],
  });
  await expect(waitForMcpStartup({ ...f.options, serverNames: [] })).rejects.toThrow(
    "configured native MCP servers did not become ready",
  );
});

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
