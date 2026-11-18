import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const f = vi.hoisted(() => ({
  persistent: vi.fn(),
  get: vi.fn(),
  change: vi.fn(),
  resolve: vi.fn(),
  catalog: vi.fn(),
  release: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: {
    getPersistent: f.persistent,
    get: f.get,
    changeContextPersistent: f.change,
  },
}));
vi.mock(
  "../../../services/plugin-host/request-runtime.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../services/plugin-host/request-runtime.js")
    >()),
    createPluginRequestRuntime: () => ({
      resolve: f.resolve,
      catalog: f.catalog,
      release: f.release,
    }),
  }),
);
import { pluginContextRoutes } from "../plugin-context.js";
import { pluginActivationFromCatalog } from "../../../services/plugin-host/activation.js";

const library = {
  name: "library",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    ui: { resourceUri: "ui://library" },
    "openai/ui": {
      entrypoints: [
        {
          type: "global",
          quickAction: {
            title: "Part reference",
            icons: [{ src: "data:image/png;base64,aA==" }],
            target: { type: "tool", name: "reference", arguments: {} },
          },
        },
      ],
    },
  },
};
const reference = {
  name: "reference",
  inputSchema: { type: "object", properties: {} },
  _meta: { ui: { visibility: ["app"] } },
};
const catalog = {
  tools: [library, reference],
  hostRevision: "host",
  bindingId: "binding",
  serverIdentity: { kind: "standalone", serverId: "server" },
  contextEnabled: true,
  extensions: { capabilities: { modelContext: true } },
};
const selector = {
  kind: "quick-action" as const,
  requestId: "5fb21e6c-efc8-43bf-9fa5-264c70e31b58",
};
const token = "t".repeat(43);
const routes = () =>
  pluginContextRoutes({
    route: async (_c: Context, action: () => Promise<Response>) => {
      try {
        return await action();
      } catch (error) {
        return Response.json(
          { code: (error as { code?: string }).code ?? "ERROR" },
          { status: 400 },
        );
      }
    },
    admitted: async () => ({
      actor: { actorId: "a", projectId: "p", workspaceId: "w", subject: "s" },
      bearer: "credential",
      admission: { revalidate: f.revalidate } as never,
    }),
  });
const removeAll = (path = "/remove-all") =>
  routes().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "p",
      pluginWorkspace: { version: 1, workspaceId: "w" },
      instanceToken: token,
      operationId: "8a0f0c1e-0b7e-4bfa-9f5e-0f0f0f0f0f0f",
      basis: 3,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  f.catalog.mockResolvedValue(catalog);
  f.change.mockImplementation(
    async (
      _token: string,
      _actor: unknown,
      _command: unknown,
      _signal: AbortSignal,
      authorize: () => Promise<void>,
    ) => {
      await authorize();
      return {
        result: { outcome: "applied" },
        snapshot: { revision: 2, sequence: 1, state: null, held: true },
      };
    },
  );
});

describe("App context update admission", () => {
  it("leaves the block budget to admission, so its refusal stays typed", async () => {
    const opened = pluginActivationFromCatalog(
      catalog as never,
      "library",
      selector,
    );
    f.persistent.mockResolvedValue({
      contextEnabled: true,
      hostId: "host",
      owner: { serverId: "server" },
      activation: {
        selector,
        toolName: "reference",
        sourceToolName: "library",
        revision: opened.revision,
      },
    });
    f.change.mockResolvedValue({
      result: { _meta: { "openai/modelContext": { updateId: "u" } } },
      snapshot: { revision: 1, sequence: 1, state: null },
    });
    const response = await routes().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "p",
        pluginWorkspace: { version: 1, workspaceId: "w" },
        instanceToken: token,
        operationId: "8a0f0c1e-0b7e-4bfa-9f5e-0f0f0f0f0f0f",
        sequence: 1,
        params: {
          content: Array.from({ length: 65 }, () => ({
            type: "text",
            text: "part",
          })),
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(f.change.mock.calls[0][2]).toMatchObject({ kind: "update" });
  });
});

describe("App context admission under the client's policy", () => {
  const policy = {
    updateMaxBytes: 2_548_000,
    maxBlocks: 256,
    turnMaxBytes: 8 * 1024 * 1024,
  };
  const update = (sequence: number) =>
    routes().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "p",
        pluginWorkspace: { version: 1, workspaceId: "w" },
        instanceToken: token,
        operationId: crypto.randomUUID(),
        sequence,
        params: { content: [{ type: "text", text: "part" }] },
      }),
    });

  it("admits each update against the policy its request first resolved, and the App stays open when it changes", async () => {
    const opened = pluginActivationFromCatalog(
      catalog as never,
      "library",
      selector,
    );
    f.persistent.mockResolvedValue({
      contextEnabled: true,
      hostId: "host",
      owner: { serverId: "server" },
      activation: {
        selector,
        toolName: "reference",
        sourceToolName: "library",
        revision: opened.revision,
      },
    });
    // Only the request's first resolution carries the policy.
    f.catalog.mockResolvedValueOnce({ ...catalog, modelContextPolicy: policy });
    expect((await update(1)).status).toBe(200);
    expect(f.change.mock.calls[0][2]).toMatchObject({
      kind: "update",
      limits: policy,
    });
    // The client was saved without one: the next update uses the defaults.
    expect((await update(2)).status).toBe(200);
    expect(f.change.mock.calls[1][2].limits).toBeUndefined();
  });
});

describe("App context routes for an open quick-action App", () => {
  it("removes all of its context, authorized against the revision it opened with", async () => {
    const opened = pluginActivationFromCatalog(
      catalog as never,
      "library",
      selector,
    );
    f.persistent.mockResolvedValue({
      contextEnabled: true,
      hostId: "host",
      owner: { serverId: "server" },
      activation: {
        selector,
        toolName: "reference",
        sourceToolName: "library",
        revision: opened.revision,
      },
    });
    const response = await removeAll();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "applied",
      snapshot: { revision: 2, sequence: 1, state: null, held: true },
    });
    expect(f.change.mock.calls[0][2]).toEqual({
      kind: "remove-all",
      request: expect.objectContaining({
        operationId: "8a0f0c1e-0b7e-4bfa-9f5e-0f0f0f0f0f0f",
        basis: 3,
      }),
    });
    // The single-block route is gone: an App's context is removed as a group.
    expect((await removeAll("/remove")).status).toBe(404);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("still refuses an App whose tool changed since it opened", async () => {
    f.persistent.mockResolvedValue({
      contextEnabled: true,
      hostId: "host",
      owner: { serverId: "server" },
      activation: {
        selector,
        toolName: "reference",
        sourceToolName: "library",
        revision: "an earlier revision",
      },
    });
    const response = await removeAll();
    expect(await response.json()).toEqual({
      code: "INSTANCE_CONTEXT_UNAVAILABLE",
    });
    expect(f.change).not.toHaveBeenCalled();
  });
});
