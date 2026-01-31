/**
 * Tests for the getServerByIdOrName lookup logic.
 *
 * The function lives inside useAppState as a useCallback, so we test the
 * pure logic here rather than the hook wrapper.
 */
import { describe, it, expect } from "vitest";
import type { ServerWithName } from "../app-types.js";

function createServer(
  name: string,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    id: overrides.id ?? name,
    name,
    config: { command: "node", args: ["server.js"] },
    connectionStatus: "disconnected",
    lastConnectionTime: new Date("2024-01-01"),
    retryCount: 0,
    enabled: false,
    ...overrides,
  } as ServerWithName;
}

/**
 * Pure implementation of getServerByIdOrName matching use-app-state.ts:451-466
 */
function getServerByIdOrName(
  idOrName: string | undefined,
  appServers: Record<string, ServerWithName>,
  effectiveServers: Record<string, ServerWithName>,
): ServerWithName | undefined {
  if (!idOrName) return undefined;
  return (
    appServers[idOrName] ||
    Object.values(appServers).find((server) => server.name === idOrName) ||
    effectiveServers[idOrName] ||
    Object.values(effectiveServers).find((server) => server.name === idOrName)
  );
}

describe("getServerByIdOrName", () => {
  const serverA = createServer("Alpha", { id: "uuid-a" });
  const serverB = createServer("Beta", { id: "uuid-b" });
  const appServers = { "uuid-a": serverA, "uuid-b": serverB };

  const workspaceServer = createServer("Gamma", { id: "uuid-c" });
  const effectiveServers = { "uuid-c": workspaceServer };

  it("finds server by direct ID lookup in appServers", () => {
    expect(getServerByIdOrName("uuid-a", appServers, {})).toBe(serverA);
  });

  it("finds server by name search in appServers", () => {
    expect(getServerByIdOrName("Beta", appServers, {})).toBe(serverB);
  });

  it("falls back to direct ID lookup in effectiveServers", () => {
    expect(getServerByIdOrName("uuid-c", {}, effectiveServers)).toBe(
      workspaceServer,
    );
  });

  it("falls back to name search in effectiveServers", () => {
    expect(getServerByIdOrName("Gamma", {}, effectiveServers)).toBe(
      workspaceServer,
    );
  });

  it("returns undefined for non-existent server", () => {
    expect(
      getServerByIdOrName("nope", appServers, effectiveServers),
    ).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(
      getServerByIdOrName(undefined, appServers, effectiveServers),
    ).toBeUndefined();
  });

  it("prefers appServers ID match over effectiveServers", () => {
    const dup = createServer("Dup", { id: "shared-id" });
    const dup2 = createServer("Dup2", { id: "shared-id" });
    expect(
      getServerByIdOrName(
        "shared-id",
        { "shared-id": dup },
        { "shared-id": dup2 },
      ),
    ).toBe(dup);
  });

  it("prefers appServers name match over effectiveServers name match", () => {
    const s1 = createServer("Same Name", { id: "id-1" });
    const s2 = createServer("Same Name", { id: "id-2" });
    expect(
      getServerByIdOrName("Same Name", { "id-1": s1 }, { "id-2": s2 }),
    ).toBe(s1);
  });

  it("prefers ID match over name match", () => {
    // serverA has id "uuid-a" and name "Alpha"
    // Create a server whose name is "uuid-a" to test priority
    const trickServer = createServer("uuid-a", { id: "other-id" });
    const servers = { "uuid-a": serverA, "other-id": trickServer };
    // Should return serverA (direct ID match) not trickServer (name match)
    expect(getServerByIdOrName("uuid-a", servers, {})).toBe(serverA);
  });
});
