import { afterEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: ports.query }),
}));
import { pluginInstances } from "../instances";
import { pluginFormSources } from "../form-sources";
import { readPluginFormResourcePreview } from "../form-resource-preview";

const target = {
  type: "resource_link" as const,
  uri: "fixture://preview",
  name: "Preview",
};
const schema = {
  type: "object",
  properties: {
    file: {
      type: "string",
      format: "uri",
      "x-openai-input": {
        type: "resource",
        options: [
          {
            uri: "fixture://one",
            name: "One",
            _meta: { "openai/preview": { target } },
          },
        ],
      },
    },
  },
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function fixture(
  kind: "legacy" | "mrtr" = "legacy",
  override: { requestedSchema?: unknown; fileResources?: boolean } = {},
) {
  const actor = {
    actorId: "actor",
    projectId: "project",
    workspaceId: crypto.randomUUID(),
    subject: "credential",
  };
  const port = {
    readActivation: async () => null,
    issueActivation: async (token: string, input: any) => ({
      token,
      control: { snapshotJson: input.snapshotJson, expiresAt: input.expiresAt },
    }),
    close: async () => {},
  } as any;
  const instance = await pluginInstances.openActivationPersistent(
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
        toolName: "source-tool",
        revision: "tool-rev",
      },
    },
    AbortSignal.timeout(1000),
    port,
  );
  const parent =
    kind === "legacy"
      ? { kind: "legacy" as const, id: crypto.randomUUID(), round: 0 as const }
      : {
          kind: "mrtr" as const,
          id: crypto.randomUUID(),
          round: 1,
          inputRequestKey: "key",
        };
  const expiresAt = Date.now() + 10000;
  const source = pluginFormSources.bind({
    owner: instance.instance.owner,
    hostId: "host",
    hostRevision: "host-rev",
    invocationId: "original",
    origin: "app",
    revision: "tool-rev",
    toolName: "source-tool",
    parent,
    requestedSchema: schema,
    expiresAt,
    ...override,
  });
  cleanups.push(
    () =>
      pluginInstances.closePersistent(
        instance.token,
        actor,
        AbortSignal.timeout(1000),
        port,
      ),
    source.release,
  );
  ports.query
    .mockReset()
    .mockResolvedValue({ actorId: actor.actorId, expiresAt });
  const readResource = vi.fn().mockResolvedValue({
    contents: [
      { uri: target.uri, mimeType: "text/plain", text: "Synthetic π" },
    ],
  });
  const resolve = vi.fn().mockResolvedValue({
    revision: "tool-rev",
    hostRevision: "host-rev",
    bindingId: "binding",
    manager: { readResource },
  });
  const release = vi.fn();
  const abort = new AbortController();
  const options = {
    actor,
    bearer: "private",
    sourceToken: source.token,
    parent,
    target,
    signal: abort.signal,
    runtime: () => ({ resolve, release } as any),
  };
  return {
    options,
    readResource,
    resolve,
    release,
    actor,
    instance,
    source,
    abort,
    expiresAt,
  };
}
describe("owned form resource preview authority and delivery", () => {
  it.each(["legacy", "mrtr"] as const)(
    "reads and releases the declared %s preview with four pending fences",
    async (kind) => {
      const f = await fixture(kind);
      expect(await readPluginFormResourcePreview(f.options)).toEqual({
        type: "resource",
        contents: [
          { uri: target.uri, mimeType: "text/plain", text: "Synthetic π" },
        ],
      });
      expect(f.readResource).toHaveBeenCalledTimes(1);
      expect(f.resolve).toHaveBeenCalledTimes(2);
      expect(ports.query).toHaveBeenCalledTimes(4);
      expect(f.release).toHaveBeenCalledOnce();
      expect(ports.query.mock.calls[0][1]).toMatchObject({
        kind,
        id: f.options.parent.id,
        sourceToken: f.source.token,
        serverId: "server",
      });
    },
  );
  it("opens a preview in a form that also takes user uploads", async () => {
    // Implicit selection always allows uploads; the preview declaration
    // check must not refuse the form for an upload service it doesn't use.
    const f = await fixture("legacy", {
      fileResources: true,
      requestedSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          extra: {
            type: "array",
            items: { type: "string", format: "uri" },
            "x-openai-input": {
              type: "resource",
              selection: "implicit",
              options: [],
            },
          },
        },
      },
    });
    await expect(readPluginFormResourcePreview(f.options)).resolves.toMatchObject(
      { type: "resource" },
    );
    expect(f.readResource).toHaveBeenCalledTimes(1);
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"] as const)(
    "refuses another %s before read",
    async (key) => {
      const f = await fixture();
      await expect(
        readPluginFormResourcePreview({
          ...f.options,
          actor: { ...f.actor, [key]: "foreign" },
        }),
      ).rejects.toThrow();
      expect(f.readResource).not.toHaveBeenCalled();
    },
  );
  it("refuses a forged URI, undeclared metadata and App execution before read", async () => {
    const f = await fixture();
    for (const value of [
      { ...target, uri: "https://external.invalid" },
      { ...target, name: "Forged" },
      { type: "mcp_app_tool" as const, name: "write" },
    ])
      await expect(
        readPluginFormResourcePreview({ ...f.options, target: value }),
      ).rejects.toThrow();
    expect(f.readResource).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { actorId: "foreign", expiresAt: Date.now() + 999999 },
    { actorId: "actor", expiresAt: 0 },
  ])("refuses an absent or replaced durable window", async (reply) => {
    const f = await fixture();
    ports.query.mockResolvedValue(reply);
    await expect(readPluginFormResourcePreview(f.options)).rejects.toThrow();
    expect(f.readResource).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("fences a durable answer during the saved-host await", async () => {
    const f = await fixture();
    ports.query
      .mockResolvedValueOnce({ actorId: "actor", expiresAt: f.expiresAt })
      .mockResolvedValue(null);
    await expect(readPluginFormResourcePreview(f.options)).rejects.toThrow();
    expect(f.readResource).not.toHaveBeenCalled();
  });
  it("fences a durable answer during resources/read before any bytes escape", async () => {
    const f = await fixture();
    f.readResource.mockImplementation(async () => {
      ports.query.mockResolvedValue(null);
      return { contents: [{ uri: target.uri, text: "Private" }] };
    });
    await expect(readPluginFormResourcePreview(f.options)).rejects.toThrow();
    expect(f.readResource).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["revision", "hostRevision", "bindingId"] as const)(
    "refuses changed %s after read",
    async (key) => {
      const f = await fixture();
      f.resolve
        .mockResolvedValueOnce({
          revision: "tool-rev",
          hostRevision: "host-rev",
          bindingId: "binding",
          manager: { readResource: f.readResource },
        })
        .mockResolvedValue({
          revision: "tool-rev",
          hostRevision: "host-rev",
          bindingId: "binding",
          [key]: "changed",
        });
      await expect(readPluginFormResourcePreview(f.options)).rejects.toThrow();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it.each(["source", "owner", "request"])(
    "aborts stalled reads on %s close and observes late rejection",
    async (kind) => {
      const f = await fixture();
      let reject!: (value: unknown) => void;
      f.readResource.mockImplementation(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      );
      const reading = readPluginFormResourcePreview(f.options);
      const assertion = expect(reading).rejects.toBeDefined();
      await vi.waitFor(() => expect(f.readResource).toHaveBeenCalledOnce());
      if (kind === "source") f.source.release();
      else if (kind === "owner")
        await pluginInstances.closePersistent(
          f.instance.token,
          f.actor,
          AbortSignal.timeout(1000),
          { close: async () => {} } as any,
        );
      else f.abort.abort();
      await assertion;
      reject(new Error("Late synthetic read"));
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it.each([
    {
      contents: [{ uri: target.uri, mimeType: "text/html", text: "<script/>" }],
    },
    { contents: [{ uri: "fixture://other", text: "Private" }] },
    {
      contents: [
        { uri: target.uri, mimeType: "image/svg+xml", text: "<svg/>" },
      ],
    },
    {
      contents: [
        { uri: target.uri, blob: "YWJj", mimeType: "application/octet-stream" },
      ],
    },
    { contents: [{ uri: target.uri, text: "π".repeat(131072) }] },
    { contents: [] },
  ])(
    "refuses unsupported or over-budget content without URL fallback",
    async ({ contents }) => {
      const f = await fixture();
      f.readResource.mockResolvedValue({ contents });
      await expect(readPluginFormResourcePreview(f.options)).rejects.toThrow();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
});
