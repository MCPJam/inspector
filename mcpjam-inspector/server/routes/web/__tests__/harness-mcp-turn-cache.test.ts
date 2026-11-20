import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  harnessMcpTurnCacheEnabled,
  resetHarnessMcpTurnCache,
  withTurnManager,
} from "../harness-mcp-turn-cache.js";

function fakeManager() {
  return { disconnectAllServers: vi.fn(async () => undefined) } as unknown as MCPClientManager & {
    disconnectAllServers: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  resetHarnessMcpTurnCache();
  vi.useRealTimers();
});

describe("withTurnManager", () => {
  it("builds one connection for a turn's concurrent and later requests", async () => {
    const manager = fakeManager();
    const create = vi.fn(async () => manager);
    const results = await Promise.all([
      withTurnManager("k", create, async (m) => m),
      withTurnManager("k", create, async (m) => m),
    ]);
    await withTurnManager("k", create, async (m) => m);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results).toEqual([manager, manager]);
    expect(manager.disconnectAllServers).not.toHaveBeenCalled();
  });

  it("disconnects after the turn has been idle for 20 s", async () => {
    vi.useFakeTimers();
    const manager = fakeManager();
    await withTurnManager("idle", async () => manager, async () => undefined);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(manager.disconnectAllServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
    const next = fakeManager();
    const create = vi.fn(async () => next);
    await withTurnManager("idle", create, async () => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not keep a connection that failed to build", async () => {
    const failing = vi.fn(async () => {
      throw new Error("unreachable");
    });
    await expect(withTurnManager("bad", failing, async () => undefined)).rejects.toThrow("unreachable");
    const manager = fakeManager();
    const create = vi.fn(async () => manager);
    await withTurnManager("bad", create, async () => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("says a connection was reused only when it was already built", async () => {
    let finish!: (manager: MCPClientManager) => void;
    const create = vi.fn(
      () =>
        new Promise<MCPClientManager>((resolve) => {
          finish = resolve;
        }),
    );
    const seen: boolean[] = [];
    const record = async (_: MCPClientManager, connection: { reused: boolean }) => {
      seen.push(connection.reused);
    };
    const first = withTurnManager("ready", create, record);
    // Arrives while the connection is still being built: it waited for it.
    const second = withTurnManager("ready", create, record);
    finish(fakeManager());
    await Promise.all([first, second]);
    await withTurnManager("ready", create, record);
    expect(seen).toEqual([false, false, true]);
  });

  it("keeps different turns on different connections", async () => {
    const create = vi.fn(async () => fakeManager());
    await withTurnManager("turn-1", create, async () => undefined);
    await withTurnManager("turn-2", create, async () => undefined);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("is off unless switched on", () => {
    expect(harnessMcpTurnCacheEnabled({})).toBe(false);
    expect(harnessMcpTurnCacheEnabled({ MCPJAM_HARNESS_MCP_TURN_CACHE: "1" })).toBe(true);
  });
});
