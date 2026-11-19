import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  checkTurnWithReuse,
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

describe("checkTurnWithReuse", () => {
  it("reuses a pass for the same turn within 2 s, then checks again", async () => {
    let now = 1_000;
    const check = vi.fn(async () => undefined);
    await checkTurnWithReuse("turn-a", check, () => now);
    now += 1_999;
    await checkTurnWithReuse("turn-a", check, () => now);
    expect(check).toHaveBeenCalledTimes(1);
    now += 1;
    await checkTurnWithReuse("turn-a", check, () => now);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never reuses a refusal, and a refusal forgets an earlier pass", async () => {
    const refusal = new Response(null, { status: 401 });
    const now = () => 5_000;
    await checkTurnWithReuse("turn-b", async () => undefined, now);
    resetHarnessMcpTurnCache();
    const refuse = vi.fn(async () => refusal);
    expect(await checkTurnWithReuse("turn-b", refuse, now)).toBe(refusal);
    expect(await checkTurnWithReuse("turn-b", refuse, now)).toBe(refusal);
    expect(refuse).toHaveBeenCalledTimes(2);
  });

  it("keeps turns apart", async () => {
    const check = vi.fn(async () => undefined);
    await checkTurnWithReuse("turn-c", check);
    await checkTurnWithReuse("turn-d", check);
    expect(check).toHaveBeenCalledTimes(2);
  });
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
