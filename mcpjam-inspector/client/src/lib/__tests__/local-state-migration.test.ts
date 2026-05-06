import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_FLAG_KEY,
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
  });
});
