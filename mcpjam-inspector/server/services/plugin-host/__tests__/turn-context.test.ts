import { describe, it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  modelGet: vi.fn(),
  modelHas: vi.fn(() => false),
  get: vi.fn(),
  persistent: vi.fn(),
  snapshot: vi.fn(),
  resolve: vi.fn(),
  catalog: vi.fn(),
  release: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../model-apps.js", () => ({
  modelApps: { has: mocks.modelHas, get: mocks.modelGet },
}));
vi.mock("../instances.js", () => ({
  pluginInstances: {
    get: mocks.get,
    getPersistent: mocks.persistent,
    contextSnapshot: mocks.snapshot,
  },
}));
vi.mock("../request-runtime.js", async (original) => ({
  ...(await original<typeof import("../request-runtime.js")>()),
  createPluginRequestRuntime: () => ({
    resolve: mocks.resolve,
    catalog: mocks.catalog,
    release: mocks.release,
  }),
}));
import { readOwnedTurnContext } from "../turn-context.js";
import { pluginActivationFromCatalog } from "../activation.js";
const token = "a".repeat(43);
const input = () =>
  ({
    c: { req: { raw: { signal: new AbortController().signal } } },
    references: [token, token],
    actor: { actorId: "a", projectId: "p", workspaceId: "w", subject: "s" },
    bearer: "credential",
    admission: { revalidate: mocks.revalidate },
  } as never);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.modelHas.mockReturnValue(false);
  mocks.persistent.mockResolvedValue({
    contextEnabled: true,
    hostId: "h",
    owner: { instanceId: "i", generation: 1, serverId: "s" },
    activation: { toolName: "app", revision: "r" },
  });
  mocks.resolve.mockResolvedValue({ contextEnabled: true, revision: "r" });
  mocks.snapshot.mockReturnValue({
    state: { updateId: "u", content: [{ type: "text", text: "server state" }] },
  });
});
describe("current owned turn context", () => {
  it("reads persisted state once per owned token, preserving actual user turn semantics", async () => {
    const result = await readOwnedTurnContext(input());
    expect(result?.role).toBe("user");
    expect(JSON.stringify(result)).toContain("server state");
    expect(mocks.persistent).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });
  it("refuses changed binding before taking a snapshot and releases the request", async () => {
    mocks.resolve.mockResolvedValue({
      contextEnabled: true,
      revision: "changed",
    });
    await expect(readOwnedTurnContext(input())).rejects.toThrow(
      "INSTANCE_CONTEXT_UNAVAILABLE",
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("lets a later send carry an open quick-action App's context", async () => {
    // A quick action's stored revision binds its source tool, target tool
    // and planned call. Comparing it with the target tool's own revision
    // refused every turn sent while such an App was open.
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
      serverIdentity: { kind: "standalone", serverId: "s" },
      contextEnabled: true,
    };
    const selector = {
      kind: "quick-action" as const,
      requestId: "5fb21e6c-efc8-43bf-9fa5-264c70e31b58",
    };
    const opened = pluginActivationFromCatalog(
      catalog as never,
      "library",
      selector,
    );
    mocks.persistent.mockResolvedValue({
      contextEnabled: true,
      hostId: "h",
      owner: { instanceId: "i", generation: 1, serverId: "s" },
      activation: {
        selector,
        toolName: "reference",
        sourceToolName: "library",
        revision: opened.revision,
      },
    });
    mocks.catalog.mockResolvedValue(catalog);
    const result = await readOwnedTurnContext(input());
    expect(JSON.stringify(result)).toContain("server state");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("refuses another closed source after authorization awaits", async () => {
    mocks.get
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("closed");
      });
    await expect(readOwnedTurnContext(input())).rejects.toThrow("closed");
  });
});

it("reads original model context through the same fresh source fence", async () => {
  mocks.modelHas.mockReturnValue(true);
  mocks.modelGet.mockReturnValue({
    owner: {
      hostId: "h",
      owner: { instanceId: "i", generation: 1, serverId: "s" },
    },
    toolName: "app",
    revision: "r",
    resourceUri: "ui://app",
    context: { snapshot: mocks.snapshot },
  });
  mocks.resolve.mockResolvedValue({
    contextEnabled: true,
    revision: "r",
    tool: { _meta: { ui: { resourceUri: "ui://app" } } },
  });
  const result = await readOwnedTurnContext(input());
  expect(JSON.stringify(result)).toContain("server state");
  expect(mocks.persistent).not.toHaveBeenCalled();
  expect(mocks.modelGet).toHaveBeenCalledTimes(3);
});
