import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEphemeralClient } from "../src/operations.js";

const calls = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../src/mcp-client-manager/index.js", async (original) => ({
  ...(await original<typeof import("../src/mcp-client-manager/index.js")>()),
  MCPClientManager: class {
    connectToServer = calls.connect;
    disconnectAllServers = calls.disconnect;
    listTools = calls.list;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  calls.connect.mockResolvedValue({});
  calls.disconnect.mockResolvedValue(undefined);
  calls.list.mockResolvedValue({ tools: [] });
});

describe("ephemeral cancellation", () => {
  it("closes a pending connection and forbids a callback from starting more requests", async () => {
    const controller = new AbortController();
    let continueWork!: () => void;
    const waiting = new Promise<void>((resolve) => {
      continueWork = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let lateError: unknown;
    const run = withEphemeralClient(
      { command: "unused" },
      async (manager, serverId) => {
        started();
        await waiting;
        try {
          await manager.listTools(serverId);
        } catch (error) {
          lateError = error;
        }
      },
      { signal: controller.signal }
    );
    await ready;
    controller.abort(new Error("deadline"));
    await expect(run).rejects.toThrow("deadline");
    expect(calls.disconnect).toHaveBeenCalledTimes(1);
    continueWork();
    await Promise.resolve();
    expect(calls.list).not.toHaveBeenCalled();
    expect(lateError).toEqual(new Error("deadline"));
  });
  it("passes cancellation into connection establishment", async () => {
    const controller = new AbortController();
    await withEphemeralClient({ command: "unused" }, async () => undefined, {
      signal: controller.signal,
    });
    expect(calls.connect).toHaveBeenCalledWith(
      "unused",
      { command: "unused" },
      { signal: controller.signal }
    );
  });
});
