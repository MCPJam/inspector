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
