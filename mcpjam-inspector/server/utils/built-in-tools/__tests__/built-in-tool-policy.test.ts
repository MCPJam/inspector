import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyBuiltInToolPolicy,
  isKnownBuiltInToolId,
  resolveTurnBuiltInToolIds,
  resolveWorkspaceToolApproval,
} from "../built-in-tool-policy";
import { MCPJAM_TOOL_IDS } from "../mcpjam";

// A workspace READ and two workspace WRITES (one catalog-gated, one the
// catalog refuses to offer an agent at all).
const READ = "list_project_servers";
const GATED_WRITE = "run_eval_suite";
const EXCLUDED_WRITE = "create_project_server";
// A workspace read that opens a connection to a saved server.
const CONNECTION_READ = "diagnose_server";

type ResolveArgs = Parameters<typeof resolveTurnBuiltInToolIds>[0];

function resolve(overrides: Partial<ResolveArgs>) {
  const loadProjectDefaultConfig = vi.fn(
    overrides.loadProjectDefaultConfig ?? (async () => null),
  );
  const loadProjectAccess = vi.fn(
    overrides.loadProjectAccess ?? (async () => ({ projectRole: "admin" })),
  );
  const result = resolveTurnBuiltInToolIds({
    requested: ["web_search"],
    targetKind: "adhoc",
    hostRuntimeConfig: null,
    isGuest: false,
    ...overrides,
    loadProjectDefaultConfig,
    loadProjectAccess,
  });
  return { result, loadProjectDefaultConfig, loadProjectAccess };
}

describe("isKnownBuiltInToolId", () => {
  it("knows the built-ins and every workspace operation, nothing else", () => {
    for (const id of ["web_search", "bash", "browser", ...MCPJAM_TOOL_IDS]) {
      expect(isKnownBuiltInToolId(id), id).toBe(true);
    }
    expect(isKnownBuiltInToolId("delete_everything")).toBe(false);
    expect(isKnownBuiltInToolId("")).toBe(false);
  });
});

describe("applyBuiltInToolPolicy", () => {
  it("drops unknown ids and duplicates", () => {
    expect(
      applyBuiltInToolPolicy({
        requested: ["web_search", "not_a_tool", "web_search"],
        workspaceToolsBarred: false,
      }),
    ).toEqual({
      ids: ["web_search"],
      dropped: [{ id: "not_a_tool", reason: "unknown" }],
    });
  });

  it("bounds the body by the configuration, except the browser override", () => {
    const decision = applyBuiltInToolPolicy({
      requested: ["web_search", "bash", "browser"],
      configured: ["web_search"],
      workspaceToolsBarred: false,
    });
    expect(decision.ids).toEqual(["web_search", "browser"]);
    expect(decision.dropped).toEqual([
      { id: "bash", reason: "not_configured" },
    ]);
  });

  it("keeps undefined as undefined (nothing requested, nothing decided)", () => {
    expect(
      applyBuiltInToolPolicy({
        requested: undefined,
        workspaceToolsBarred: false,
      }),
    ).toEqual({ ids: undefined, dropped: [] });
  });

  it("never gives workspace tools to a barred surface", () => {
    const decision = applyBuiltInToolPolicy({
      requested: [READ, "web_search"],
      workspaceToolsBarred: true,
      access: { projectRole: "admin" },
    });
    expect(decision.ids).toEqual(["web_search"]);
    expect(decision.dropped).toEqual([
      { id: READ, reason: "not_a_project_member_surface" },
    ]);
  });

  it.each([
    [undefined, "access_unverified"],
    ["unavailable" as const, "access_unverified"],
    [null, "no_project_access"],
  ])("drops workspace tools when access is %s", (access, reason) => {
    const decision = applyBuiltInToolPolicy({
      requested: [READ, "web_search"],
      workspaceToolsBarred: false,
      ...(access !== undefined ? { access } : {}),
    });
    expect(decision.ids).toEqual(["web_search"]);
    expect(decision.dropped).toEqual([{ id: READ, reason }]);
  });

  it("gives a role that cannot edit the workspace reads only", () => {
    const decision = applyBuiltInToolPolicy({
      requested: [READ, GATED_WRITE, EXCLUDED_WRITE],
      workspaceToolsBarred: false,
      access: { projectRole: null },
    });
    expect(decision.ids).toEqual([READ]);
    expect(decision.dropped).toEqual([
      { id: GATED_WRITE, reason: "read_only_role" },
      { id: EXCLUDED_WRITE, reason: "read_only_role" },
    ]);
  });

  it.each(["admin", "editor"])(
    "gives a project %s the writes",
    (projectRole) => {
      const decision = applyBuiltInToolPolicy({
        requested: [READ, GATED_WRITE],
        workspaceToolsBarred: false,
        access: { projectRole },
      });
      expect(decision.ids).toEqual([READ, GATED_WRITE]);
    },
  );
});

describe("resolveTurnBuiltInToolIds", () => {
  it("bounds a host-bound turn by the saved host's list", async () => {
    const { result, loadProjectDefaultConfig } = resolve({
      targetKind: "host",
      hostRuntimeConfig: { builtInToolIds: ["web_search"] },
      requested: ["web_search", "bash", "browser"],
    });
    const decision = await result;
    expect(decision.ids).toEqual(["web_search", "browser"]);
    expect(decision.dropped).toEqual([
      { id: "bash", reason: "not_configured" },
    ]);
    expect(loadProjectDefaultConfig).not.toHaveBeenCalled();
  });

  it("treats a host with no list as configuring none", async () => {
    const { result } = resolve({
      targetKind: "host",
      hostRuntimeConfig: {},
      requested: ["web_search", READ],
    });
    expect((await result).ids).toEqual([]);
  });

  it("bounds an ad-hoc turn by the project's default host config", async () => {
    const { result, loadProjectAccess } = resolve({
      requested: ["web_search", GATED_WRITE, READ],
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: ["web_search", READ],
      }),
    });
    const decision = await result;
    expect(decision.ids).toEqual(["web_search", READ]);
    expect(decision.dropped).toEqual([
      { id: GATED_WRITE, reason: "not_configured" },
    ]);
    expect(loadProjectAccess).toHaveBeenCalledTimes(1);
  });

  it("leaves an ad-hoc turn unbounded when the project has no default config", async () => {
    const { result } = resolve({
      requested: ["web_search", "bash", GATED_WRITE],
      loadProjectDefaultConfig: async () => null,
    });
    expect((await result).ids).toEqual(["web_search", "bash", GATED_WRITE]);
  });

  it("drops workspace tools, and only those, when the configuration cannot be read", async () => {
    const { result, loadProjectAccess } = resolve({
      requested: ["web_search", READ],
      loadProjectDefaultConfig: async () => {
        throw new Error("convex unavailable");
      },
    });
    const decision = await result;
    expect(decision.ids).toEqual(["web_search"]);
    expect(decision.dropped).toEqual([
      { id: READ, reason: "access_unverified" },
    ]);
    expect(loadProjectAccess).not.toHaveBeenCalled();
  });

  it("drops workspace tools when the caller's access cannot be read", async () => {
    const { result } = resolve({
      requested: [READ],
      loadProjectAccess: async () => {
        throw new Error("convex unavailable");
      },
    });
    expect(await result).toEqual({
      ids: [],
      dropped: [{ id: READ, reason: "access_unverified" }],
      workspaceToolApproval: true,
    });
  });

  it("withholds writes from a caller whose project role cannot edit", async () => {
    const { result } = resolve({
      requested: [READ, GATED_WRITE],
      loadProjectAccess: async () => ({ projectRole: null }),
    });
    expect((await result).ids).toEqual([READ]);
  });

  it("withholds every workspace tool from a caller with no project access", async () => {
    const { result } = resolve({
      requested: [READ, "web_search"],
      loadProjectAccess: async () => null,
    });
    expect((await result).ids).toEqual(["web_search"]);
  });

  it("looks nothing up for a guest or a shared scenario", async () => {
    for (const overrides of [
      { isGuest: true },
      { targetKind: "scenario" as const },
    ]) {
      const { result, loadProjectAccess, loadProjectDefaultConfig } = resolve({
        requested: [READ, "web_search"],
        ...overrides,
      });
      expect((await result).ids).toEqual(["web_search"]);
      expect(loadProjectAccess).not.toHaveBeenCalled();
      expect(loadProjectDefaultConfig).not.toHaveBeenCalled();
    }
  });

  it("makes no lookup a turn's request cannot need", async () => {
    const browserOnly = resolve({ requested: ["browser"] });
    expect((await browserOnly.result).ids).toEqual(["browser"]);
    expect(browserOnly.loadProjectDefaultConfig).not.toHaveBeenCalled();
    expect(browserOnly.loadProjectAccess).not.toHaveBeenCalled();

    const noWorkspace = resolve({
      requested: ["web_search"],
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: ["web_search"],
      }),
    });
    expect((await noWorkspace.result).ids).toEqual(["web_search"]);
    expect(noWorkspace.loadProjectAccess).not.toHaveBeenCalled();

    const empty = resolve({ requested: [] });
    expect(await empty.result).toEqual({
      ids: [],
      dropped: [],
      workspaceToolApproval: true,
    });
    expect(empty.loadProjectDefaultConfig).not.toHaveBeenCalled();
  });

  it("still role-gates an environment turn's own list", async () => {
    const { result, loadProjectDefaultConfig } = resolve({
      targetKind: "environment",
      requested: [READ, GATED_WRITE],
      loadProjectAccess: async () => ({ projectRole: null }),
    });
    expect((await result).ids).toEqual([READ]);
    expect(loadProjectDefaultConfig).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspaceToolApproval (MJ-008)", () => {
  it.each([
    [undefined, undefined, true],
    [undefined, false, true],
    [true, false, true],
    [true, undefined, true],
    [false, false, false],
    [false, undefined, false],
    [false, true, true],
    ["off", false, true],
  ])("saved %s, turn %s: %s", (saved, requested, expected) => {
    expect(resolveWorkspaceToolApproval({ saved, requested })).toBe(expected);
  });
});

describe("resolveTurnBuiltInToolIds — workspace approval setting (MJ-008)", () => {
  it("is on for an ad-hoc turn in a project with no saved default config", async () => {
    const { result } = resolve({
      requested: ["list_projects", READ, EXCLUDED_WRITE],
      requestedToolApproval: false,
      loadProjectDefaultConfig: async () => null,
    });
    const decision = await result;
    expect(decision.ids).toEqual(["list_projects", READ, EXCLUDED_WRITE]);
    expect(decision.workspaceToolApproval).toBe(true);
  });

  it.each([true, false])(
    "follows the project default's saved setting (%s) on an ad-hoc turn, from the one read",
    async (saved) => {
      const { result, loadProjectDefaultConfig } = resolve({
        requested: [READ, CONNECTION_READ],
        requestedToolApproval: false,
        loadProjectDefaultConfig: async () => ({
          builtInToolIds: [READ, CONNECTION_READ],
          requireToolApproval: saved,
        }),
      });
      const decision = await result;
      expect(decision.ids).toEqual([READ, CONNECTION_READ]);
      expect(decision.workspaceToolApproval).toBe(saved);
      expect(loadProjectDefaultConfig).toHaveBeenCalledTimes(1);
    },
  );

  it("is on when the saved default config carries no setting", async () => {
    const { result } = resolve({
      requested: [CONNECTION_READ],
      requestedToolApproval: false,
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: [CONNECTION_READ],
      }),
    });
    expect((await result).workspaceToolApproval).toBe(true);
  });

  it("is raised by the turn's own setting and never lowered by it", async () => {
    const raised = resolve({
      requested: [CONNECTION_READ],
      requestedToolApproval: true,
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: [CONNECTION_READ],
        requireToolApproval: false,
      }),
    });
    expect((await raised.result).workspaceToolApproval).toBe(true);

    const kept = resolve({
      requested: [CONNECTION_READ],
      requestedToolApproval: false,
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: [CONNECTION_READ],
        requireToolApproval: true,
      }),
    });
    expect((await kept.result).workspaceToolApproval).toBe(true);
  });

  it.each(["host" as const, "environment" as const])(
    "follows the saved host on a %s turn",
    async (targetKind) => {
      const off = resolve({
        targetKind,
        requested: [CONNECTION_READ],
        requestedToolApproval: false,
        hostRuntimeConfig: {
          builtInToolIds: [CONNECTION_READ],
          requireToolApproval: false,
        },
      });
      expect((await off.result).workspaceToolApproval).toBe(false);
      expect(off.loadProjectDefaultConfig).not.toHaveBeenCalled();

      const unsaved = resolve({
        targetKind,
        requested: [CONNECTION_READ],
        requestedToolApproval: false,
        hostRuntimeConfig: { builtInToolIds: [CONNECTION_READ] },
      });
      expect((await unsaved.result).workspaceToolApproval).toBe(true);
    },
  );
});

describe("workspace tools where approvals cannot be verified (MJ-008)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function withoutSigningKey() {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
  }

  it("drops every workspace tool that would pause and keeps the pure reads", async () => {
    withoutSigningKey();
    const { result } = resolve({
      requested: [
        "list_projects",
        READ,
        EXCLUDED_WRITE,
        CONNECTION_READ,
        "web_search",
      ],
      requestedToolApproval: false,
    });
    const decision = await result;
    expect(decision.ids).toEqual(["list_projects", READ, "web_search"]);
    expect(decision.dropped).toEqual([
      { id: EXCLUDED_WRITE, reason: "approval_unverifiable" },
      { id: CONNECTION_READ, reason: "approval_unverifiable" },
    ]);
  });

  it("keeps a connection-opening read whose saved setting is off", async () => {
    withoutSigningKey();
    const { result } = resolve({
      requested: [READ, CONNECTION_READ, EXCLUDED_WRITE],
      requestedToolApproval: false,
      loadProjectDefaultConfig: async () => ({
        builtInToolIds: [READ, CONNECTION_READ, EXCLUDED_WRITE],
        requireToolApproval: false,
      }),
    });
    const decision = await result;
    expect(decision.ids).toEqual([READ, CONNECTION_READ]);
    expect(decision.dropped).toEqual([
      { id: EXCLUDED_WRITE, reason: "approval_unverifiable" },
    ]);
  });

  it("drops nothing for this reason where approvals can be verified", async () => {
    const { result } = resolve({
      requested: [READ, CONNECTION_READ, EXCLUDED_WRITE],
      requestedToolApproval: false,
    });
    const decision = await result;
    expect(decision.ids).toEqual([READ, CONNECTION_READ, EXCLUDED_WRITE]);
    expect(decision.dropped).toEqual([]);
  });
});
