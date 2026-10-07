import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolveTools: vi.fn(),
  invoke: vi.fn(),
  release: vi.fn(),
  read: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("../../../services/plugin-host/request-runtime.js", () => ({
  createPluginRequestRuntime: mocks.runtime,
}));
vi.mock("../../../services/plugin-host/request-invocation.js", () => ({
  invokePluginRequest: mocks.invoke,
}));
vi.mock("../../../utils/widget-resource-content.js", () => ({
  widgetResourceContent: () => ({ html: "<p>app</p>", mimeTypeValid: true }),
}));
vi.mock("../../../utils/ui-resource-meta.js", () => ({
  canSkipListingLookup: () => true,
  findListingMetaForUri: vi.fn(),
}));
vi.mock("../../../utils/view-origin-label.js", () => ({
  viewOriginLabelForConfig: () => undefined,
}));
import { pluginModelAppRoutes } from "../plugin-model-apps.js";
import { modelApps } from "../../../services/plugin-host/model-apps.js";
import { PLUGIN_MODEL_APP_META } from "../../../../shared/plugin-model-app.js";
const actor = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "subject",
};
const source = {
  owner: {
    ...actor,
    instanceId: "model-call",
    generation: 1 as const,
    serverId: "saved-id",
    bindingId: "binding",
    placement: "interactive" as const,
  },
  subject: "subject",
  hostId: "host",
  hostRevision: "host-revision",
  serverIdentity: { kind: "standalone" as const, serverId: "saved-id" },
};
const meta = { ui: { resourceUri: "ui://app" } };
function fixture() {
  const result = modelApps.publish(
    { content: [] },
    { ...source, owner: { ...source.owner, instanceId: crypto.randomUUID() } } as never,
    "pickFile",
    "source-revision",
    meta,
  ) as any;
  const token = result._meta[PLUGIN_MODEL_APP_META].instanceToken;
  const admission = { revalidate: vi.fn(async () => {}) };
  const router = new Hono().route(
    "/",
    pluginModelAppRoutes({
      route: async (_c, action) => {
        try {
          return await action();
        } catch {
          return new Response("denied", { status: 403 });
        }
      },
      admitted: async () => ({
        actor,
        bearer: "private",
        admission: admission as never,
      }),
      cleanup: async () => actor,
    }),
  );
  return {
    token,
    router,
    request: () =>
      router.request("/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "project",
          pluginWorkspace: { version: 1, workspaceId: "workspace" },
          instanceToken: token,
        }),
      }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    contents: [{ uri: "ui://app", text: "<p>app</p>" }],
  });
  mocks.resolve.mockResolvedValue({
    revision: "source-revision",
    appToolsEnabled: true,
    contextEnabled: true,
    tool: { name: "pickFile", _meta: meta },
    manager: { readResource: mocks.read, getServerConfig: () => ({}) },
  });
  mocks.runtime.mockReturnValue({
    resolve: mocks.resolve,
    resolveTools: mocks.resolveTools,
    release: mocks.release,
  });
});
describe("saved-server model App resource route", () => {
  it("loads only the original saved server through admitted request runtime", async () => {
    const fixtureData = fixture();
    const response = await fixtureData.request();
    expect(response.status).toBe(200);
    expect(mocks.runtime.mock.calls[0][3]).toEqual({
      hostId: "host",
      serverId: "saved-id",
    });
    expect(mocks.read.mock.calls[0][0]).toBe("saved-id");
    expect(mocks.read.mock.calls[0][1]).toEqual({ uri: "ui://app" });
    expect(mocks.resolve.mock.calls.map((args) => args[0])).toEqual([
      "pickFile",
      "pickFile",
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("refuses a changed source revision before reading any App bytes", async () => {
    const fixtureData = fixture();
    mocks.resolve.mockResolvedValueOnce({
      revision: "changed",
      tool: { _meta: meta },
    });
    expect((await fixtureData.request()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("refuses source changes after reading without returning the App", async () => {
    const fixtureData = fixture();
    mocks.resolve
      .mockResolvedValueOnce({
        revision: "source-revision",
        tool: { _meta: meta },
        manager: { readResource: mocks.read },
      })
      .mockResolvedValueOnce({ revision: "changed" });
    expect((await fixtureData.request()).status).toBe(403);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe("model App call catalog admission", () => {
  it.each(["valid", "changed revision", "changed resource"])(
    "uses one current catalog and forwards the durable read fence: %s",
    async (change) => {
      const { token, router } = fixture();
      const signal = new AbortController().signal;
      const read = vi.fn(async (action: () => Promise<unknown>) => action());
      const requested = { tool: { name: "inspect" }, revision: "requested" };
      mocks.resolveTools.mockResolvedValue(
        new Map<string, unknown>([
          [
            "pickFile",
            {
              revision:
                change === "changed revision" ? "replaced" : "source-revision",
              tool: {
                name: "pickFile",
                _meta:
                  change === "changed resource"
                    ? { ui: { resourceUri: "ui://replaced" } }
                    : meta,
              },
            },
          ],
          ["inspect", requested],
        ]),
      );
      mocks.invoke.mockImplementation(async (c, options) => {
        const resolved = await options.resolve("inspect", signal, read);
        expect(resolved).toBe(requested);
        return c.json({ ok: true });
      });
      const response = await router.request("/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "project",
          pluginWorkspace: { version: 1, workspaceId: "workspace" },
          instanceToken: token,
          invocationId: "d14497c7-e074-4ffc-a3f5-d8d2dc45469c",
          params: { name: "inspect", arguments: {} },
        }),
      });
      expect(response.status).toBe(change === "valid" ? 200 : 403);
      expect(mocks.resolveTools).toHaveBeenCalledExactlyOnceWith(
        ["pickFile", "inspect"],
        signal,
        read,
      );
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );
});

describe("original model App context", () => {
  it("returns a real bounded update receipt and current state, then refuses a changed source", async () => {
    const f = fixture();
    const body = {
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
      instanceToken: f.token,
      operationId: crypto.randomUUID(),
      sequence: 1,
      params: { content: [{ type: "text", text: "Selected part" }] },
    };
    const request = () =>
      f.router.request("/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await request();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result._meta["openai/modelContext"].updateId).toBe(
      result.snapshot.state.updateId,
    );
    expect(result.snapshot.state.content[0].text).toBe("Selected part");
    expect(await (await request()).json()).toEqual(result);
    mocks.resolve.mockResolvedValue({
      revision: "other",
      contextEnabled: true,
      tool: { _meta: meta },
    });
    expect((await request()).status).toBe(403);
    modelApps.close(f.token, actor);
  });
  it("does not advertise context when fresh host policy withholds it", async () => {
    mocks.resolve.mockResolvedValue({
      revision: "source-revision",
      contextEnabled: false,
      tool: { _meta: meta },
      manager: { readResource: mocks.read, getServerConfig: () => ({}) },
    });
    const f = fixture();
    const response = await f.request();
    expect((await response.json()).contextEnabled).toBe(false);
    modelApps.close(f.token, actor);
  });
});
