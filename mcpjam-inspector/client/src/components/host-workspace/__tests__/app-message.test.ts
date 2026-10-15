import { beforeEach, describe, expect, it, vi } from "vitest";
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch }));
import { prepareNewAppMessage, withAppMessages } from "../app-message";
const intent = {
  instanceToken: "x".repeat(43),
  operationId: "b69e6585-8607-40e8-84ee-4bb1f3e4b31",
  sourceThreadId: "thread",
  params: {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: "prompt",
        _meta: { "openai/title": "Title" },
      },
    ],
    _meta: { "openai/message": { target: "new" as const } },
  },
};
beforeEach(() => authFetch.mockReset());
describe("App message host adapter", () => {
  it("preserves prompt title and target through the normal chat port", async () => {
    const send = vi.fn(async (_intent: unknown, _live: () => boolean) => true);
    const policy = {
      resolvers: {
        resolveEffectiveHostCapabilities: () => ({ message: {} }),
        resolveEffectiveMcpAppsCapabilities: () => ({ message: true }),
      },
    };
    const host = withAppMessages(
      policy as never,
      policy as never,
      { instanceToken: intent.instanceToken, messageEnabled: true } as never,
      { threadId: "thread", isLive: () => true, send },
    );
    await host.services.sendMessage!(intent.params as never);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      sourceThreadId: "thread",
      params: intent.params,
    });
  });
  it("does not publish a receipt if the source closes during admission", async () => {
    let live = true;
    authFetch.mockImplementation(async () => {
      live = false;
      return new Response(JSON.stringify({ preparationToken: "p".repeat(43) }));
    });
    const result = await prepareNewAppMessage(
      {
        projectId: "project",
        hostId: "host",
        threadId: "thread",
        pluginWorkspace: { workspaceId: "workspace" },
      } as never,
      "server",
      intent,
      () => live,
    );
    expect(result).toBeNull();
    expect(authFetch.mock.calls[0][0]).toBe(
      "/api/web/apps/plugin-instances/message/prepare",
    );
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toMatchObject({
      serverId: "server",
      intent,
    });
  });
});

it("passes a draft to the owned host port and describes one that is not placed", async () => {
  const { useTrafficLogStore } = await import("@/stores/traffic-log-store");
  useTrafficLogStore.getState().clear();
  const send = vi.fn(async (_intent: unknown, _live: () => boolean) => true);
  const policy = {
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({ message: {} }),
      resolveEffectiveMcpAppsCapabilities: () => ({ message: true }),
    },
  };
  const host = withAppMessages(
    policy as never,
    policy as never,
    { instanceToken: intent.instanceToken, messageEnabled: true } as never,
    { threadId: "thread", isLive: () => true, send },
  );
  const draft = {
    ...intent.params,
    _meta: { "openai/message": { target: "active", send: false } },
  };
  await expect(host.services.sendMessage!(draft as never)).resolves.toEqual({});
  expect(send.mock.calls[0]?.[0]).toMatchObject({ params: draft });
  send.mockResolvedValueOnce(false);
  await expect(host.services.sendMessage!(draft as never)).rejects.toThrow(
    "The draft could not be added to the composer",
  );
  expect(
    useTrafficLogStore
      .getState()
      .mcpServerItems.some(
        (item) => item.method === "plugin-extensions/app-draft-refused",
      ),
  ).toBe(true);
});

it("binds a global App's message to the chat that is current when it is sent", async () => {
  const send = vi.fn(async (_intent: unknown, _live: () => boolean) => true);
  const policy = {
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({ message: {} }),
      resolveEffectiveMcpAppsCapabilities: () => ({ message: true }),
    },
  };
  let current = "chat-a";
  const host = withAppMessages(
    policy as never,
    policy as never,
    { instanceToken: intent.instanceToken, messageEnabled: true } as never,
    { threadId: () => current, isLive: () => true, send },
  );
  current = "chat-b";
  await host.services.sendMessage!(intent.params as never);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ sourceThreadId: "chat-b" });
});
