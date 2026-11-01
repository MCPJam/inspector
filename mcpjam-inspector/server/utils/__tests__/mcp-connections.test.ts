import { taskConnectionKey } from "../task-connection-key.js";
import { getManagerTaskOwnerScope, removeServerConnections, setManagerTaskOwnerScope } from "../mcp-connections.js";
import { describe, expect, it, vi } from "vitest";
import { listBaseServers, registerLocalConnectionScope, revokeLocalConnection, setManagerConnections } from "../mcp-connections.js";

describe("local account aliases", () => {
  it("keeps user-typed hashes and revokes only the selected scoped account", async () => {
    const base = "name#hash";
    const a = { serverId: base, connectionId: "a".repeat(32), key: base + "#" + "a".repeat(32), label: "A", isDefault: true };
    const b = { ...a, connectionId: "b".repeat(32), key: base + "#" + "b".repeat(32), label: "B", isDefault: false };
    const manager = { listServers: () => [base, a.key, b.key, "user#name"], removeServer: vi.fn() } as any;
    setManagerConnections(manager, { [base]: [a, b] });
    registerLocalConnectionScope(manager, base, { projectId: "project", serverId: "catalog-id" });
    expect(listBaseServers(manager)).toEqual([base, "user#name"]);
    await revokeLocalConnection(manager, "foreign-project", "catalog-id", b.connectionId);
    expect(manager.removeServer).not.toHaveBeenCalled();
    await revokeLocalConnection(manager, "project", "catalog-id", b.connectionId);
    expect(manager.removeServer).toHaveBeenCalledExactlyOnceWith(b.key);
    manager.removeServer.mockClear();
    await revokeLocalConnection(manager, "project", "catalog-id", a.connectionId);
    expect(manager.removeServer.mock.calls).toEqual([[base], [a.key]]);
  });
});

describe("Task owner metadata", () => {
  it("clears only the revoked account's binding", async () => {
    const manager = {
      removeServer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof setManagerConnections>[0];
    const a = {
      serverId: "server",
      connectionId: "a",
      key: "server",
      label: "A",
      isDefault: true,
    };
    const b = {
      serverId: "server",
      connectionId: "b",
      key: "server#b",
      label: "B",
      isDefault: false,
    };
    setManagerConnections(manager, { server: [a, b] });
    registerLocalConnectionScope(manager, "server", {
      projectId: "project",
      serverId: "canonical",
    });
    setManagerTaskOwnerScope(manager, [a.key, b.key], "owner");
    await revokeLocalConnection(manager, "project", "canonical", "b");
    expect(getManagerTaskOwnerScope(manager, a.key)).toBe("owner");
    expect(getManagerTaskOwnerScope(manager, b.key)).toBeUndefined();
    await revokeLocalConnection(manager, "project", "canonical", "a");
    expect(getManagerTaskOwnerScope(manager, a.key)).toBeUndefined();
  });
  it("resolves a canonical server through its local alias without trusting a renamed display label", () => {
    const manager = {
      listServers: () => ["Display#account"],
      getConnectionStatus: () => "connected",
    } as unknown as Parameters<typeof setManagerConnections>[0];
    const row = {
      serverId: "canonical",
      connectionId: "account",
      key: "Display#account",
      label: "Account",
    };
    setManagerConnections(manager, { Display: [row] });
    registerLocalConnectionScope(manager, "Display", {
      projectId: "project",
      serverId: "canonical",
    });
    setManagerTaskOwnerScope(manager, [row.key], "owner");
    expect(
      taskConnectionKey(manager, {
        serverId: "canonical",
        connectionId: "account",
        ownerScope: "owner",
      }),
    ).toBe(row.key);
    expect(() =>
      taskConnectionKey(manager, {
        serverId: "different",
        connectionId: "account",
        ownerScope: "owner",
      }),
    ).toThrow();
  });

  it("does not retain removed or failed aliases during canonical lookup", async () => {
    const live = new Set(["Old"]);
    const manager = {
      listServers: () => [...live, "Failed"],
      getConnectionStatus: (key: string) => key === "Failed" ? "failed" : "connected",
      removeServer: vi.fn(async (key: string) => {
        live.delete(key);
      }),
    } as unknown as Parameters<typeof setManagerConnections>[0];
    registerLocalConnectionScope(manager, "Old", {
      projectId: "project",
      serverId: "canonical",
    });
    setManagerTaskOwnerScope(manager, ["Old"], "owner");
    await removeServerConnections(manager, "Old");
    live.delete("Old");
    registerLocalConnectionScope(manager, "Failed", {
      projectId: "project",
      serverId: "canonical",
    });
    registerLocalConnectionScope(manager, "New", {
      projectId: "project",
      serverId: "canonical",
    });
    live.add("New");
    setManagerTaskOwnerScope(manager, ["New"], "owner");
    expect(
      taskConnectionKey(manager, {
        serverId: "canonical",
        ownerScope: "owner",
      }),
    ).toBe("New");
  });
});