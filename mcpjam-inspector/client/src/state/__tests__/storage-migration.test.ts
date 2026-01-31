/**
 * Tests for loadAppState migration from pre-PR (name-keyed) to post-PR (UUID-keyed) storage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAppState } from "../storage";

// Stable UUID for tests
const MOCK_UUID = "00000000-0000-0000-0000-000000000001";
let uuidCounter = 0;

beforeEach(() => {
  localStorage.clear();
  uuidCounter = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () =>
      `${MOCK_UUID.slice(0, -1)}${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`,
  );
});

describe("loadAppState migration", () => {
  it("migrates old name-keyed servers into a default workspace with UUIDs", () => {
    // Pre-PR format: servers keyed by name, no workspaces
    localStorage.setItem(
      "mcp-inspector-state",
      JSON.stringify({
        servers: {
          "my-server": {
            name: "my-server",
            config: { command: "node", args: ["server.js"] },
          },
        },
        selectedServer: "my-server",
      }),
    );

    const state = loadAppState();

    // Should have a default workspace
    expect(state.workspaces.default).toBeDefined();
    const servers = Object.values(state.workspaces.default.servers);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("my-server");
    // Should have been assigned a UUID id
    expect(servers[0].id).toBeTruthy();
    expect(servers[0].id).not.toBe("my-server");
  });

  it("resolves selectedServer from name to UUID", () => {
    localStorage.setItem(
      "mcp-inspector-state",
      JSON.stringify({
        servers: {
          "my-server": {
            name: "my-server",
            config: { command: "node", args: ["server.js"] },
          },
        },
        selectedServer: "my-server",
      }),
    );

    const state = loadAppState();
    const servers = Object.values(state.workspaces.default.servers);

    // selectedServer should resolve to the server's UUID, not the name
    expect(state.selectedServer).toBe(servers[0].id);
  });

  it("assigns UUID to server missing id field", () => {
    localStorage.setItem(
      "mcp-inspector-state",
      JSON.stringify({
        servers: {
          "no-id-server": {
            name: "no-id-server",
            config: { url: "https://example.com" },
          },
        },
        selectedServer: "none",
      }),
    );

    const state = loadAppState();
    const servers = Object.values(state.workspaces.default.servers);
    expect(servers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("revives URL strings back into URL objects", () => {
    localStorage.setItem(
      "mcp-inspector-state",
      JSON.stringify({
        servers: {
          "http-server": {
            name: "http-server",
            config: { url: "https://example.com/mcp" },
          },
        },
        selectedServer: "none",
      }),
    );

    const state = loadAppState();
    const server = Object.values(state.workspaces.default.servers)[0];
    expect((server.config as any).url).toBeInstanceOf(URL);
  });

  it("returns initialAppState when localStorage is empty", () => {
    const state = loadAppState();
    expect(state.workspaces.default).toBeDefined();
    expect(Object.values(state.workspaces.default.servers)).toHaveLength(0);
  });

  it("preserves existing workspace format (no double migration)", () => {
    const serverId = "existing-uuid-123";
    localStorage.setItem(
      "mcp-inspector-workspaces",
      JSON.stringify({
        activeWorkspaceId: "default",
        workspaces: {
          default: {
            id: "default",
            name: "Default",
            description: "Default workspace",
            servers: {
              [serverId]: {
                id: serverId,
                name: "already-migrated",
                config: { command: "node", args: [] },
              },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isDefault: true,
          },
        },
      }),
    );

    const state = loadAppState();
    const servers = Object.values(state.workspaces.default.servers);
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe(serverId);
    expect(servers[0].name).toBe("already-migrated");
  });
});
