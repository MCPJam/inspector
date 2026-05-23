import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_FLAG_KEY,
  MIGRATION_PROGRESS_KEY,
  hasMigrationCompleted,
  readLegacyMigrationPayload,
  runLocalStateMigration,
} from "../local-state-migration";
import { normalizeImportHostedOAuthTokens } from "@/lib/apis/hosted-oauth-import-tokens-api";

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

    it("falls back to mcp-inspector-state when no projects present", () => {
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

    it("treats unreadable projects store as terminal even when STATE is valid", async () => {
      // If `mcp-inspector-projects` is corrupt but `mcp-inspector-state` has
      // a valid pre-projects payload, we must NOT silently migrate the STATE
      // data and then clear all legacy keys — that would delete the corrupt
      // projects store along with the rest, losing data a future parser fix
      // could have recovered. Surface as unreadable so the runner records
      // the failure and leaves every legacy key in place.
      localStorage.setItem("mcp-inspector-projects", "{not valid json");
      localStorage.setItem(
        "mcp-inspector-state",
        JSON.stringify({
          servers: {
            legacy_stdio: {
              name: "legacy_stdio",
              enabled: true,
              useOAuth: false,
              config: { command: "python", args: ["-m", "server"] },
              connectionStatus: "disconnected",
              retryCount: 0,
              lastConnectionTime: 1700000000000,
            },
          },
        })
      );

      // The convenience wrapper coerces unreadable to null.
      expect(readLegacyMigrationPayload()).toBeNull();

      const createProject = vi.fn().mockResolvedValue("convex-id");
      const result = await runLocalStateMigration({
        createProject: createProject as any,
      });
      expect(result.ok).toBe(false);
      expect(createProject).not.toHaveBeenCalled();
      // All legacy keys preserved for a future retry / parser fix.
      expect(localStorage.getItem("mcp-inspector-projects")).toBe(
        "{not valid json"
      );
      expect(localStorage.getItem("mcp-inspector-state")).not.toBeNull();
      expect(hasMigrationCompleted()).toBe(false);
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

  describe("OAuth token import during migration", () => {
    function seedOAuthLegacy() {
      seedLegacyProjects();
      // http_one has full legacy OAuth state — should be imported.
      localStorage.setItem(
        "mcp-tokens-http_one",
        JSON.stringify({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          token_type: "bearer",
        }),
      );
      localStorage.setItem(
        "mcp-client-http_one",
        JSON.stringify({
          client_id: "legacy_client_id",
          client_secret: "legacy_client_secret",
        }),
      );
      localStorage.setItem(
        "mcp-oauth-config-http_one",
        JSON.stringify({
          resourceUrl: "https://api.example.com",
        }),
      );
    }

    it("imports legacy OAuth tokens with renamed fields and clears legacy keys on success", async () => {
      seedOAuthLegacy();
      const createProject = vi.fn().mockResolvedValue("convex-proj-id");
      const listProjectServers = vi.fn().mockResolvedValue([
        { _id: "convex-server-http_one", name: "http_one" },
        { _id: "convex-server-stdio_one", name: "stdio_one" },
      ]);
      const importTokens = vi.fn().mockResolvedValue(undefined);

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        listProjectServers,
        importTokens,
      });

      expect(result.ok).toBe(true);
      expect(importTokens).toHaveBeenCalledTimes(1);
      const importPayload = importTokens.mock.calls[0][0];
      // Field renames: legacy `client_id`/`client_secret` → `clientId`/`clientSecret`,
      // legacy `resourceUrl` → `oauthResourceUrl`.
      expect(importPayload).toMatchObject({
        projectId: "convex-proj-id",
        serverId: "convex-server-http_one",
        kind: "generic",
        oauthResourceUrl: "https://api.example.com",
        clientInformation: {
          clientId: "legacy_client_id",
          clientSecret: "legacy_client_secret",
        },
        tokens: {
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          token_type: "bearer",
        },
      });
      // Parity: the migration's `tokens` block must match the exported
      // normalizer's output for the same input. If saveTokens (live OAuth
      // completion) and the migration ever drift, this fails.
      expect(importPayload.tokens).toEqual(
        normalizeImportHostedOAuthTokens({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          token_type: "bearer",
        }),
      );
      // Legacy OAuth keys cleared on success.
      expect(localStorage.getItem("mcp-tokens-http_one")).toBeNull();
      expect(localStorage.getItem("mcp-client-http_one")).toBeNull();
      expect(localStorage.getItem("mcp-oauth-config-http_one")).toBeNull();
    });

    it("preserves legacy OAuth keys when import fails and allows retry without recreating project", async () => {
      seedOAuthLegacy();
      const createProjectFirst = vi.fn().mockResolvedValue("convex-proj-id");
      const listProjectServersFirst = vi.fn().mockResolvedValue([
        { _id: "convex-server-http_one", name: "http_one" },
      ]);
      const importTokensFail = vi
        .fn()
        .mockRejectedValueOnce(new Error("Convex unreachable"));

      const firstResult = await runLocalStateMigration({
        createProject: createProjectFirst as any,
        listProjectServers: listProjectServersFirst,
        importTokens: importTokensFail,
      });
      expect(firstResult.ok).toBe(false);
      expect(firstResult.errors[0].error).toContain(
        'OAuth import for server "http_one" failed',
      );
      // Legacy OAuth keys preserved for retry.
      expect(localStorage.getItem("mcp-tokens-http_one")).not.toBeNull();
      // Project create was successful — must not run again on retry.
      expect(createProjectFirst).toHaveBeenCalledTimes(1);

      const createProjectRetry = vi.fn();
      const listProjectServersRetry = vi.fn().mockResolvedValue([
        { _id: "convex-server-http_one", name: "http_one" },
      ]);
      const importTokensSuccess = vi.fn().mockResolvedValue(undefined);
      const retryResult = await runLocalStateMigration({
        createProject: createProjectRetry as any,
        listProjectServers: listProjectServersRetry,
        importTokens: importTokensSuccess,
      });

      expect(retryResult.ok).toBe(true);
      // createProject NOT called again — progress map remembered the
      // convexProjectId.
      expect(createProjectRetry).not.toHaveBeenCalled();
      // importTokens called this time, succeeds.
      expect(importTokensSuccess).toHaveBeenCalledTimes(1);
      // Now legacy keys are cleared.
      expect(localStorage.getItem("mcp-tokens-http_one")).toBeNull();
      expect(hasMigrationCompleted()).toBe(true);
    });

    it("skips already-imported servers on retry", async () => {
      seedOAuthLegacy();
      // Pre-populate progress map: project already created and tokens
      // imported for http_one — retry should be a no-op for both.
      localStorage.setItem(
        MIGRATION_PROGRESS_KEY,
        JSON.stringify({
          "proj-a": {
            convexProjectId: "convex-proj-id",
            tokensByServerName: { http_one: "imported" },
          },
        }),
      );

      const createProject = vi.fn();
      const listProjectServers = vi.fn().mockResolvedValue([
        { _id: "convex-server-http_one", name: "http_one" },
      ]);
      const importTokens = vi.fn();

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        listProjectServers,
        importTokens,
      });

      expect(result.ok).toBe(true);
      expect(createProject).not.toHaveBeenCalled();
      expect(importTokens).not.toHaveBeenCalled();
    });

    it("default-project (isDefault: true) routes through ensureDefaultProject + merge, NOT createProject", async () => {
      // Free-plan orgs get one auto-provisioned default project at
      // `users:ensureUser` time. The migration's `createProject` call would
      // trip `enforceOrganizationProjectLimit` (cap=1, slot already filled).
      // When deps supply ensureDefaultProject + mergeServersIntoExistingProject,
      // the migration must merge into the existing default instead.
      seedLegacyProjects();
      const createProject = vi.fn();
      const ensureDefaultProject = vi
        .fn()
        .mockResolvedValue("convex-default-id");
      const mergeServersIntoExistingProject = vi
        .fn()
        .mockResolvedValue(undefined);

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        ensureDefaultProject,
        mergeServersIntoExistingProject,
        organizationId: "org_xyz",
      });

      expect(result.ok).toBe(true);
      expect(result.projectsMigrated).toBe(1);
      expect(createProject).not.toHaveBeenCalled();
      expect(ensureDefaultProject).toHaveBeenCalledTimes(1);
      expect(ensureDefaultProject).toHaveBeenCalledWith({
        organizationId: "org_xyz",
      });
      expect(mergeServersIntoExistingProject).toHaveBeenCalledTimes(1);
      const mergeArgs = mergeServersIntoExistingProject.mock.calls[0][0];
      expect(mergeArgs.projectId).toBe("convex-default-id");
      expect(Object.keys(mergeArgs.servers)).toEqual(
        expect.arrayContaining(["stdio_one", "http_one"]),
      );
      // Legacy keys cleared on success.
      expect(localStorage.getItem("mcp-inspector-projects")).toBeNull();
      expect(hasMigrationCompleted()).toBe(true);
    });

    it("non-default project still routes through createProject even when merge deps supplied", async () => {
      // Mixed-shape protection: a user with both a default project AND a
      // user-created non-default project must take BOTH paths — merge for the
      // default, createProject for the rest. Don't blanket-route everything
      // to ensureDefaultProject.
      localStorage.setItem(
        "mcp-inspector-projects",
        JSON.stringify({
          activeProjectId: "proj-default",
          projects: {
            "proj-default": {
              id: "proj-default",
              name: "Default",
              isDefault: true,
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
              servers: {},
            },
            "proj-custom": {
              id: "proj-custom",
              name: "My Custom Project",
              isDefault: false,
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
              servers: {},
            },
          },
        }),
      );

      const createProject = vi.fn().mockResolvedValue("convex-custom-id");
      const ensureDefaultProject = vi
        .fn()
        .mockResolvedValue("convex-default-id");
      const mergeServersIntoExistingProject = vi
        .fn()
        .mockResolvedValue(undefined);

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        ensureDefaultProject,
        mergeServersIntoExistingProject,
      });

      expect(result.ok).toBe(true);
      expect(ensureDefaultProject).toHaveBeenCalledTimes(1);
      expect(mergeServersIntoExistingProject).toHaveBeenCalledTimes(1);
      expect(createProject).toHaveBeenCalledTimes(1);
      expect(createProject.mock.calls[0][0].name).toBe("My Custom Project");
    });

    it("does not retry merge after success on subsequent boot (idempotency via progress map)", async () => {
      // First boot: merge succeeds. Second boot: progress map records the
      // convex projectId, so the merge call is NOT repeated. Backend write
      // is idempotent but the round-trip is wasteful; the progress map
      // already gates re-creation, and the merge path must respect it the
      // same way createProject does.
      seedLegacyProjects();
      const ensureDefaultProject = vi
        .fn()
        .mockResolvedValue("convex-default-id");
      const mergeServersIntoExistingProject = vi
        .fn()
        .mockResolvedValue(undefined);

      const firstResult = await runLocalStateMigration({
        createProject: vi.fn() as any,
        ensureDefaultProject,
        mergeServersIntoExistingProject,
      });
      expect(firstResult.ok).toBe(true);
      expect(mergeServersIntoExistingProject).toHaveBeenCalledTimes(1);
      // Successful migration clears legacy keys → second run is a no-op.
      // Re-seed legacy state to simulate a partial-state scenario where
      // legacy keys somehow persisted (e.g. OAuth import added them back).
      seedLegacyProjects();
      // But progress map remembers proj-a was created.
      localStorage.setItem(
        MIGRATION_PROGRESS_KEY,
        JSON.stringify({
          "proj-a": {
            convexProjectId: "convex-default-id",
            tokensByServerName: {},
          },
        }),
      );

      const ensureSecond = vi.fn();
      const mergeSecond = vi.fn();
      const secondResult = await runLocalStateMigration({
        createProject: vi.fn() as any,
        ensureDefaultProject: ensureSecond,
        mergeServersIntoExistingProject: mergeSecond,
      });
      expect(secondResult.ok).toBe(true);
      expect(ensureSecond).not.toHaveBeenCalled();
      expect(mergeSecond).not.toHaveBeenCalled();
    });

    it("preserves legacy keys when merge fails and allows retry", async () => {
      seedLegacyProjects();
      const ensureDefaultProject = vi
        .fn()
        .mockResolvedValue("convex-default-id");
      const mergeServersFail = vi
        .fn()
        .mockRejectedValue(new Error("Convex unreachable"));

      const firstResult = await runLocalStateMigration({
        createProject: vi.fn() as any,
        ensureDefaultProject,
        mergeServersIntoExistingProject: mergeServersFail,
      });
      expect(firstResult.ok).toBe(false);
      expect(firstResult.errors[0].projectName).toBe("Default");
      // Legacy keys preserved for retry.
      expect(localStorage.getItem("mcp-inspector-projects")).not.toBeNull();
      expect(hasMigrationCompleted()).toBe(false);

      // Retry — merge succeeds this time.
      const mergeServersSuccess = vi.fn().mockResolvedValue(undefined);
      const retryResult = await runLocalStateMigration({
        createProject: vi.fn() as any,
        ensureDefaultProject,
        mergeServersIntoExistingProject: mergeServersSuccess,
      });
      expect(retryResult.ok).toBe(true);
      expect(mergeServersSuccess).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("mcp-inspector-projects")).toBeNull();
      expect(hasMigrationCompleted()).toBe(true);
    });

    it("falls back to createProject when only one of the merge deps is supplied", async () => {
      // Both ensureDefaultProject AND mergeServersIntoExistingProject must
      // be present to take the merge path. If a future caller supplies only
      // one, fall back to the legacy createProject path rather than
      // half-executing.
      seedLegacyProjects();
      const createProject = vi.fn().mockResolvedValue("convex-id");
      const ensureDefaultProject = vi.fn();

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        ensureDefaultProject,
        // mergeServersIntoExistingProject intentionally omitted.
      });

      expect(result.ok).toBe(true);
      expect(createProject).toHaveBeenCalledTimes(1);
      expect(ensureDefaultProject).not.toHaveBeenCalled();
    });

    it("skips servers whose legacy state lacks clientId", async () => {
      seedLegacyProjects();
      // Tokens present but no `mcp-client-${name}` entry.
      localStorage.setItem(
        "mcp-tokens-http_one",
        JSON.stringify({
          access_token: "x",
          token_type: "bearer",
        }),
      );

      const createProject = vi.fn().mockResolvedValue("convex-id");
      const listProjectServers = vi.fn().mockResolvedValue([
        { _id: "id1", name: "http_one" },
      ]);
      const importTokens = vi.fn();

      const result = await runLocalStateMigration({
        createProject: createProject as any,
        listProjectServers,
        importTokens,
      });
      expect(result.ok).toBe(true);
      expect(importTokens).not.toHaveBeenCalled();
    });
  });
});
