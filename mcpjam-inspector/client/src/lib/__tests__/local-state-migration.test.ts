import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_FLAG_KEY,
  MIGRATION_PROGRESS_KEY,
  hasMigrationCompleted,
  readLegacyMigrationPayload,
  runLocalStateMigration,
} from "../local-state-migration";

function seedLegacyProjects() {
  localStorage.setItem(
    "mcp-inspector-projects",
    JSON.stringify({
      activeProjectId: "proj-a",
      projects: {
        "proj-a": {
          id: "proj-a",
          name: "Default",
          description: "default",
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          isDefault: true,
          servers: {
            stdio_one: {
              name: "stdio_one",
              enabled: true,
              useOAuth: false,
              config: {
                command: "node",
                args: ["server.js"],
                env: { FOO: "from-config" },
              },
              connectionStatus: "disconnected",
              retryCount: 0,
              lastConnectionTime: 1700000000000,
            },
            http_one: {
              name: "http_one",
              enabled: true,
              useOAuth: false,
              config: {
                url: "http://localhost:3000/mcp",
                requestInit: { headers: { "X-Test": "1" } },
              },
              connectionStatus: "disconnected",
              retryCount: 0,
              lastConnectionTime: 1700000000000,
            },
          },
        },
      },
    })
  );
}

describe("local-state-migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("hasMigrationCompleted", () => {
    it("returns false when flag is unset", () => {
      expect(hasMigrationCompleted()).toBe(false);
    });

    it("returns true when flag is set", () => {
      localStorage.setItem(MIGRATION_FLAG_KEY, "1");
      expect(hasMigrationCompleted()).toBe(true);
    });
  });

  describe("readLegacyMigrationPayload", () => {
    it("returns null when no legacy data exists", () => {
      expect(readLegacyMigrationPayload()).toBeNull();
    });

    it("parses projects + servers", () => {
      seedLegacyProjects();
      const payload = readLegacyMigrationPayload();
      expect(payload).not.toBeNull();
      expect(payload!.projects).toHaveLength(1);
      expect(payload!.projects[0].name).toBe("Default");
      expect(Object.keys(payload!.projects[0].servers)).toEqual(
        expect.arrayContaining(["stdio_one", "http_one"])
      );
    });

    it("captures mcp-env-${name} into envByName", () => {
      seedLegacyProjects();
      localStorage.setItem(
        "mcp-env-stdio_one",
        JSON.stringify({ FOO: "from-env-key", BAR: "extra" })
      );
      const payload = readLegacyMigrationPayload();
      expect(payload!.envByName.stdio_one).toEqual({
        FOO: "from-env-key",
        BAR: "extra",
      });
    });

    it("survives malformed mcp-env entries", () => {
      seedLegacyProjects();
      localStorage.setItem("mcp-env-stdio_one", "not-json");
      const payload = readLegacyMigrationPayload();
      // mcp-env-stdio_one was unparseable; envByName should not have it,
      // but the projects should still parse.
      expect(payload!.envByName.stdio_one).toBeUndefined();
      expect(payload!.projects).toHaveLength(1);
    });

    it("falls back to mcp-inspector-state when no projects/workspaces present", () => {
      // Pre-projects format: servers live at the top level of `mcp-inspector-state`.
      // Without this fallback, users on this format would have the migration
      // mark itself complete with nothing pushed to Convex, then later have
      // their state cleared.
      localStorage.setItem(
        "mcp-inspector-state",
        JSON.stringify({
          servers: {
            legacy_stdio: {
              name: "legacy_stdio",
              enabled: true,
              useOAuth: false,
              config: {
                command: "python",
                args: ["-m", "server"],
              },
              connectionStatus: "disconnected",
              retryCount: 0,
              lastConnectionTime: 1700000000000,
            },
          },
        })
      );
      const payload = readLegacyMigrationPayload();
      expect(payload).not.toBeNull();
      expect(payload!.projects).toHaveLength(1);
      expect(payload!.projects[0].isDefault).toBe(true);
      expect(Object.keys(payload!.projects[0].servers)).toContain("legacy_stdio");
    });

    it("ignores mcp-inspector-state when projects already exist", () => {
      seedLegacyProjects();
      localStorage.setItem(
        "mcp-inspector-state",
        JSON.stringify({ servers: { stale: { name: "stale", config: {} } } })
      );
      const payload = readLegacyMigrationPayload();
      // Projects-format wins; STATE servers are not lifted.
      expect(payload!.projects).toHaveLength(1);
      expect(Object.keys(payload!.projects[0].servers)).not.toContain("stale");
    });

    it("returns null when STATE has no servers field", () => {
      localStorage.setItem(
        "mcp-inspector-state",
        JSON.stringify({ selectedServer: "none" })
      );
      expect(readLegacyMigrationPayload()).toBeNull();
    });
  });

  describe("OAuth key cleanup", () => {
    it("clears mcp-discovery-* keys (current OAuth code) on success", async () => {
      seedLegacyProjects();
      localStorage.setItem(
        "mcp-discovery-stdio_one",
        JSON.stringify({ resource: "https://example.com" })
      );
      localStorage.setItem(
        "mcp-oauth-flow-state-stdio_one",
        JSON.stringify({ state: "abc" })
      );
      const createProject = vi.fn().mockResolvedValue("convex-id");
      const result = await runLocalStateMigration({
        createProject: createProject as any,
      });
      expect(result.ok).toBe(true);
      expect(localStorage.getItem("mcp-discovery-stdio_one")).toBeNull();
      expect(localStorage.getItem("mcp-oauth-flow-state-stdio_one")).toBeNull();
    });
  });

  describe("runLocalStateMigration", () => {
    it("no-ops when no legacy data, sets flag", async () => {
      const createProject = vi.fn();
      const result = await runLocalStateMigration({
        createProject: createProject as any,
      });
      expect(result).toEqual({ ok: true, projectsMigrated: 0, errors: [] });
      expect(createProject).not.toHaveBeenCalled();
      expect(hasMigrationCompleted()).toBe(true);
    });

    it("migrates each project, merges mcp-env into stdio config, clears legacy keys", async () => {
      seedLegacyProjects();
      localStorage.setItem(
        "mcp-env-stdio_one",
        JSON.stringify({ TOKEN: "abc" })
      );
      localStorage.setItem("mcp-tokens-http_one", JSON.stringify({ a: 1 }));
      localStorage.setItem("mcp-oauth-pending", "stdio_one");

      const createProject = vi.fn().mockResolvedValue("convex-proj-id");
      const result = await runLocalStateMigration({
        createProject: createProject as any,
        organizationId: "org_xyz",
      });

      expect(result.ok).toBe(true);
      expect(result.projectsMigrated).toBe(1);
      expect(createProject).toHaveBeenCalledTimes(1);

      const args = createProject.mock.calls[0][0];
      expect(args.name).toBe("Default");
      expect(args.organizationId).toBe("org_xyz");

      const stdio = args.servers.stdio_one;
      expect(stdio.config.command).toBe("node");
      // env merged: from-config plus from-env-key
      expect(stdio.config.env).toEqual({
        FOO: "from-config",
        TOKEN: "abc",
      });

      const http = args.servers.http_one;
      expect(http.config.url).toBe("http://localhost:3000/mcp");
      expect(http.config.requestInit?.headers).toEqual({ "X-Test": "1" });

      // Legacy keys cleared
      expect(localStorage.getItem("mcp-inspector-projects")).toBeNull();
      expect(localStorage.getItem("mcp-env-stdio_one")).toBeNull();
      expect(localStorage.getItem("mcp-tokens-http_one")).toBeNull();
      expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
      // Flag set
      expect(hasMigrationCompleted()).toBe(true);
    });

    it("preserves user-configured HTTP Authorization header through persistence", async () => {
      // A self-hosted MCP server authenticated with a static bearer the user
      // typed into the headers form. The persistence path must keep the
      // Authorization entry, otherwise the migrated Convex project lacks the
      // credential and reconnects fail after legacy localStorage is cleared.
      // Sharing payloads still strip Authorization — covered separately by
      // the share/clone flow.
      localStorage.setItem(
        "mcp-inspector-projects",
        JSON.stringify({
          activeProjectId: "proj-a",
          projects: {
            "proj-a": {
              id: "proj-a",
              name: "Default",
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
              servers: {
                http_static_auth: {
                  name: "http_static_auth",
                  enabled: true,
                  useOAuth: false,
                  config: {
                    url: "http://localhost:3000/mcp",
                    requestInit: {
                      headers: {
                        Authorization: "Bearer user-static-token",
                        "X-Other": "keep",
                      },
                    },
                  },
                  connectionStatus: "disconnected",
                  retryCount: 0,
                  lastConnectionTime: 1700000000000,
                },
              },
            },
          },
        })
      );

      const createProject = vi.fn().mockResolvedValue("convex-id");
      const result = await runLocalStateMigration({
        createProject: createProject as any,
      });
      expect(result.ok).toBe(true);

      const args = createProject.mock.calls[0][0];
      const http = args.servers.http_static_auth;
      expect(http.config.requestInit?.headers).toEqual({
        Authorization: "Bearer user-static-token",
        "X-Other": "keep",
      });
    });

    it("does NOT clear legacy keys on partial failure", async () => {
      seedLegacyProjects();
      const createProject = vi
        .fn()
        .mockRejectedValue(new Error("Convex unreachable"));
      const result = await runLocalStateMigration({
        createProject: createProject as any,
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].projectName).toBe("Default");
      // Legacy data still there for retry
      expect(localStorage.getItem("mcp-inspector-projects")).not.toBeNull();
      expect(hasMigrationCompleted()).toBe(false);
    });

    it("skips already-migrated projects on retry after partial failure", async () => {
      // Seed two projects. First attempt: proj-a succeeds, proj-b fails.
      localStorage.setItem(
        "mcp-inspector-projects",
        JSON.stringify({
          activeProjectId: "proj-a",
          projects: {
            "proj-a": {
              id: "proj-a",
              name: "Alpha",
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
              servers: {},
            },
            "proj-b": {
              id: "proj-b",
              name: "Beta",
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
              servers: {},
            },
          },
        })
      );

      const createProjectFirst = vi
        .fn()
        .mockResolvedValueOnce("convex-a")
        .mockRejectedValueOnce(new Error("Convex unreachable"));
      const firstResult = await runLocalStateMigration({
        createProject: createProjectFirst as any,
      });
      expect(firstResult.ok).toBe(false);
      expect(firstResult.projectsMigrated).toBe(1);
      expect(createProjectFirst).toHaveBeenCalledTimes(2);
      // Progress recorded for the project that succeeded.
      expect(localStorage.getItem(MIGRATION_PROGRESS_KEY)).toContain("proj-a");

      // Retry: only the failed project should be re-attempted.
      const createProjectRetry = vi.fn().mockResolvedValue("convex-b");
      const retryResult = await runLocalStateMigration({
        createProject: createProjectRetry as any,
      });
      expect(retryResult.ok).toBe(true);
      expect(retryResult.projectsMigrated).toBe(1);
      expect(createProjectRetry).toHaveBeenCalledTimes(1);
      expect(createProjectRetry.mock.calls[0][0].name).toBe("Beta");
      // Successful retry clears legacy + progress keys.
      expect(localStorage.getItem("mcp-inspector-projects")).toBeNull();
      expect(localStorage.getItem(MIGRATION_PROGRESS_KEY)).toBeNull();
      expect(hasMigrationCompleted()).toBe(true);
    });
  });
});
