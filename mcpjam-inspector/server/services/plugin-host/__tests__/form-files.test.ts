import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: ports.query }),
}));
import { pluginInstances } from "../instances";
import { pluginFormSources } from "../form-sources";
import { describePluginFormFiles, uploadPluginFormFiles } from "../form-files";
import { pluginFormFileGrants } from "../form-file-grants";
const cleanups: (() => unknown)[] = [];
const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../form-file-grants", async (original) => {
  const actual = await original<typeof import("../form-file-grants")>();
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  isolated.root = await mkdtemp(join(tmpdir(), "form-file-authority-test-"));
  return {
    ...actual,
    pluginFormFileGrants: new actual.PluginFormFileGrants(
      join(isolated.root, "owned"),
    ),
  };
});
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(isolated.root, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  await pluginFormFileGrants.drain();
});
async function fixture(
  target: unknown = { command: "node" },
  local = true,
  fileResources = true,
  origin: "app" | "model" = "app",
) {
  // The client's CURRENT toggles, as each request's fresh admission reads them.
  const toggles = { forms: true, fileResources: true };
  const actor = {
    actorId: "actor",
    projectId: "project",
    workspaceId: crypto.randomUUID(),
    subject: "credential",
  };
  const control = {
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
      runtime: "codex",
      hostId: "host",
      hostRevision: "host-rev",
      serverId: "server",
      bindingId: "binding",
      resourceUri: "ui://parent",
      serverIdentity: { kind: "standalone", serverId: "server" },
      activation: {
        selector: { kind: "thread", threadId: "thread" },
        toolName: "source",
        revision: "tool-rev",
      },
    },
    AbortSignal.timeout(1000),
    control,
  );
  const parent = {
    kind: "legacy" as const,
    id: crypto.randomUUID(),
    round: 0 as const,
  };
  const expiresAt = Date.now() + 10000;
  const source = pluginFormSources.bind({
    owner: instance.instance.owner,
    hostId: "host",
    hostRevision: "host-rev",
    invocationId: "operation",
    origin,
    revision: "tool-rev",
    toolName: "source",
    parent,
    requestedSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            userOptions: { kind: "file", accept: [".txt"] },
            options: [],
          },
        },
      },
    },
    expiresAt,
    fileResources,
    ...(local ? { uploadTarget: "local-stdio" as const } : {}),
  });
  cleanups.push(
    () =>
      pluginInstances.closePersistent(
        instance.token,
        actor,
        AbortSignal.timeout(1000),
        control,
      ),
    source.release,
  );
  ports.query.mockReset().mockResolvedValue({ actorId: "actor", expiresAt });
  const resolve = vi.fn().mockImplementation(async () => ({
    revision: "tool-rev",
    hostRevision: "host-rev",
    bindingId: "binding",
    manager: { getServerConfig: () => target },
    extensions: { enabled: true, capabilities: { ...toggles } },
  }));
  const release = vi.fn();
  const request = new AbortController();
  const options = {
    actor,
    bearer: "private",
    sourceToken: source.token,
    parent,
    signal: request.signal,
    runtime: () => ({ resolve, release } as any),
  };
  return {
    options,
    actor,
    resolve,
    release,
    source,
    expiresAt,
    request,
    instance,
    toggles,
  };
}
describe("connected original form target authorization", () => {
  it("admits actual local opt-in through two durable checks and releases the discovery connection", async () => {
    const f = await fixture();
    expect(await describePluginFormFiles(f.options)).toEqual({
      userResources: true,
      userResourceKinds: ["file", "directory"],
      origin: "mcp-app",
      fileResources: true,
    });
    expect(ports.query).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([{ url: "https://remote.invalid/mcp" }, {}, { command: "" }])(
    "withholds target %j",
    async (target) => {
      const f = await fixture(target);
      expect(await describePluginFormFiles(f.options)).toEqual({
        userResources: false,
        userResourceKinds: [],
        origin: "mcp-app",
        fileResources: true,
      });
      await expect(
        uploadPluginFormFiles({
          ...f.options,
          field: "file",
          operationId: crypto.randomUUID(),
          files: [
            { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
          ],
        }),
      ).rejects.toThrow();
    },
  );
  it("does not infer filesystem placement from stdio without the original saved opt-in", async () => {
    const f = await fixture({ command: "node" }, false);
    expect((await describePluginFormFiles(f.options)).userResources).toBe(
      false,
    );
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"] as const)(
    "refuses another %s before resolving",
    async (key) => {
      const f = await fixture();
      await expect(
        describePluginFormFiles({
          ...f.options,
          actor: { ...f.actor, [key]: "foreign" },
        }),
      ).rejects.toThrow();
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it.each(["revision", "hostRevision", "bindingId"])(
    "refuses changed %s and releases",
    async (key) => {
      const f = await fixture();
      f.resolve.mockResolvedValue({
        revision: "tool-rev",
        hostRevision: "host-rev",
        bindingId: "binding",
        [key]: "changed",
      });
      await expect(describePluginFormFiles(f.options)).rejects.toThrow();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it("refuses an answered/replaced durable window after tool resolution", async () => {
    const f = await fixture();
    ports.query
      .mockResolvedValueOnce({ actorId: "actor", expiresAt: f.expiresAt })
      .mockResolvedValue(null);
    await expect(describePluginFormFiles(f.options)).rejects.toThrow();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("places file bytes only for the declared field under four pending checks", async () => {
    const f = await fixture();
    const uploaded = await uploadPluginFormFiles({
      ...f.options,
      field: "file",
      operationId: crypto.randomUUID(),
      files: [
        { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
      ],
    });
    expect(uploaded.uris).toHaveLength(1);
    expect(ports.query).toHaveBeenCalledTimes(4);
    expect(f.release).toHaveBeenCalledOnce();
    await expect(
      uploadPluginFormFiles({
        ...f.options,
        field: "foreign",
        operationId: crypto.randomUUID(),
        files: [
          { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
        ],
      }),
    ).rejects.toThrow();
  });
  it("tells the client an App form was elicited while File resources was off", async () => {
    const f = await fixture(undefined, true, false);
    // The client applies the same rule and shows the form Unsupported.
    expect(await describePluginFormFiles(f.options)).toMatchObject({
      origin: "mcp-app",
      fileResources: false,
    });
  });
  it("refuses uploads into an App form elicited while File resources was off", async () => {
    const f = await fixture(undefined, true, false);
    await expect(
      uploadPluginFormFiles({
        ...f.options,
        field: "file",
        operationId: crypto.randomUUID(),
        files: [
          { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
        ],
      }),
    ).rejects.toThrow();
  });
  it("checks accept constraints and single-file multiplicity before placement", async () => {
    const f = await fixture();
    for (const files of [
      [{ name: "bad.bin", type: "text/plain", bytes: Buffer.from("bad") }],
      [
        { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
        { name: "two.txt", type: "text/plain", bytes: Buffer.from("two") },
      ],
    ])
      await expect(
        uploadPluginFormFiles({
          ...f.options,
          field: "file",
          operationId: crypto.randomUUID(),
          files,
        }),
      ).rejects.toThrow();
  });
});

describe("uploads and the client's current toggles", () => {
  const upload = (f: Awaited<ReturnType<typeof fixture>>) =>
    uploadPluginFormFiles({
      ...f.options,
      field: "file",
      operationId: crypto.randomUUID(),
      files: [
        { name: "one.txt", type: "text/plain", bytes: Buffer.from("one") },
      ],
    });
  it("refuses a new upload once Forms is off after the form opened, saying why", async () => {
    const f = await fixture();
    f.toggles.forms = false;
    await expect(upload(f)).rejects.toMatchObject({
      code: "PLUGIN_FORMS_DISABLED",
      diagnostics: [
        expect.objectContaining({
          code: "PLUGIN_FORMS_DISABLED",
          serverId: "server",
          description: expect.stringContaining("Forms turned off"),
        }),
      ],
    });
    expect(f.release).toHaveBeenCalledOnce();
    // Turned on again before the user picks a file: the upload proceeds.
    f.toggles.forms = true;
    expect((await upload(f)).uris).toHaveLength(1);
  });
  it("refuses a new upload into an App's form once File resources is off", async () => {
    const f = await fixture();
    f.toggles.fileResources = false;
    await expect(upload(f)).rejects.toMatchObject({
      code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
      diagnostics: [
        expect.objectContaining({
          code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
        }),
      ],
    });
    f.toggles.fileResources = true;
    expect((await upload(f)).uris).toHaveLength(1);
  });
  it("keeps taking uploads into a server's own form with File resources off", async () => {
    const f = await fixture(undefined, true, false, "model");
    f.toggles.fileResources = false;
    expect((await upload(f)).uris).toHaveLength(1);
  });
});
