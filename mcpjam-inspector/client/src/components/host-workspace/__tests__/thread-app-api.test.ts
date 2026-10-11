import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadAppApi, type ThreadAppHandle } from "../thread-app-api";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch: fetch }));
const scope = {
  projectId: "project",
  hostId: "client",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const handle: ThreadAppHandle = {
  instanceToken: "opaque",
  instanceId: "instance",
  generation: 1,
  operationId: "original",
  resourceUri: "ui://app",
  toolTitle: "App",
  appToolsEnabled: true,
  widgetContent: { html: "<p>App</p>" },
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const signal = () => AbortSignal.timeout(1000);
describe("thread App authenticated transport", () => {
  beforeEach(() => fetch.mockReset());
  it("discovers from a saved ID without an environment, bundle or selected tool", async () => {
    fetch.mockResolvedValueOnce(
      response({
        entries: [{ kind: "thread", toolName: "app", title: "App" }],
      }),
    );
    expect(
      await createThreadAppApi(scope).discover("saved-server", signal()),
    ).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      projectId: "project",
      hostId: "client",
      serverId: "saved-server",
      pluginWorkspace: scope.pluginWorkspace,
    });
  });
  it("logs server diagnostics, never hands them to the App, and describes errors", async () => {
    const { useTrafficLogStore } = await import("@/stores/traffic-log-store");
    useTrafficLogStore.getState().clear();
    fetch.mockResolvedValueOnce(
      response({
        contents: [{ uri: "host-resource://f", text: "solid" }],
        diagnostics: [
          {
            level: "warning",
            code: "PLUGIN_FILE_READ_REPRESENTATION_UNSPECIFIED",
            title: "File read: part.stl has no representation",
            description: "Set a representation.",
            serverId: "s1",
          },
        ],
      }),
    );
    const read = await createThreadAppApi(scope).readFile(
      { ...handle, file: { name: "part.stl", resourceUri: "host-resource://f" } },
      { uri: "host-resource://f" },
      signal(),
    );
    expect(read).not.toHaveProperty("diagnostics");
    const rows = useTrafficLogStore.getState().mcpServerItems;
    expect(rows.at(-1)).toMatchObject({
      serverId: "s1",
      method: "plugin-extensions/PLUGIN_FILE_READ_REPRESENTATION_UNSPECIFIED",
      payload: {
        level: "warning",
        code: "PLUGIN_FILE_READ_REPRESENTATION_UNSPECIFIED",
        message: "Set a representation.",
        title: "File read: part.stl has no representation",
      },
    });
    fetch.mockResolvedValueOnce(response({ code: "RESOURCE_NOT_TEXT" }, 403));
    const error = await createThreadAppApi(scope)
      .readFile(
        { ...handle, file: { name: "part.stl", resourceUri: "host-resource://f" } },
        { uri: "host-resource://f" },
        signal(),
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "RESOURCE_NOT_TEXT",
      description: expect.stringContaining("isn't text"),
    });
  });
  it("resolves a chat-clicked deep link among the chat's servers", async () => {
    fetch.mockResolvedValueOnce(
      response({ serverId: "s1", toolName: "cad.library", url: "/parts" }),
    );
    const url = "chatgpt://plugins/bits-and-bolts/app/cad.library?path=%2Fparts";
    expect(
      await createThreadAppApi(scope).resolveDeepLink(
        url,
        ["s1", "s2"],
        signal(),
      ),
    ).toEqual({ serverId: "s1", toolName: "cad.library", url: "/parts" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      projectId: "project",
      pluginWorkspace: scope.pluginWorkspace,
      hostId: "client",
      serverIds: ["s1", "s2"],
      url,
    });
    fetch.mockResolvedValueOnce(
      response({ code: "PLUGIN_DEEP_LINK_AMBIGUOUS", candidates: ["A", "B"] }, 409),
    );
    await expect(
      createThreadAppApi(scope).resolveDeepLink(url, ["s1"], signal()),
    ).rejects.toMatchObject({
      code: "PLUGIN_DEEP_LINK_AMBIGUOUS",
      candidates: ["A", "B"],
      description: expect.stringContaining("More than one"),
    });
  });
  it("renews a retained handle without reopening it", async () => {
    fetch.mockResolvedValueOnce(
      response({ status: "renewed", expiresAt: 1_800_000 }),
    );
    expect(await createThreadAppApi(scope).renew(handle, signal())).toEqual({
      expiresAt: 1_800_000,
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/web/apps/plugin-instances/renew",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      projectId: "project",
      pluginWorkspace: scope.pluginWorkspace,
      instanceToken: "opaque",
    });
    fetch.mockResolvedValueOnce(
      response({ code: "INSTANCE_UNAVAILABLE" }, 403),
    );
    await expect(
      createThreadAppApi(scope, "model/").renew(handle, signal()),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
    expect(fetch.mock.calls[1][0]).toBe(
      "/api/web/apps/plugin-instances/model/renew",
    );
  });
  it("reports whether a server offers mention search from discovery", async () => {
    fetch.mockResolvedValueOnce(
      response({
        entries: [],
        mentions: { available: true, toolName: "search", title: "Parts" },
      }),
    );
    expect(
      (await createThreadAppApi(scope).discoverServer("saved", signal()))
        .mentions,
    ).toEqual({ available: true, toolName: "search", title: "Parts" });
    fetch.mockResolvedValueOnce(response({ entries: [] }));
    expect(
      (await createThreadAppApi(scope).discoverServer("saved", signal()))
        .mentions,
    ).toEqual({ available: false });
  });
  it("carries tool and server icons on discovered declarations", async () => {
    fetch.mockResolvedValueOnce(
      response({
        entries: [
          {
            kind: "global",
            title: "Library",
            toolName: "library",
            toolIcons: [{ src: "https://cdn.example.invalid/l.svg" }],
          },
          { kind: "thread", title: "Tray", toolName: "tray" },
        ],
        serverIcons: [{ src: "https://cdn.example.invalid/s.png" }],
      }),
    );
    expect(await createThreadAppApi(scope).discover("saved", signal())).toEqual([
      {
        kind: "global",
        title: "Library",
        toolName: "library",
        toolIcons: [{ src: "https://cdn.example.invalid/l.svg" }],
        serverIcons: [{ src: "https://cdn.example.invalid/s.png" }],
      },
      {
        kind: "thread",
        title: "Tray",
        toolName: "tray",
        serverIcons: [{ src: "https://cdn.example.invalid/s.png" }],
      },
    ]);
  });
  it("reports the server's icons and owning plugin beside its entries", async () => {
    fetch.mockResolvedValueOnce(
      response({
        entries: [],
        serverIcons: [{ src: "https://cdn.example.invalid/s.png" }],
        pluginId: "plugin-1",
      }),
    );
    const found = await createThreadAppApi(scope).discoverServer(
      "saved",
      signal(),
    );
    expect(found.serverIcons).toEqual([
      { src: "https://cdn.example.invalid/s.png" },
    ]);
    expect(found.pluginId).toBe("plugin-1");
    // A plain server names no plugin; an unusable value is dropped, never
    // an error (display only).
    fetch.mockResolvedValueOnce(response({ entries: [], pluginId: 7 }));
    const plain = await createThreadAppApi(scope).discoverServer(
      "saved",
      signal(),
    );
    expect("pluginId" in plain).toBe(false);
    expect("serverIcons" in plain).toBe(false);
  });
  it("discovers and opens a global declaration with its explicit kind", async () => {
    fetch.mockResolvedValueOnce(
      response({
        entries: [{ kind: "global", title: "Library", toolName: "library" }],
      }),
    );
    const api = createThreadAppApi(scope);
    expect((await api.discover("saved", signal()))[0].kind).toBe("global");
    fetch.mockResolvedValueOnce(response({ ...handle, expiresAt: 1_800_000 }));
    // The lease deadline travels with the handle.
    expect(
      (await api.open("saved", "library", signal(), "global")).expiresAt,
    ).toBe(1_800_000);
    expect(JSON.parse(fetch.mock.calls[1][1].body).kind).toBe("global");
    fetch.mockResolvedValueOnce(response({ ...handle, expiresAt: "later" }));
    await expect(
      api.open("saved", "library", signal(), "global"),
    ).rejects.toThrow("INSTANCE_RESPONSE_INVALID");
  });
  it("retries lost activation delivery with identical original authority", async () => {
    fetch
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(
        response({ status: "completed", result: { content: [] } }),
      );
    await createThreadAppApi(scope).invoke(handle, signal(), vi.fn());
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[0][1].body).instanceToken).toBe(
      handle.instanceToken,
    );
  });
  it("keeps one App-call operation through approval and response retry", async () => {
    fetch
      .mockResolvedValueOnce(
        response(
          {
            status: "approval_required",
            approval: { id: "signed-proof", name: "read", params: {} },
          },
          409,
        ),
      )
      .mockRejectedValueOnce(new TypeError("lost accepted answer"))
      .mockResolvedValueOnce(
        response({
          status: "completed",
          result: { content: [], structuredContent: { zero: 0, no: false } },
        }),
      );
    const approve = vi.fn().mockResolvedValue(true);
    await createThreadAppApi(scope).invoke(handle, signal(), approve, {
      name: "read",
      arguments: { path: "synthetic" },
    });
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(new Set(bodies.map((body) => body.invocationId)).size).toBe(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(bodies[1].approval).toEqual({ id: "signed-proof", approved: true });
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[2][1].body);
  });
  it("uses the mounted context update route without a trailing slash", async () => {
    fetch.mockResolvedValueOnce(
      response({ revision: 1, sequence: 1, state: null }),
    );
    await createThreadAppApi(scope).context(
      handle.instanceToken,
      "update",
      { operationId: "test" },
      signal(),
    );
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/web/apps/plugin-instances/context",
    );
  });
  it("sends explicit denial and never turns it into acceptance", async () => {
    fetch
      .mockResolvedValueOnce(
        response(
          {
            status: "approval_required",
            approval: { id: "proof", name: "read", params: {} },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(response({ code: "INVOCATION_DENIED" }, 403));
    await expect(
      createThreadAppApi(scope).invoke(
        handle,
        signal(),
        vi.fn().mockResolvedValue(false),
      ),
    ).rejects.toThrow("INVOCATION_DENIED");
    expect(JSON.parse(fetch.mock.calls[1][1].body).approval.approved).toBe(
      false,
    );
  });
  it("does not retry cancellation and refuses malformed discovery/open DTOs", async () => {
    const abort = new AbortController();
    abort.abort();
    fetch.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    await expect(
      createThreadAppApi(scope).invoke(handle, abort.signal, vi.fn()),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(
      response({
        entries: [{ kind: "settings", title: "bad", toolName: "bad" }],
      }),
    );
    await expect(
      createThreadAppApi(scope).discover("server", signal()),
    ).rejects.toThrow("INSTANCE_RESPONSE_INVALID");
    fetch.mockResolvedValueOnce(
      response({ ...handle, appToolsEnabled: undefined }),
    );
    await expect(
      createThreadAppApi(scope).open("server", "app", signal()),
    ).rejects.toThrow("INSTANCE_RESPONSE_INVALID");
  });
  it("cleanup sends only the original opaque handle and presentation namespace", async () => {
    fetch.mockResolvedValueOnce(response({ status: "closed" }));
    await createThreadAppApi(scope).close(handle, signal());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      projectId: "project",
      pluginWorkspace: scope.pluginWorkspace,
      instanceToken: handle.instanceToken,
    });
  });
});

describe("owned file API", () => {
  beforeEach(() => fetch.mockReset());
  it("discovers a saved resource without activating it", async () => {
    fetch.mockResolvedValueOnce(
      response({ entries: [{ toolName: "viewer", title: "Viewer" }] }),
    );
    const entries = await createThreadAppApi(scope).discoverFile(
      "saved",
      "resource://file",
      signal(),
    );
    expect(entries).toEqual([
      {
        kind: "file",
        toolName: "viewer",
        title: "Viewer",
        resourceUri: "resource://file",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("files/discover");
  });
  it("keeps the same file activation request ID across transport retry", async () => {
    fetch.mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(
      response({
        ...handle,
        file: { name: "a.cad", resourceUri: "host-resource://opaque" },
      }),
    );
    await createThreadAppApi(scope).open(
      "saved",
      "viewer",
      signal(),
      "file",
      undefined,
      "resource://file",
    );
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      kind: "file",
      resourceUri: "resource://file",
      requestId: expect.any(String),
    });
  });
  it("does not expose file read on an ordinary App", async () => {
    await expect(
      createThreadAppApi(scope).readFile(handle, {}, signal()),
    ).rejects.toThrow("INSTANCE_RESOURCE_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("reads only exact opaque subscription notifications and stops on owner close", async () => {
  fetch.mockReset();
  const controller = new AbortController();
  const watched = {
    ...handle,
    file: { name: "a.cad", resourceUri: "host-resource://a" },
    fileCapabilities: { write: false as const, subscribe: true },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({ uri: watched.file.resourceUri }) + "\n",
  );
  fetch.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(bytes.slice(0, 8));
          stream.enqueue(bytes.slice(8));
          stream.close();
        },
      }),
    ),
  );
  const updated = vi.fn(() => controller.abort());
  await expect(
    createThreadAppApi(scope).watchFile(watched, updated, controller.signal),
  ).rejects.toThrow();
  expect(updated).toHaveBeenCalledExactlyOnceWith("host-resource://a");
  expect(fetch).toHaveBeenCalledOnce();
});
