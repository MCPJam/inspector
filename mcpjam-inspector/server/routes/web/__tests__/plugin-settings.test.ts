import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  admit: vi.fn(),
  catalog: vi.fn(),
  release: vi.fn(),
  open: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
  invoke: vi.fn(),
  signal: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugin-host/admission.js")
  >()),
  admitPluginWorkspace: f.admit,
  resolvePluginCleanupActor: async () => "actor",
}));
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: {
    openActivationPersistent: f.open,
    getPersistent: f.get,
    get: f.get,
    closePersistent: f.close,
    signal: f.signal,
  },
}));
vi.mock("../../../services/plugin-host/request-runtime.js", () => ({
  createPluginRequestRuntime: () => ({
    catalog: f.catalog,
    release: f.release,
  }),
  resolvePluginCatalogTool: (catalog: any, name: string) => ({
    ...catalog,
    tool: catalog.tools.find((tool: any) => tool.name === name),
    revision: name,
  }),
}));
vi.mock("../../../services/plugin-host/request-invocation.js", () => ({
  invokePluginRequest: f.invoke,
}));
vi.mock("../../../services/plugin-host/settings-state.js", async () =>
  (await import("./settings-state-memory.js")).memorySettingsState((token) =>
    f.get(token),
  ),
);
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
import routes from "../plugin-settings";
import { PluginInvocationError } from "../../../services/plugin-host/invocation";
import { PLUGIN_APP_READ_RESULT_BYTES } from "../../../services/plugin-host/tool-call-validation";
import { resolvePluginSettingsCatalog } from "../../../services/plugin-host/settings-catalog";
import { settingsFixture } from "../../../../shared/__tests__/plugin-settings-fixture";
import { webReceiptApp, withReceiptSigning, expectOwnedSourceReceipt } from "./owned-source-receipt-fixture.js";
const app = new Hono().route("/settings", routes);
const scope = {
  projectId: "project",
  pluginWorkspace: { version: 1, workspaceId: "workspace" },
};
const server = { ...scope, hostId: "host", serverId: "server" };
let token: string, abort: AbortController;
const catalog = () => ({
  runtime: "chatgpt",
  hostRevision: "host-v1",
  bindingId: "binding",
  serverIdentity: { kind: "standalone" as const, serverId: "server" },
  transport: "legacy" as const,
  protocolVersion: "2025-11-25",
  appToolsEnabled: true,
  serverCapabilities: {
    experimental: {
      "openai/settings": { readTool: "read", updateTool: "save" },
    },
  },
  manager: { readResource: f.read },
  tools: [
    {
      name: "read",
      inputSchema: { type: "object" as const },
      outputSchema: { type: "object" as const },
    },
    {
      name: "save",
      inputSchema: { type: "object" as const },
      outputSchema: { type: "object" as const },
    },
    {
      name: "reset",
      inputSchema: { type: "object" as const },
      _meta: { ui: { resourceUri: "ui://settings", visibility: ["app"] } },
    },
  ],
});
const post = (path: string, data: unknown) =>
  app.request(`/settings/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture",
    },
    body: JSON.stringify(data),
  });
const handle = () => ({ ...scope, instanceToken: token });
const op = () => ({ ...handle(), operationId: crypto.randomUUID() });
async function opened() {
  expect((await post("open", server)).status).toBe(200);
  expect((await post("read", op())).status).toBe(200);
}
beforeEach(() => {
  vi.clearAllMocks();
  token = crypto.randomUUID();
  abort = new AbortController();
  f.signal.mockReturnValue(abort.signal);
  f.admit.mockResolvedValue({ actorId: "actor", projectId: "project" });
  f.catalog.mockImplementation(async () => catalog());
  f.release.mockResolvedValue(undefined);
  f.open.mockResolvedValue({
    token,
    instance: { owner: { instanceId: "settings-instance", generation: 1 } },
  });
  f.close.mockResolvedValue(undefined);
  f.get.mockImplementation(() => ({
    hostId: "host",
    owner: { serverId: "server" },
    activation: {
      settings: {
        ...resolvePluginSettingsCatalog(catalog())!.settings,
        revision: resolvePluginSettingsCatalog(catalog())!.revision,
      },
    },
  }));
  f.invoke.mockImplementation(async (c: any, input: any) => {
    try {
      const resolved = await input.resolve(input.params.name, c.req.raw.signal);
      input.assertLive();
      input.assertOrigin(resolved);
      const result = {
        content: [],
        structuredContent:
          input.params.name === "read"
            ? settingsFixture()
            : input.params.name === "save"
            ? {
                values: {
                  ...settingsFixture().values,
                  ...input.params.arguments.set,
                },
              }
            : {},
      };
      input.validate?.(resolved)?.(result);
      return c.json({ status: "completed", result });
    } finally {
      await input.runtime.release();
    }
  });
  f.read.mockResolvedValue({
    contents: [
      {
        uri: "ui://settings",
        mimeType: "text/html;profile=mcp-app",
        text: "<p>settings</p>",
        _meta: { ui: { csp: {} } },
      },
    ],
  });
});
describe("owned structured settings", () => {
  it("uses cached JSON after hosted request budgeting has consumed the raw body", async () => {
    const budgeted = new Hono();
    budgeted.use("*", async (c, next) => {
      // Hosted mcpOperationRateLimit reads and caches JSON to choose a server bucket.
      await c.req.json();
      expect(c.req.raw.bodyUsed).toBe(true);
      await next();
    });
    budgeted.route("/settings", routes);
    const response = await budgeted.request("/settings/discover", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify(server),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).settings).not.toBeNull();
    expect(f.admit).toHaveBeenCalledOnce();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    const invalid = await budgeted.request("/settings/discover", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({ ...server, forged: true }),
    });
    expect(invalid.status).toBe(400);
    expect(f.admit).toHaveBeenCalledOnce();
  });

  it("discovers without executing or creating an instance", async () => {
    const response = await post("discover", server);
    expect(response.status).toBe(200);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    // The fixture's read tool lacks readOnlyHint: warn, never refuse.
    const value = await response.json();
    expect(value.settings).not.toBeNull();
    expect(value.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "PLUGIN_SETTINGS_READ_NOT_READ_ONLY",
        serverId: "server",
      }),
    ]);
    f.catalog.mockImplementation(async () => {
      const current = catalog();
      return {
        ...current,
        tools: current.tools.map((tool) =>
          tool.name === "read"
            ? { ...tool, annotations: { readOnlyHint: true } }
            : tool,
        ),
      };
    });
    expect(
      (await (await post("discover", server)).json()).diagnostics,
    ).toBeUndefined();
  });
  it("binds the original settings tools and carries typed false/zero updates through the common invoker", async () => {
    await opened();
    const response = await post("update", {
      ...op(),
      set: { enabled: false, count: 0 },
    });
    expect(response.status).toBe(200);
    expect(f.invoke.mock.calls.at(-1)?.[1]).toMatchObject({
      origin: "settings",
      params: {
        name: "save",
        arguments: { set: { enabled: false, count: 0 } },
      },
    });
  });
  it("forwards coordinated durable admission reads through settings resolution", async () => {
    await opened();
    const input = f.invoke.mock.calls.at(-1)![1];
    const read = vi.fn(async (query: () => Promise<unknown>) => query());
    const signal = AbortSignal.timeout(1000);
    await input.resolve("read", signal, read);
    expect(f.catalog).toHaveBeenLastCalledWith(signal, read);
  });
  it("refuses unsupported update before creating a request runtime", async () => {
    await opened();
    f.release.mockClear();
    expect(
      (await post("update", { ...op(), set: { unknown: true } })).status,
    ).toBe(403);
    expect(f.release).not.toHaveBeenCalled();
  });
  it("rechecks the whole settings binding before cached delivery", async () => {
    await opened();
    f.catalog.mockResolvedValue({ ...catalog(), hostRevision: "changed" });
    expect((await post("read", op())).status).toBe(403);
  });
  it.each([
    [
      { title: "Reset library", annotations: { title: "Annotation label" } },
      "Reset library",
    ],
    [{ annotations: { title: "Annotation label" } }, "Annotation label"],
    [{}, "reset"],
  ])(
    "labels settings actions from the referenced tool: %j",
    async (presentation, title) => {
      f.catalog.mockImplementation(async () => {
        const current = catalog();
        return {
          ...current,
          tools: current.tools.map((tool) =>
            tool.name === "reset" ? { ...tool, ...presentation } : tool,
          ),
        };
      });
      await opened();
      const response = await post("actions", handle());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        actions: [{ name: "reset", title, kind: "app" }],
      });
    },
  );
  it("refuses undeclared action tools", async () => {
    await opened();
    expect(
      (await post("action", { ...op(), toolName: "foreign" })).status,
    ).toBe(403);
  });
  it("opens declared App HTML without executing its action, revokes child calls after close", async () => {
    await opened();
    f.invoke.mockClear();
    const response = await post("app/open", { ...handle(), toolName: "reset" });
    expect(response.status).toBe(200);
    const child = await response.json();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(child.resourceUri).toBe("ui://settings");
    expect(
      (await post("app/close", { ...handle(), childToken: child.childToken }))
        .status,
    ).toBe(200);
    expect(
      (
        await post("app/call", {
          ...op(),
          childToken: child.childToken,
          params: { name: "reset", arguments: {} },
        })
      ).status,
    ).toBe(403);
  });
  it.each([
    ["above the old 1 MiB limit", "a".repeat(1024 * 1024 + 1), 200],
    ["exactly 5 MiB", "a".repeat(5 * 1024 * 1024), 200],
    ["over 5 MiB in UTF-8 bytes", "é".repeat(2621441), 403],
  ])("opens settings App HTML up to the common UI bound: %s", async (_name, html, status) => {
    f.read.mockResolvedValue({
      contents: [
        {
          uri: "ui://settings",
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: { ui: { csp: {} } },
        },
      ],
    });
    await opened();
    const response = await post("app/open", { ...handle(), toolName: "reset" });
    expect(response.status).toBe(status);
  });
  it.each([
    [true, 1_200_000, 200],
    [false, 1_200_000, 403],
    [true, PLUGIN_APP_READ_RESULT_BYTES + 1, 403],
  ])(
    "uses the admitted read-only App result budget: readOnly=%s bytes=%s",
    async (readOnlyHint, bytes, status) => {
      await opened();
      f.catalog.mockImplementation(async () => {
        const current = catalog();
        return {
          ...current,
          tools: current.tools.map((tool) =>
            tool.name === "reset"
              ? { ...tool, annotations: { readOnlyHint } }
              : tool,
          ),
        };
      });
      const openedApp = await post("app/open", {
        ...handle(),
        toolName: "reset",
      });
      expect(openedApp.status).toBe(200);
      const child = await openedApp.json();
      const result = { content: [{ type: "text", text: "x".repeat(bytes) }] };
      f.invoke.mockImplementation(async (c, input) => {
        try {
          const resolved = await input.resolve(
            input.params.name,
            c.req.raw.signal,
          );
          input.assertLive();
          input.assertOrigin(resolved);
          input.validate(resolved)(result);
          return c.json({ status: "completed", result });
        } finally {
          await input.runtime.release();
        }
      });
      const response = await post("app/call", {
        ...op(),
        childToken: child.childToken,
        params: { name: "reset", arguments: {} },
      });
      expect(response.status).toBe(status);
      if (status === 200)
        expect((await response.json()).result).toEqual(result);
    },
  );
  it("refuses actions once the Settings App's row is gone", async () => {
    await opened();
    f.get.mockImplementation(() => {
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    });
    const response = await post("actions", handle());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("INSTANCE_UNAVAILABLE");
  });
  it("rejects caller supplied authority before admission", async () => {
    expect(
      (await post("discover", { ...server, actorId: "foreign" })).status,
    ).toBe(400);
    expect(f.admit).not.toHaveBeenCalled();
  });
});

it("binds Settings App receipts to the child token and refuses undeclared actions before reading", async () => {
  await withReceiptSigning(async () => {
    await opened();
    const html = "<p>Settings α</p>";
    const csp = { connectDomains: ["https://settings.example"] };
    f.read.mockResolvedValue({ contents: [{ uri: "ui://settings", mimeType: "text/html;profile=mcp-app", text: html, _meta: { ui: { csp } } }] });
    const web = webReceiptApp(routes, "settings");
    const request = (toolName: string) => web.request("/api/web/settings/app/open", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...handle(), toolName }),
    });
    const response = await request("reset");
    expect(response.status).toBe(200);
    const result = await response.json();
    try {
      expect(result.widgetContent).toMatchObject({ html, csp });
      expectOwnedSourceReceipt(result.widgetContent, { serverId: "server", resourceUri: "ui://settings", toolCallId: result.childToken });
      f.read.mockClear();
      const denied = await request("not-declared");
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("sourceReceipt");
      expect(f.read).not.toHaveBeenCalled();
    } finally {
      await post("app/close", { ...handle(), childToken: result.childToken });
    }
  });
});
