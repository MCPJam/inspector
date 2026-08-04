import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers the browser-facing environment TOOLS route
// (server/routes/web/environments.ts, GET /:environmentId/tools) — the Tools
// rail's data source in environment mode. Convex is mocked at the
// `convex/browser` boundary; the manager builder and the per-server list call
// are mocked at their module boundaries, so the tests prove what the route
// RESOLVES, which servers it lists, and how a per-server failure degrades.

const { convexQueryMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
  })),
}));

const { createAuthorizedManagerMock, disconnectAllServersMock, listToolsMock } =
  vi.hoisted(() => ({
    createAuthorizedManagerMock: vi.fn(),
    disconnectAllServersMock: vi.fn(),
    listToolsMock: vi.fn(),
  }));

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("../../../utils/route-handlers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/route-handlers.js")>();
  return { ...actual, listTools: listToolsMock };
});

import { createWebTestApp } from "./helpers/test-app.js";

const SPEC = {
  specVersion: 1,
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  host: {
    hostId: "host_1",
    hostName: "Alpha",
    hostConfigId: "hc_1",
    runtimeConfig: { modelId: "openai/gpt-5-mini", hostStyle: "claude" },
  },
  servers: {
    selectedServerIds: ["ps_1"],
    pluginServerIds: ["ps_2"],
    baseEffectiveServerIds: ["ps_1", "ps_2"],
    effectiveServerIds: ["ps_1", "ps_2"],
    connectable: [
      { serverId: "ps_1", name: "linear", source: "host_or_group" },
      { serverId: "ps_2", name: "asana", source: "plugin" },
    ],
  },
  skills: [],
  pluginVersions: [],
};

function get(path: string, token: string | null = "test-token-123") {
  const { app } = createWebTestApp();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: "GET", headers });
}

describe("GET /api/web/environments/:id/tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://example.convex.cloud";
    convexQueryMock.mockResolvedValue(SPEC);
    // `clearAllMocks` keeps implementations, so reset this one explicitly —
    // the teardown-rejection test below would otherwise leak into its
    // successors.
    disconnectAllServersMock.mockResolvedValue(undefined);
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: disconnectAllServersMock },
      oauthServerUrls: {},
      authenticatedUserId: "user_1",
    });
    listToolsMock.mockResolvedValue({ tools: [] });
  });

  it("requires a projectId", async () => {
    const response = await get("/api/web/environments/env_1/tools");
    expect(response.status).toBe(400);
  });

  it("requires a bearer token (never anonymous)", async () => {
    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1",
      null
    );
    expect(response.status).toBe(401);
  });

  it("resolves the environment and lists every resolved server by id", async () => {
    listToolsMock.mockImplementation(
      async (_manager: unknown, params: { serverId: string }) => ({
        tools: [{ name: `tool-of-${params.serverId}` }],
      })
    );
    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(200);
    expect(convexQueryMock).toHaveBeenCalledWith(
      "projectEnvironments:resolveEnvironmentForRuntime",
      { projectId: "p_1", environmentId: "env_1" }
    );
    // ONE manager per resolved server id — the only path that reaches
    // plugin-contributed servers, isolated so one server's authorization
    // failure can't blank its siblings.
    expect(createAuthorizedManagerMock).toHaveBeenCalledTimes(2);
    expect(createAuthorizedManagerMock.mock.calls[0][3]).toEqual(["ps_1"]);
    expect(createAuthorizedManagerMock.mock.calls[1][3]).toEqual(["ps_2"]);
    expect(createAuthorizedManagerMock.mock.calls[0][7]).toMatchObject({
      serverNames: ["linear"],
      xaaIssuer: expect.any(String),
    });
    expect(createAuthorizedManagerMock.mock.calls[1][7]).toMatchObject({
      serverNames: ["asana"],
    });
    // The headline "fresh read" guarantee: never a cached tools body.
    expect(listToolsMock).toHaveBeenCalledWith(expect.anything(), {
      serverId: "ps_1",
      cacheMode: "bypass",
    });
    const body = await response.json();
    expect(body.servers).toEqual([
      {
        serverId: "ps_1",
        name: "linear",
        source: "host_or_group",
        tools: [{ name: "tool-of-ps_1" }],
      },
      {
        serverId: "ps_2",
        name: "asana",
        source: "plugin",
        tools: [{ name: "tool-of-ps_2" }],
      },
    ]);
    // One teardown per per-server manager.
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(2);
  });

  it("degrades a per-server failure to that server's row, not the route", async () => {
    listToolsMock.mockImplementation(
      async (_manager: unknown, params: { serverId: string }) => {
        if (params.serverId === "ps_2") {
          throw new Error("connect ECONNREFUSED");
        }
        return { tools: [{ name: "list_issues" }] };
      }
    );
    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers[0]).toMatchObject({
      serverId: "ps_1",
      tools: [{ name: "list_issues" }],
    });
    expect(body.servers[0].error).toBeUndefined();
    expect(body.servers[1]).toMatchObject({
      serverId: "ps_2",
      tools: [],
      error: "connect ECONNREFUSED",
    });
    // Every per-server manager tears down, including the failing one's.
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(2);
  });

  it("degrades an AUTHORIZATION failure to that server's row too", async () => {
    // The batch-manager path validates all-or-nothing (right for a turn),
    // which is exactly why this route builds one manager per server: an
    // unauthorized/misconfigured server must not blank its healthy siblings.
    createAuthorizedManagerMock.mockImplementation(
      async (
        _caller: unknown,
        _bearer: unknown,
        _projectId: unknown,
        serverIds: string[]
      ) => {
        if (serverIds[0] === "ps_2") {
          throw new Error("XAA connection is not configured for this server");
        }
        return {
          manager: { disconnectAllServers: disconnectAllServersMock },
          oauthServerUrls: {},
          authenticatedUserId: "user_1",
        };
      }
    );
    listToolsMock.mockResolvedValue({ tools: [{ name: "list_issues" }] });

    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers[0]).toMatchObject({
      serverId: "ps_1",
      tools: [{ name: "list_issues" }],
    });
    expect(body.servers[1]).toMatchObject({
      serverId: "ps_2",
      tools: [],
      error: "XAA connection is not configured for this server",
    });
    // Only the successfully-built manager exists to tear down.
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful listing when teardown rejects", async () => {
    // A rejecting disconnect thrown from `finally` would replace the
    // already-collected tools with an error row — reporting a healthy server
    // as unreachable over a transient close failure.
    disconnectAllServersMock.mockRejectedValue(new Error("socket already gone"));
    listToolsMock.mockResolvedValue({ tools: [{ name: "list_issues" }] });

    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers).toHaveLength(2);
    for (const server of body.servers) {
      expect(server.tools).toEqual([{ name: "list_issues" }]);
      expect(server.error).toBeUndefined();
    }
  });

  it("short-circuits an environment with zero servers without connecting", async () => {
    convexQueryMock.mockResolvedValue({
      ...SPEC,
      servers: {
        selectedServerIds: [],
        pluginServerIds: [],
        baseEffectiveServerIds: [],
        effectiveServerIds: [],
        connectable: [],
      },
    });
    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ servers: [] });
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
  });

  it("surfaces a structured ENV_* resolve failure as a 409", async () => {
    const { ConvexError } = await import("convex/values");
    convexQueryMock.mockRejectedValue(
      new ConvexError({
        code: "ENV_PLUGIN_UNAVAILABLE",
        message: "Plugin can no longer provide its server",
      })
    );
    const response = await get(
      "/api/web/environments/env_1/tools?projectId=p_1"
    );
    expect(response.status).toBe(409);
  });
});
