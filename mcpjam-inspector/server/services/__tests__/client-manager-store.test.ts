import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  SessionClientManagerStore,
  SingletonClientManagerStore,
} from "../client-manager-store.js";

type FakeManager = {
  listServers: ReturnType<typeof vi.fn>;
  getClient: ReturnType<typeof vi.fn>;
  disconnectServer: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
};

function createFakeManager(serverIds: string[] = []): FakeManager {
  return {
    listServers: vi.fn().mockReturnValue(serverIds),
    getClient: vi
      .fn()
      .mockImplementation((serverId: string) =>
        serverIds.includes(serverId) ? {} : null,
      ),
    disconnectServer: vi.fn().mockResolvedValue(undefined),
    removeServer: vi.fn(),
  };
}

describe("SingletonClientManagerStore", () => {
  it("reuses the same manager for all session keys", () => {
    const manager = createFakeManager() as unknown as MCPClientManager;
    const managerFactory = vi.fn().mockReturnValue(manager);
    const store = new SingletonClientManagerStore(managerFactory);

    const first = store.getManager("session-a");
    const second = store.getManager("session-b");

    expect(first).toBe(second);
    expect(first).toBe(manager);
    expect(managerFactory).toHaveBeenCalledTimes(1);
  });
});

describe("SessionClientManagerStore", () => {
  it("creates isolated managers per session key", () => {
    const managerFactory = vi
      .fn()
      .mockReturnValueOnce(createFakeManager() as unknown as MCPClientManager)
      .mockReturnValueOnce(createFakeManager() as unknown as MCPClientManager);
    const store = new SessionClientManagerStore(managerFactory, {
      ttlMs: 60_000,
      sweepIntervalMs: 1,
      maxEntries: 10,
      now: () => 1_000,
    });

    const firstA = store.getManager("session-a");
    const secondA = store.getManager("session-a");
    const firstB = store.getManager("session-b");

    expect(firstA).toBe(secondA);
    expect(firstA).not.toBe(firstB);
    expect(managerFactory).toHaveBeenCalledTimes(2);
  });

  it("evicts expired session managers and disconnects servers", async () => {
    const expiredManager = createFakeManager(["s1", "s2"]);
    const activeManager = createFakeManager();
    let now = 0;

    const managerFactory = vi
      .fn()
      .mockReturnValueOnce(expiredManager as unknown as MCPClientManager)
      .mockReturnValueOnce(activeManager as unknown as MCPClientManager);
    const store = new SessionClientManagerStore(managerFactory, {
      ttlMs: 1_000,
      sweepIntervalMs: 0,
      maxEntries: 10,
      now: () => now,
    });

    store.getManager("old");
    now = 2_000;
    store.getManager("new");
    await Promise.resolve();

    expect(expiredManager.disconnectServer).toHaveBeenCalledWith("s1");
    expect(expiredManager.disconnectServer).toHaveBeenCalledWith("s2");
    expect(expiredManager.removeServer).toHaveBeenCalledWith("s1");
    expect(expiredManager.removeServer).toHaveBeenCalledWith("s2");
  });

  it("evicts least-recently-used session when capacity is reached", async () => {
    const managerA = createFakeManager(["server-a"]);
    const managerB = createFakeManager();
    let now = 0;

    const managerFactory = vi
      .fn()
      .mockReturnValueOnce(managerA as unknown as MCPClientManager)
      .mockReturnValueOnce(managerB as unknown as MCPClientManager);
    const store = new SessionClientManagerStore(managerFactory, {
      ttlMs: 60_000,
      sweepIntervalMs: 60_000,
      maxEntries: 1,
      now: () => now,
    });

    store.getManager("session-a");
    now = 1_000;
    store.getManager("session-b");
    await Promise.resolve();

    expect(managerA.disconnectServer).toHaveBeenCalledWith("server-a");
    expect(managerA.removeServer).toHaveBeenCalledWith("server-a");
    expect(managerFactory).toHaveBeenCalledTimes(2);
  });
});
