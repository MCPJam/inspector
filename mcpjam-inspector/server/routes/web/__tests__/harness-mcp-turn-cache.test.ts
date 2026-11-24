import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  discardTurnManager,
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

  it("builds the connection again after a request discards it, and disconnects the old one once its requests are done", async () => {
    const old = fakeManager();
    const create = vi.fn(async () => old);
    let release!: () => void;
    const holding = withTurnManager("broken", create, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await withTurnManager("broken", create, async (_, connection) => {
      connection.discard();
    });
    // Another request still holds it.
    expect(old.disconnectAllServers).not.toHaveBeenCalled();
    const fresh = fakeManager();
    create.mockImplementation(async () => fresh);
    expect(await withTurnManager("broken", create, async (m) => m)).toBe(fresh);
    release();
    await holding;
    await vi.waitFor(() => expect(old.disconnectAllServers).toHaveBeenCalledTimes(1));
    expect(fresh.disconnectAllServers).not.toHaveBeenCalled();
  });

  it("builds the connection again after a request throws", async () => {
    const old = fakeManager();
    const create = vi.fn(async () => old);
    await expect(
      withTurnManager("threw", create, async () => {
        throw new Error("upstream session gone");
      }),
    ).rejects.toThrow("upstream session gone");
    await vi.waitFor(() => expect(old.disconnectAllServers).toHaveBeenCalledTimes(1));
    await withTurnManager("threw", create, async () => undefined);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("drops an idle connection at once when the turn's key is discarded", async () => {
    const manager = fakeManager();
    const create = vi.fn(async () => manager);
    await withTurnManager("changed", create, async () => undefined);
    discardTurnManager("changed");
    await vi.waitFor(() => expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1));
    await withTurnManager("changed", create, async () => undefined);
    expect(create).toHaveBeenCalledTimes(2);
    discardTurnManager("no-such-turn");
  });

  it("survives a connection whose disconnect fails when it is retired", async () => {
    vi.useFakeTimers();
    const manager = fakeManager();
    manager.disconnectAllServers.mockRejectedValueOnce(new Error("gone"));
    await withTurnManager("retire", async () => manager, async () => undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
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
