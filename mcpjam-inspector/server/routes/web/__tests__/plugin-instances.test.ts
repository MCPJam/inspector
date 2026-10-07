import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  admission: vi.fn(),
  cleanup: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  catalog: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
  read: vi.fn(),
  renew: vi.fn(),
  fence: vi.fn(),
  context: vi.fn(),
  plugins: vi.fn(),
  get: vi.fn(),
  live: vi.fn(),
  lifetime: vi.fn(),
}));
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.plugins }),
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugin-host/admission.js")
  >()),
  admitPluginWorkspace: f.admission,
  resolvePluginCleanupActor: f.cleanup,
  readPluginExecutionContext: f.context,
}));
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: {
    openActivationPersistent: f.open,
    closePersistent: f.close,
    renewPersistent: f.renew,
    getPersistent: f.get,
    get: f.live,
    signal: f.lifetime,
  },
}));
vi.mock("../../../services/plugin-host/request-runtime.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugin-host/request-runtime.js")
  >()),
  assertPluginInstanceBindingCurrent: f.fence,
  createPluginRequestRuntime: () => ({
    catalog: f.catalog,
    resolve: f.resolve,
    release: f.release,
  }),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
import routes from "../plugin-instances";
import { PluginWorkspaceAdmissionError } from "../../../services/plugin-host/admission";
const app = new Hono().route("/instances", routes);
const body = {
  projectId: "project",
  pluginWorkspace: { version: 1, workspaceId: "workspace" },
  hostId: "host",
  serverId: "saved-id",
};
const tool = {
  name: "thread-app",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    ui: { resourceUri: "ui://fixture" },
    "openai/ui": { entrypoints: [{ type: "thread" }] },
  },
};
const post = (path: string, data: unknown) =>
  app.request(`/instances/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture",
    },
    body: JSON.stringify(data),
  });
beforeEach(() => {
  vi.clearAllMocks();
  f.admission.mockResolvedValue({
    actorId: "actor",
    projectId: "project",
    revalidate: vi.fn(),
  });
  f.catalog.mockResolvedValue({ tools: [tool] });
  f.release.mockResolvedValue(undefined);
  f.cleanup.mockResolvedValue("actor");
  f.close.mockResolvedValue(undefined);
});
describe("authenticated thread adapter boundaries", () => {
  it("resolves a chat-clicked link by manifest name and refuses an ambiguous one", async () => {
    const pluginServer = (serverId: string, pluginId: string) => ({
      kind: "plugin",
      serverId,
      pluginId,
      pluginVersionId: `${pluginId}-v`,
      bundleHash: "b",
      componentKey: "c",
    });
    f.context.mockResolvedValue({
      hostConfig: { hostId: "host", hostStyle: "chatgpt" },
      serverNamesById: { a: "Bolts A", b: "Bolts B", plain: "Plain" },
      serverBindings: new Map<string, unknown>([
        ["a", pluginServer("a", "inst-a")],
        ["b", pluginServer("b", "inst-b")],
        ["plain", { kind: "standalone", serverId: "plain" }],
      ]),
    });
    f.plugins.mockResolvedValue([
      { pluginId: "inst-a", name: "bolts", displayName: "Bolts" },
      { pluginId: "inst-b", name: "nuts", displayName: "Nuts" },
    ]);
    const request = (url: string) =>
      post("deep-link/resolve", {
        projectId: "project",
        pluginWorkspace: body.pluginWorkspace,
        hostId: "host",
        serverIds: ["a", "b", "plain"],
        url,
      });
    const resolved = await request(
      "chatgpt://plugins/bolts/app/cad.library?path=%2Fparts%2F7",
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      serverId: "a",
      toolName: "cad.library",
      url: "/parts/7",
    });
    expect(
      await (await request("chatgpt://plugins/server-plain/app/x")).json(),
    ).toMatchObject({ serverId: "plain" });
    f.plugins.mockResolvedValue([
      { pluginId: "inst-a", name: "bolts", displayName: "Bolts" },
      { pluginId: "inst-b", name: "bolts", displayName: "Bolts Copy" },
    ]);
    const ambiguous = await request("chatgpt://plugins/bolts/app/x");
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      code: "PLUGIN_DEEP_LINK_AMBIGUOUS",
      description: expect.stringContaining("@<marketplace>"),
      candidates: ["Bolts", "Bolts Copy"],
      diagnostics: [
        expect.objectContaining({
          level: "error",
          code: "PLUGIN_DEEP_LINK_AMBIGUOUS",
          details: { candidates: ["Bolts", "Bolts Copy"] },
        }),
      ],
    });
    const invalid = await request("chatgpt://plugins/bolts/app/x#frag");
    expect(await invalid.json()).toMatchObject({
      code: "PLUGIN_DEEP_LINK_INVALID",
      description: expect.stringContaining("isn't a valid plugin link"),
    });
  });
  it("picks link schemes from the client runtime, never hostContext.platform", async () => {
    const config = (harness?: string) => ({
      hostId: "host",
      hostStyle: harness === "codex" ? "codex" : "chatgpt",
      ...(harness ? { harness } : {}),
      hostContext: { platform: "desktop" },
    });
    const request = () =>
      post("deep-link/resolve", {
        projectId: "project",
        pluginWorkspace: body.pluginWorkspace,
        hostId: "host",
        serverIds: ["plain"],
        url: "codex://plugins/server-plain/app/x",
      });
    const context = (harness?: string) =>
      f.context.mockResolvedValue({
        hostConfig: config(harness),
        serverNamesById: { plain: "Plain" },
        serverBindings: new Map<string, unknown>([
          ["plain", { kind: "standalone", serverId: "plain" }],
        ]),
      });
    // A ChatGPT client declaring a desktop platform still refuses codex://.
    context();
    expect(await (await request()).json()).toMatchObject({
      code: "PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED",
    });
    context("codex");
    expect(await (await request()).json()).toMatchObject({
      serverId: "plain",
      toolName: "x",
    });
  });
  it("renews a retained App through the binding fence and keeps its handle", async () => {
    const token = "a".repeat(43);
    f.renew.mockImplementation(
      async (_token, _actor, _signal, authorize: (i: unknown) => unknown) => {
        await authorize({ hostId: "host" });
        return { expiresAt: 1234, renewed: true };
      },
    );
    const response = await post("renew", {
      projectId: "project",
      pluginWorkspace: body.pluginWorkspace,
      instanceToken: token,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "renewed",
      expiresAt: 1234,
    });
    expect(f.renew.mock.calls[0][0]).toBe(token);
    expect(f.renew.mock.calls[0][1]).toMatchObject({
      actorId: "actor",
      workspaceId: "workspace",
      subject: "verified-subject",
    });
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.open).not.toHaveBeenCalled();
    // A lease at its ceiling (a writable file viewer) reports its deadline.
    f.renew.mockResolvedValueOnce({ expiresAt: 999, renewed: false });
    const fixed = await post("renew", {
      projectId: "project",
      pluginWorkspace: body.pluginWorkspace,
      instanceToken: token,
    });
    expect(await fixed.json()).toEqual({ status: "unchanged", expiresAt: 999 });
  });

  it("keeps a writable file viewer's grant with its lease, and says why when it can't", async () => {
    const { mkdtemp, realpath, writeFile, readFile, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await realpath(await mkdtemp(join(tmpdir(), "renew-viewer-")));
    const lifetime = new AbortController();
    try {
      await writeFile(join(root, "part.stl"), "solid part");
      const viewer = {
        hostId: "host",
        hostRevision: "host-revision",
        subject: "verified-subject",
        serverIdentity: { kind: "standalone", serverId: "saved-id" },
        owner: {
          actorId: "actor",
          projectId: "project",
          workspaceId: "workspace",
          instanceId: crypto.randomUUID(),
          generation: 1,
          serverId: "saved-id",
          bindingId: "binding",
          placement: "interactive",
        },
        activation: {
          selector: { kind: "file", requestId: crypto.randomUUID() },
          toolName: "cad-viewer",
          revision: "tool-revision",
          operationId: crypto.randomUUID(),
          file: {
            kind: "saved-resource",
            version: 1,
            uri: "cad://part",
            name: "part.stl",
            sourceName: "part-id",
            localTarget: {
              root,
              relativePath: "part.stl",
              uri: "cad://part",
              exclusiveWrites: true,
            },
          },
        },
      };
      f.renew.mockImplementation(
        async (_token, _actor, _signal, authorize: (i: unknown) => unknown) => {
          await authorize(viewer);
          return { expiresAt: Date.now() + 30 * 60_000, renewed: true };
        },
      );
      f.get.mockResolvedValue(viewer);
      f.live.mockReturnValue(viewer);
      f.lifetime.mockReturnValue(lifetime.signal);
      const listResources = vi.fn(async () => ({
        resources: [{ uri: "cad://part", name: "part-id" }],
      }));
      const toggles = { fileResources: true };
      f.resolve.mockImplementation(async () => ({
        revision: "tool-revision",
        extensions: { enabled: true, capabilities: { ...toggles } },
        manager: { listResources },
        localFileTargetContract: {
          version: 1,
          targets: [
            {
              serverId: "saved-id",
              root,
              exclusiveWrites: true,
              resources: [{ uri: "cad://part", relativePath: "part.stl" }],
            },
          ],
        },
      }));
      const handle = {
        projectId: "project",
        pluginWorkspace: body.pluginWorkspace,
        instanceToken: "b".repeat(43),
      };
      // Renewed with its lease: the grant's target, listing and toggles were
      // re-checked.
      const renewed = await post("renew", handle);
      expect(await renewed.json()).toEqual({
        status: "renewed",
        expiresAt: expect.any(Number),
      });
      expect(f.resolve).toHaveBeenCalled();
      expect(listResources).toHaveBeenCalled();
      // File resources off: the App's lease still renews (it stays open), and
      // the Logs say why saving is paused.
      toggles.fileResources = false;
      const paused = await post("renew", handle);
      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({
        status: "renewed",
        diagnostics: [
          expect.objectContaining({
            level: "warning",
            code: "PLUGIN_EXTENSION_DISABLED",
            title: "Saving paused: part.stl",
            serverId: "saved-id",
            description: expect.stringContaining("unsaved changes"),
          }),
        ],
      });
      // This process never held the viewer's grant (as after a restart): it
      // was issued again in place under the App's URI. A save before the
      // App reads again is refused with a description and a Logs entry.
      toggles.fileResources = true;
      const { ownedFileResources } = await import(
        "../../../services/plugin-host/owned-file-resources"
      );
      const uri = ownedFileResources.get(viewer as never, lifetime.signal).input
        .file.resourceUri;
      const refused = await post("files/write", {
        ...handle,
        operationId: crypto.randomUUID(),
        params: { uri, text: "edited" },
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "RESOURCE_READ_REQUIRED",
        description: expect.stringContaining("unsaved changes"),
        diagnostics: [
          expect.objectContaining({
            code: "RESOURCE_READ_REQUIRED",
            title: "Save refused: part.stl",
            level: "warning",
          }),
        ],
      });
      expect(await readFile(join(root, "part.stl"), "utf8")).toBe("solid part");
    } finally {
      lifetime.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("discovers ordinary saved IDs without activation, resource read or an environment", async () => {
    const response = await post("discover", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entries: [
        { toolName: "thread-app", title: "thread-app", kind: "thread" },
      ],
      mentions: { available: false },
    });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("explains why a local file can't be opened and logs it", async () => {
    f.get.mockResolvedValue({
      hostId: "host",
      owner: { serverId: "saved-id" },
    });
    f.catalog.mockResolvedValue({
      tools: [tool],
      fileTargets: {
        placement: "local",
        unavailable: "PLUGIN_LOCAL_FILES_NOT_CONFIGURED",
      },
    });
    const response = await post("files/open", {
      projectId: "project",
      pluginWorkspace: body.pluginWorkspace,
      instanceToken: "a".repeat(43),
      path: "/parts/part.stl",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "PLUGIN_LOCAL_FILES_NOT_CONFIGURED",
      description: expect.stringContaining("MCPJAM_PLUGIN_LOCAL_FILE_ROOTS"),
      diagnostics: [
        expect.objectContaining({
          level: "error",
          serverId: "saved-id",
          details: expect.objectContaining({
            env: "MCPJAM_PLUGIN_LOCAL_FILE_ROOTS",
          }),
        }),
      ],
    });
  });
  it("opens a file on the project's Computer, and explains an unreachable one", async () => {
    const { pluginComputerFiles } = await import("../plugin-instances");
    const { fakeComputerFiles } = await import(
      "../../../services/plugin-host/testing/fake-computer-files"
    );
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "solid" });
    const connector = vi
      .spyOn(pluginComputerFiles, "connector")
      .mockReturnValue(async () => fs);
    f.get.mockResolvedValue({ hostId: "host", owner: { serverId: "saved-id" } });
    const viewer = {
      name: "cad.viewer",
      inputSchema: { type: "object" },
      _meta: {
        ui: { resourceUri: "ui://cad" },
        "openai/ui": { entrypoints: [{ type: "file", extensions: [".stl"] }] },
      },
    };
    f.catalog.mockResolvedValue({
      tools: [viewer],
      fileTargets: { placement: "computer" },
      localFileTargetContract: {
        version: 1,
        targets: [
          {
            serverId: "saved-id",
            root: "/home/user/parts",
            exclusiveWrites: true,
            resources: [{ uri: "cad://bolt", relativePath: "bolt.stl" }],
          },
        ],
      },
      manager: {
        listResources: async () => ({
          resources: [{ uri: "cad://bolt", name: "bolt.stl" }],
        }),
      },
    });
    const open = (path: string) =>
      post("files/open", {
        projectId: "project",
        pluginWorkspace: body.pluginWorkspace,
        instanceToken: "a".repeat(43),
        path,
      });
    const opened = await open("/home/user/parts/bolt.stl");
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      file: { uri: "cad://bolt", name: "bolt.stl" },
      entries: [expect.objectContaining({ toolName: "cad.viewer" })],
    });
    expect(fs.calls).toContain("getInfo /home/user/parts/bolt.stl");
    // A path outside the box home is never resolved.
    expect((await (await open("/etc/passwd")).json()).code).toBe(
      "PLUGIN_LOCAL_FILE_NOT_LISTED",
    );
    const { PluginComputerUnavailableError } = await import(
      "../../../services/plugin-host/computer-file-target"
    );
    connector.mockReturnValue(async () => {
      throw new PluginComputerUnavailableError("saved-id");
    });
    const asleep = await open("/home/user/parts/bolt.stl");
    expect(asleep.status).toBe(503);
    expect(await asleep.json()).toMatchObject({
      code: "PLUGIN_COMPUTER_UNAVAILABLE",
      description: expect.stringContaining("asleep or unreachable"),
      diagnostics: [expect.objectContaining({ serverId: "saved-id" })],
    });
    connector.mockRestore();
  });
  it("keeps local files refused for a remote HTTP server, saying why", async () => {
    f.get.mockResolvedValue({ hostId: "host", owner: { serverId: "saved-id" } });
    f.catalog.mockResolvedValue({
      tools: [tool],
      fileTargets: {
        placement: "computer",
        unavailable: "PLUGIN_FILES_REMOTE_SERVER",
      },
    });
    const response = await post("files/open", {
      projectId: "project",
      pluginWorkspace: body.pluginWorkspace,
      instanceToken: "a".repeat(43),
      path: "/home/user/parts/bolt.stl",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "PLUGIN_FILES_REMOTE_SERVER",
      description: expect.stringContaining("shares no disk"),
      diagnostics: [
        expect.objectContaining({
          level: "error",
          code: "PLUGIN_FILES_REMOTE_SERVER",
          serverId: "saved-id",
        }),
      ],
    });
  });
  it("enforces the client's per-extension toggles server-side", async () => {
    const off = (capabilities: Record<string, boolean>) => ({
      enabled: true,
      explicit: true,
      capabilities: {
        sidebarApps: true,
        conversationPanels: true,
        deepLinks: true,
        ...capabilities,
      },
    });
    f.catalog.mockResolvedValue({
      tools: [
        {
          ...tool,
          _meta: {
            ...tool._meta,
            "openai/ui": {
              entrypoints: [{ type: "global" }, { type: "thread" }],
            },
          },
        },
      ],
      extensions: off({ conversationPanels: false }),
    });
    const discovered = await (await post("discover", body)).json();
    expect(discovered.entries.map((e: { kind: string }) => e.kind)).toEqual([
      "global",
    ]);
    const refused = await post("activation/open", {
      ...body,
      threadId: "thread",
      toolName: tool.name,
      kind: "thread",
    });
    expect(await refused.json()).toMatchObject({
      code: "PLUGIN_EXTENSION_DISABLED",
      description: expect.stringContaining("turned off"),
    });
    expect(f.open).not.toHaveBeenCalled();
  });
  it("applies launcher toggles at activation admission: no launcher and no new open", async () => {
    const off = (capabilities: Record<string, boolean>) => ({
      enabled: true,
      explicit: true,
      capabilities: {
        sidebarApps: true,
        conversationPanels: true,
        fileViewers: true,
        deepLinks: true,
        ...capabilities,
      },
    });
    const viewer = {
      ...tool,
      name: "cad-viewer",
      _meta: {
        ...tool._meta,
        "openai/ui": {
          entrypoints: [
            {
              type: "global",
              quickAction: {
                title: "Import part",
                icons: [{ src: "https://fixture.invalid/import.svg" }],
                target: { type: "tool", name: "cad-viewer", arguments: {} },
              },
            },
            { type: "file", extensions: [".cad"] },
          ],
        },
      },
    };
    const listResources = vi.fn().mockResolvedValue({
      resources: [{ uri: "resource://model", name: "model.cad" }],
    });
    f.catalog.mockResolvedValue({
      tools: [viewer],
      manager: { listResources },
      extensions: off({}),
    });
    expect(
      (await (await post("discover", body)).json()).entries.map(
        (entry: { kind: string }) => entry.kind,
      ),
    ).toEqual(["global", "quick-action"]);
    f.catalog.mockResolvedValue({
      tools: [viewer],
      manager: { listResources },
      extensions: off({ sidebarApps: false, fileViewers: false }),
    });
    // The sidebar launcher (global row and its quick action) disappears.
    const discovered = await (await post("discover", body)).json();
    expect(discovered.entries).toEqual([]);
    // File-open routing ("Open with…") and a new file viewer are refused.
    const routing = await post("files/discover", {
      ...body,
      resourceUri: "resource://model",
    });
    expect(await routing.json()).toMatchObject({
      code: "PLUGIN_EXTENSION_DISABLED",
    });
    expect(listResources).not.toHaveBeenCalled();
    for (const kind of ["file", "global"] as const) {
      const refused = await post("activation/open", {
        ...body,
        threadId: "thread",
        toolName: viewer.name,
        kind,
        ...(kind === "file"
          ? {
              resourceUri: "resource://model",
              requestId: crypto.randomUUID(),
            }
          : {}),
      });
      expect(await refused.json()).toMatchObject({
        code: "PLUGIN_EXTENSION_DISABLED",
        description: expect.stringContaining("turned off"),
      });
    }
    expect(f.open).not.toHaveBeenCalled();
  });
  it("returns a refusal's Logs entries with its description", async () => {
    const { PluginInvocationError, withPluginDiagnostic } = await import(
      "../../../services/plugin-host/invocation"
    );
    f.catalog.mockRejectedValue(
      withPluginDiagnostic(
        new PluginInvocationError("PLUGIN_FORMS_DISABLED"),
        "saved-id",
        "Upload refused: Forms is turned off for this client",
      ),
    );
    const response = await post("discover", body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "PLUGIN_FORMS_DISABLED",
      description: expect.stringContaining("Forms turned off"),
      diagnostics: [
        expect.objectContaining({
          code: "PLUGIN_FORMS_DISABLED",
          serverId: "saved-id",
          title: "Upload refused: Forms is turned off for this client",
        }),
      ],
    });
  });
  it("reports a server's mention tool in discovery", async () => {
    f.catalog.mockResolvedValue({
      tools: [
        tool,
        {
          name: "search",
          title: "Parts",
          inputSchema: { type: "object" },
          _meta: { "openai/extensions": { "mentions/search": {} } },
        },
      ],
    });
    expect((await (await post("discover", body)).json()).mentions).toEqual({
      available: true,
      toolName: "search",
      title: "Parts",
    });
  });
  it("returns each entrypoint's tool icons and the server icon", async () => {
    const svg = "https://cdn.example.invalid/parts.svg";
    f.catalog.mockResolvedValue({
      tools: [
        { ...tool, icons: [{ src: svg, mimeType: "image/svg+xml" }] },
        {
          ...tool,
          name: "no-icon",
          _meta: {
            ...tool._meta,
            "openai/ui": { entrypoints: [{ type: "global" }] },
          },
        },
      ],
      manager: {
        getInitializationInfo: () => ({
          serverVersion: {
            name: "bits",
            version: "1",
            icons: [{ src: "https://cdn.example.invalid/server.png" }],
          },
        }),
      },
    });
    const result = await (await post("discover", body)).json();
    expect(result.entries).toEqual([
      {
        toolName: "thread-app",
        title: "thread-app",
        kind: "thread",
        toolIcons: [{ src: svg, mimeType: "image/svg+xml" }],
      },
      { toolName: "no-icon", title: "no-icon", kind: "global" },
    ]);
    expect(result.serverIcons).toEqual([
      { src: "https://cdn.example.invalid/server.png" },
    ]);
  });
  it("names the installed plugin that owns a server, and none for a plain one", async () => {
    f.catalog.mockResolvedValue({
      tools: [tool],
      serverIdentity: {
        kind: "plugin",
        serverId: "saved-id",
        pluginId: "plugin-1",
        pluginVersionId: "plugin-1-v",
        bundleHash: "b",
        componentKey: "c",
      },
    });
    expect((await (await post("discover", body)).json()).pluginId).toBe(
      "plugin-1",
    );
    f.catalog.mockResolvedValue({
      tools: [tool],
      serverIdentity: { kind: "standalone", serverId: "saved-id" },
    });
    expect(
      "pluginId" in (await (await post("discover", body)).json()),
    ).toBe(false);
  });
  it("discovers global and thread declarations separately without dispatch", async () => {
    f.catalog.mockResolvedValue({
      tools: [
        {
          ...tool,
          _meta: {
            ...tool._meta,
            "openai/ui": {
              entrypoints: [{ type: "global" }, { type: "thread" }],
            },
          },
        },
      ],
    });
    const result = await (await post("discover", body)).json();
    expect(result.entries.map((entry: { kind: string }) => entry.kind)).toEqual(
      ["global", "thread"],
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("refuses an undeclared global activation before reading its UI", async () => {
    f.resolve.mockResolvedValue({ tool });
    const result = await post("activation/open", {
      ...body,
      threadId: "thread",
      toolName: tool.name,
      kind: "global",
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("refuses unavailable admission before catalog access", async () => {
    f.admission.mockRejectedValueOnce(new PluginWorkspaceAdmissionError());
    expect((await post("discover", body)).status).toBe(403);
    expect(f.catalog).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, environmentId: "invented" },
    {
      ...body,
      pluginWorkspace: {
        version: 1,
        workspaceId: "workspace",
        actorId: "foreign",
      },
    },
    { ...body, serverId: "" },
  ])("refuses extra authority and malformed identity", async (data) => {
    expect((await post("discover", data)).status).toBe(400);
    expect(f.catalog).not.toHaveBeenCalled();
  });
  it("omits undeclared and non-UI tools without executing", async () => {
    f.catalog.mockResolvedValue({
      tools: [
        { name: "ordinary", inputSchema: {} },
        {
          ...tool,
          _meta: { "openai/ui": { entrypoints: [{ type: "thread" }] } },
        },
        {
          ...tool,
          _meta: {
            ui: { resourceUri: "https://external" },
            "openai/ui": { entrypoints: [{ type: "thread" }] },
          },
        },
      ],
    });
    expect(await (await post("discover", body)).json()).toEqual({
      entries: [],
      mentions: { available: false },
    });
    expect(f.open).not.toHaveBeenCalled();
  });
  it("cleanup authenticates identity without requiring enabled admission", async () => {
    const response = await post("close", {
      projectId: "project",
      pluginWorkspace: body.pluginWorkspace,
      instanceToken: "a".repeat(43),
    });
    expect(response.status).toBe(200);
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledWith(
      "a".repeat(43),
      {
        projectId: "project",
        workspaceId: "workspace",
        subject: "verified-subject",
        actorId: "actor",
      },
      expect.any(AbortSignal),
    );
  });
});

describe("saved resource file discovery", () => {
  it("lists only matching declared viewers without executing them", async () => {
    const listResources = vi.fn().mockResolvedValue({
      resources: [{ uri: "resource://model", name: "model.cad" }],
    });
    f.catalog.mockResolvedValue({
      tools: [
        {
          ...tool,
          name: "cad-viewer",
          _meta: {
            ...tool._meta,
            "openai/ui": {
              entrypoints: [{ type: "file", extensions: [".cad"] }],
            },
          },
        },
      ],
      manager: { listResources },
    });
    const response = await post("files/discover", {
      ...body,
      resourceUri: "resource://model",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).entries).toEqual([
      { toolName: "cad-viewer", title: "cad-viewer", extensions: [".cad"] },
    ]);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("refuses an unlisted resource instead of granting an arbitrary URI", async () => {
    f.catalog.mockResolvedValue({
      tools: [tool],
      manager: { listResources: vi.fn().mockResolvedValue({ resources: [] }) },
    });
    const response = await post("files/discover", {
      ...body,
      resourceUri: "file:///private",
    });
    expect(response.status).toBe(403);
    expect(f.open).not.toHaveBeenCalled();
  });
});

it("uses the operator-mapped filename for a listed resource with an opaque name", async () => {
  const listResources = vi
    .fn()
    .mockResolvedValue({ resources: [{ uri: "cad://part", name: "part-id" }] });
  f.catalog.mockResolvedValue({
    tools: [
      {
        ...tool,
        name: "viewer",
        _meta: {
          ...tool._meta,
          "openai/ui": {
            entrypoints: [{ type: "file", extensions: [".stl"] }],
          },
        },
      },
    ],
    manager: { listResources },
    localFileTargetContract: {
      version: 1,
      targets: [
        {
          serverId: "saved-id",
          root: "/disposable",
          exclusiveWrites: true,
          resources: [{ uri: "cad://part", relativePath: "models/part.stl" }],
        },
      ],
    },
  });
  const response = await post("files/discover", {
    ...body,
    resourceUri: "cad://part",
  });
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.file).toEqual({ uri: "cad://part", name: "part.stl" });
  expect(value.entries).toHaveLength(1);
  expect(JSON.stringify(value)).not.toContain("/disposable");
});

describe("App tool metadata (H7)", () => {
  it("covers every page, only App-visible tools, within a bound", async () => {
    const { pluginAppToolsMetadata, PLUGIN_APP_TOOLS_METADATA_COUNT } =
      await import("../plugin-instances");
    const result = pluginAppToolsMetadata([
      { name: "visible", _meta: { ui: { visibility: ["app"] } } },
      { name: "default" },
      { name: "model-only", _meta: { ui: { visibility: ["model"] } } },
    ]);
    expect(Object.keys(result.value)).toEqual(["visible", "default"]);
    expect(result.diagnostics).toEqual([]);
    const many = Array.from(
      { length: PLUGIN_APP_TOOLS_METADATA_COUNT + 3 },
      (_, index) => ({ name: `t${index}` }),
    );
    const bounded = pluginAppToolsMetadata(many);
    expect(Object.keys(bounded.value)).toHaveLength(
      PLUGIN_APP_TOOLS_METADATA_COUNT,
    );
    expect(bounded.diagnostics[0]).toMatchObject({
      code: "PLUGIN_APP_TOOLS_METADATA_TRUNCATED",
      details: { omitted: 3 },
    });
  });
});

describe("form preview refusals", () => {
  it.each(["form-preview", "form-preview/app/open"])(
    "%s names its code and a plain description for the form",
    async (path) => {
      const response = await post(path, {
        projectId: "project",
        pluginWorkspace: body.pluginWorkspace,
        sourceToken: "a".repeat(43),
        parent: { kind: "legacy", id: "gone", round: 0 },
        target:
          path === "form-preview"
            ? {
                type: "resource_link",
                uri: "fixture://preview",
                name: "Part preview",
              }
            : { type: "mcp_app_tool", name: "part.preview" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "FORM_SOURCE_UNAVAILABLE",
        description: "This form has expired or was already answered.",
      });
    },
  );
});
