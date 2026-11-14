import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  modelHas: vi.fn(() => false),
  modelGet: vi.fn(),
  modelPrepare: vi.fn(),
  get: vi.fn(),
  prepare: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../model-apps.js", () => ({
  modelApps: {
    get: calls.modelGet,
    restore: async () => calls.modelGet(),
    prepareMessage: calls.modelPrepare,
  },
  // The durable control decides the registry; here, `modelHas` stands in.
  readOwnedApp: async (...args: unknown[]) =>
    calls.modelHas()
      ? { kind: "model", app: calls.modelGet() }
      : { kind: "instance", instance: await calls.get(...args) },
}));
vi.mock("../instances.js", () => ({
  pluginInstances: { getPersistent: calls.get, prepareMessage: calls.prepare },
}));
vi.mock("../request-runtime.js", () => ({
  createPluginRequestRuntime: () => ({
    resolve: calls.resolve,
    release: calls.release,
  }),
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "subject",
}));
import { preparePluginMessageTurn } from "../message.js";
const params = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "run" }],
};
const fixture = () =>
  ({
    c: {
      req: {
        raw: { signal: new AbortController().signal },
        header: () => "Bearer value",
      },
    },
    intent: {
      instanceToken: "a".repeat(43),
      operationId: crypto.randomUUID(),
      sourceThreadId: "chat",
      params,
    },
    messages: [
      { id: "message", role: "user", parts: [{ type: "text", text: "run" }] },
    ],
    hostId: "host",
    serverIds: ["server"],
    threadId: "chat",
    admission: {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      revalidate: calls.revalidate,
    },
    bearer: "credential",
  } as unknown as Parameters<typeof preparePluginMessageTurn>[0]);
beforeEach(() => {
  vi.clearAllMocks();
  calls.modelHas.mockReturnValue(false);
  calls.get.mockResolvedValue({
    messageEnabled: true,
    hostId: "host",
    owner: { serverId: "server" },
    activation: {
      selector: { kind: "thread", threadId: "chat" },
      toolName: "app",
      revision: "revision",
    },
  });
  calls.resolve.mockResolvedValue({
    messageEnabled: true,
    revision: "revision",
  });
});
describe("owned App messages", () => {
  it("revalidates original source before accepting exactly encoded user parts", async () => {
    const input = fixture();
    expect(await preparePluginMessageTurn(input)).toEqual(input.messages);
    expect(calls.revalidate).toHaveBeenCalledOnce();
    expect(calls.prepare).toHaveBeenCalledOnce();
    expect(calls.release).toHaveBeenCalledOnce();
  });
  it.each(["parts", "target", "host", "source"])(
    "refuses changed %s before model send",
    async (changed) => {
      const input = fixture();
      if (changed === "parts")
        input.messages[0].parts = [{ type: "text", text: "changed" }];
      if (changed === "target") input.threadId = "elsewhere";
      if (changed === "host") input.hostId = "other";
      if (changed === "source") input.serverIds = [];
      await expect(preparePluginMessageTurn(input)).rejects.toThrow(
        "INSTANCE_MESSAGE_UNAVAILABLE",
      );
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );
  it("admits a new target before source disposal and binds it to one destination", async () => {
    const input = fixture();
    (input.intent as { params: unknown }).params = {
      ...params,
      _meta: { "openai/message": { target: "new" } },
    };
    const token = await preparePluginMessageTurn({
      ...input,
      prepareOnly: true,
    });
    calls.get.mockRejectedValue(new Error("Source closed"));
    input.intent = { ...(input.intent as object), preparationToken: token };
    input.threadId = "new";
    input.admission = { ...input.admission!, workspaceId: "new-workspace" };
    await expect(preparePluginMessageTurn(input)).resolves.toEqual(
      input.messages,
    );
    input.threadId = "different";
    await expect(preparePluginMessageTurn(input)).rejects.toThrow(
      "INSTANCE_MESSAGE_UNAVAILABLE",
    );
  });
  it("refuses unprepared cross-thread messages", async () => {
    const input = fixture();
    input.threadId = "new";
    (input.intent as { params: unknown }).params = {
      ...params,
      _meta: { "openai/message": { target: "new" } },
    };
    await expect(preparePluginMessageTurn(input)).rejects.toThrow(
      "INSTANCE_MESSAGE_UNAVAILABLE",
    );
  });
  it("refuses with the client's current messages toggle, not the one the App opened with", async () => {
    calls.resolve.mockResolvedValue({
      messageEnabled: false,
      revision: "revision",
      extensions: { capabilities: { messages: false } },
    });
    await expect(preparePluginMessageTurn(fixture())).rejects.toThrow(
      "PLUGIN_EXTENSION_DISABLED",
    );
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.release).toHaveBeenCalledOnce();
  });
  it("refuses changed tool revision and releases the request", async () => {
    calls.resolve.mockResolvedValue({
      messageEnabled: true,
      revision: "changed",
    });
    await expect(preparePluginMessageTurn(fixture())).rejects.toThrow(
      "INSTANCE_MESSAGE_UNAVAILABLE",
    );
    expect(calls.release).toHaveBeenCalledOnce();
  });
  it("refuses source closure during asynchronous preparation", async () => {
    const input = fixture();
    (input.intent as { params: unknown }).params = {
      ...params,
      _meta: { "openai/message": { target: "new" } },
    };
    calls.get
      .mockResolvedValueOnce({
        messageEnabled: true,
        hostId: "host",
        owner: { serverId: "server" },
        activation: {
          selector: { kind: "thread", threadId: "chat" },
          toolName: "app",
          revision: "revision",
        },
      })
      .mockRejectedValueOnce(new Error("Source closed"));
    await expect(
      preparePluginMessageTurn({ ...input, prepareOnly: true }),
    ).rejects.toThrow("Source closed");
    expect(calls.release).toHaveBeenCalledOnce();
  });
});

it("admits an original model App message without minting a generic instance", async () => {
  const input = fixture();
  calls.modelHas.mockReturnValue(true);
  calls.modelGet.mockReturnValue({
    owner: { hostId: "h", owner: { serverId: "saved" } },
    toolName: "app",
    revision: "r",
  });
  // Use the same exact saved identity as the ordinary message fixture.
  const ordinary = await calls.get();
  const app = {
    owner: { hostId: ordinary.hostId, owner: ordinary.owner },
    toolName: ordinary.activation.toolName,
    revision: ordinary.activation.revision,
  };
  calls.modelGet.mockReturnValue(app);
  calls.get.mockClear();
  expect(await preparePluginMessageTurn(input)).toEqual(input.messages);
  expect(calls.get).not.toHaveBeenCalled();
  expect(calls.prepare).not.toHaveBeenCalled();
  // The binding goes to the App's durable receipts, not this process.
  expect(calls.modelPrepare).toHaveBeenCalledWith(
    app,
    expect.objectContaining({ actorId: "actor", subject: "subject" }),
    input.intent && (input.intent as { operationId: string }).operationId,
    expect.stringMatching(/^[0-9a-f]{64}$/),
    expect.any(AbortSignal),
  );
});
