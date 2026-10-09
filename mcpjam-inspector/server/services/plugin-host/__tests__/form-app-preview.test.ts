import { afterEach, describe, expect, it, vi } from "vitest";
const queries = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: queries.query }),
}));
import { pluginInstances } from "../instances";
import { pluginFormSources } from "../form-sources";
import {
  openPluginFormAppPreview,
  getPluginFormApp,
} from "../form-app-preview";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
});
async function fixture(
  target: {
    type: "mcp_app_tool";
    name: string;
    arguments?: Record<string, unknown>;
  } = {
    type: "mcp_app_tool",
    name: "preview",
    arguments: { part: "bolt" },
  },
) {
  const actor = {
    actorId: "actor",
    projectId: "project",
    workspaceId: crypto.randomUUID(),
    subject: "subject",
  };
  const port = {
    readActivation: async () => null,
    issueActivation: async (token: string, input: any) => ({
      token,
      control: { snapshotJson: input.snapshotJson, expiresAt: input.expiresAt },
    }),
  } as any;
  const opened = await pluginInstances.openActivationPersistent(
    actor,
    {
      runtime: "chatgpt",
      hostId: "host",
      hostRevision: "host-rev",
      serverId: "server",
      bindingId: "binding",
      resourceUri: "ui://parent",
      serverIdentity: { kind: "standalone", serverId: "server" },
      activation: {
        selector: { kind: "thread", threadId: "thread" },
        toolName: "source",
        revision: "source-rev",
      },
    },
    AbortSignal.timeout(1000),
    port,
  );
  const parent = {
    kind: "legacy" as const,
    id: crypto.randomUUID(),
    round: 0 as const,
  };
  const expiresAt = Date.now() + 60000;
  const source = pluginFormSources.bind({
    owner: opened.instance.owner,
    hostId: "host",
    hostRevision: "host-rev",
    invocationId: "original",
    origin: "entrypoint",
    revision: "source-rev",
    toolName: "source",
    parent,
    expiresAt,
    requestedSchema: {
      type: "object",
      properties: {
        part: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [
              {
                uri: "fixture://part",
                name: "Part",
                _meta: { "openai/preview": { target } },
              },
            ],
          },
        },
      },
    },
  });
  cleanup.push(source.release);
  queries.query
    .mockReset()
    .mockResolvedValue({ actorId: actor.actorId, expiresAt });
  const readResource = vi.fn(async () => ({
    contents: [
      { uri: "ui://preview", mimeType: "text/html", text: "<p>Disposable</p>" },
    ],
  }));
  const manager = {
    readResource,
    listResources: vi.fn(async () => ({ resources: [] })),
    getServerConfig: () => ({ url: "https://fixture.invalid/mcp" }),
  };
  const resolve = vi.fn(async (name: string) => ({
    tool: {
      name,
      inputSchema: { type: "object", properties: { part: { type: "string" } } },
      _meta: { ui: { resourceUri: "ui://preview", visibility: ["app"] } },
    },
    revision: `${name}-rev`,
    hostRevision: "host-rev",
    bindingId: "binding",
    manager,
    appToolsEnabled: true,
  }));
  const runtime = {
    resolve,
    resolveTools: async (names: string[]) =>
      new Map(
        await Promise.all(
          names.map(async (name) => [name, await resolve(name)] as const),
        ),
      ),
    release: vi.fn(async () => {}),
  } as any;
  const options = {
    actor,
    bearer: "private",
    sourceToken: source.token,
    parent,
    target,
    signal: AbortSignal.timeout(10000),
    runtime: () => runtime,
  };
  return { options, source, readResource, runtime };
}
describe("source-owned App previews", () => {
  it("retains one logical child and initial operation across reopen without calling a tool", async () => {
    const f = await fixture();
    const a = await openPluginFormAppPreview(f.options),
      b = await openPluginFormAppPreview(f.options);
    expect(a.instanceToken).toBe(b.instanceToken);
    expect(a.operationId).toBe(b.operationId);
    expect(a.widgetContent.html).toBe("<p>Disposable</p>");
    expect(f.runtime.release).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["a 1.1 MB UI", 1_150_000, true],
    ["a UI over 5 MB", 5 * 1024 * 1024 + 1, false],
  ])(
    "previews %s only within the App UI bound",
    async (_label, bytes, opens) => {
      const f = await fixture();
      const html = "<p>" + "x".repeat(bytes - 7) + "</p>";
      f.readResource.mockResolvedValue({
        contents: [{ uri: "ui://preview", mimeType: "text/html", text: html }],
      });
      const preview = openPluginFormAppPreview(f.options);
      if (opens) {
        expect((await preview).widgetContent.html.length).toBe(bytes);
      } else {
        await expect(preview).rejects.toBeTruthy();
      }
    },
  );
  it("opens on the server that asked for the form, with arguments defaulting to {}", async () => {
    const f = await fixture({ type: "mcp_app_tool", name: "preview" });
    const opened = await openPluginFormAppPreview(f.options);
    expect(opened).toMatchObject({
      serverId: "server",
      toolName: "preview",
      resourceUri: "ui://preview",
    });
    // The App's own resource comes from the originating server only.
    expect(f.readResource).toHaveBeenCalledWith(
      "server",
      { uri: "ui://preview" },
      expect.anything(),
    );
    const child = getPluginFormApp({ ...f.options, token: opened.instanceToken });
    expect(child.target).toEqual({ type: "mcp_app_tool", name: "preview" });
    expect(child.service.source.owner.serverId).toBe("server");
  });
  it("refuses undeclared targets and foreign actors before resource reads", async () => {
    const f = await fixture();
    await expect(
      openPluginFormAppPreview({
        ...f.options,
        target: { ...f.options.target, name: "undeclared" },
      }),
    ).rejects.toThrow();
    await expect(
      openPluginFormAppPreview({
        ...f.options,
        actor: { ...f.options.actor, actorId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(f.readResource).not.toHaveBeenCalled();
  });
  it("revokes children with the original source", async () => {
    const f = await fixture();
    const a = await openPluginFormAppPreview(f.options);
    f.source.release();
    expect(() =>
      getPluginFormApp({ ...f.options, token: a.instanceToken }),
    ).toThrow("FORM_PREVIEW_UNAVAILABLE");
  });
  it("rejects a changed pending window before any resource read", async () => {
    const f = await fixture();
    queries.query.mockResolvedValue(null);
    await expect(openPluginFormAppPreview(f.options)).rejects.toThrow();
    expect(f.readResource).not.toHaveBeenCalled();
  });
});
