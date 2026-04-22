import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  emitConstructorRpcLogMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  emitConstructorRpcLogMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation((_servers, options) => {
      emitConstructorRpcLogMock(options?.rpcLogger);
      return {
        disconnectAllServers: disconnectAllServersMock,
      };
    }),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: prepareChatV2Mock,
}));

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
}));

vi.mock("../../../utils/chat-ingestion.js", () => ({
  persistChatSessionToConvex: persistChatSessionToConvexMock,
  pickEnrichmentHeaders: vi.fn(() => ({})),
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

vi.mock("@/shared/types", async () => {
  const actual = await vi.importActual<typeof import("@/shared/types")>(
    "@/shared/types"
  );
  return {
    ...actual,
    isMCPJamProvidedModel: vi.fn().mockReturnValue(true),
  };
});

import { createWebTestApp, postJson } from "./helpers/test-app.js";

describe("web routes — chat-v2 hosted mode", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";

    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    emitConstructorRpcLogMock.mockReset();

    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      await options.onConversationComplete?.(
        [{ role: "user", content: "preview request" }],
        {
          turnId: "trace_turn_test",
          promptIndex: 0,
          startedAt: 1,
          endedAt: 2,
          spans: [],
          modelId: "test-model",
        }
      );
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    global.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const serverIds = Array.isArray(payload?.serverIds)
          ? payload.serverIds
          : [];
        return new Response(
          JSON.stringify({
            results: Object.fromEntries(
              serverIds.map((serverId: string) => [
                serverId,
                {
                  ok: true,
                  role: "member",
                  accessLevel: "shared_chat",
                  permissions: { chatOnly: false },
                  serverConfig: {
                    transportType: "http",
                    url: `https://${serverId}.example.com/mcp`,
                    headers: {},
                    useOAuth: false,
                  },
                },
              ])
            ),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("persists chatbox preview chats with internal surface", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1"],
        chatboxToken: "chatbox-token",
        surface: "preview",
        chatSessionId: "chat-session-1",
        messages: [{ role: "user", content: "preview request" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: ["server-1"],
      })
    );
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "chat-session-1",
        workspaceId: "workspace-1",
        sourceType: "chatbox",
        chatboxToken: "chatbox-token",
        surface: "preview",
        modelId: "openai/gpt-5-mini",
        modelSource: "mcpjam",
      })
    );
  });

  it("passes shared chatbox link context into the hosted model handler", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1"],
        chatboxToken: "chatbox-shared-token",
        surface: "share_link",
        chatSessionId: "chat-session-shared",
        messages: [{ role: "user", content: "hello from guest" }],
        model: {
          id: "anthropic/claude-opus-4.6",
          provider: "anthropic",
          name: "Claude Opus 4.6",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatboxToken: "chatbox-shared-token",
        workspaceId: "workspace-1",
      })
    );
  });

  it("uses one authorize-batch request for multi-server hosted chat", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1", "server-2", "server-1"],
        chatSessionId: "chat-session-batch",
        messages: [{ role: "user", content: "hello" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.convex.site/web/authorize-batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          serverIds: ["server-1", "server-2"],
          accessScope: "chat_v2",
        }),
      })
    );
  });

  it("forwards directVisibility for hosted direct chats", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1"],
        chatSessionId: "chat-session-direct",
        directVisibility: "workspace",
        messages: [{ role: "user", content: "hello" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "chat-session-direct",
        workspaceId: "workspace-1",
        sourceType: "direct",
        directVisibility: "workspace",
      })
    );
  });

  it("includes pre-stream rpc logs in hosted chat JSON errors", async () => {
    const { app, token } = createWebTestApp();

    emitConstructorRpcLogMock.mockImplementation((rpcLogger) => {
      rpcLogger?.({
        direction: "send",
        serverId: "server-1",
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        },
      });
    });
    prepareChatV2Mock.mockRejectedValueOnce(new Error("chat setup failed"));

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Notion"],
        messages: [{ role: "user", content: "hello" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: "chat setup failed",
        _rpcLogs: [
          expect.objectContaining({
            serverId: "server-1",
            serverName: "Notion",
            direction: "send",
          }),
        ],
      })
    );
  });
});
