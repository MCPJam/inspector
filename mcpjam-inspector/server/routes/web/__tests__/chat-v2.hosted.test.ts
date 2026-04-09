import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@mcpjam/sdk", () => ({
  isMCPAuthError: vi.fn().mockReturnValue(false),
  MCPClientManager: vi.fn().mockImplementation(() => ({
    disconnectAllServers: disconnectAllServersMock,
  })),
}));

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: prepareChatV2Mock,
}));

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
}));

vi.mock("../../../utils/chat-ingestion.js", () => ({
  persistChatSessionToConvex: persistChatSessionToConvexMock,
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
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

    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      await options.onConversationComplete?.([
        { role: "user", content: "preview request" },
      ]);
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    global.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/web/authorize")) {
        return new Response(
          JSON.stringify({
            authorized: true,
            role: "member",
            accessLevel: "shared_chat",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://server.example.com/mcp",
              headers: {},
              useOAuth: false,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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

  it("persists sandbox preview chats with internal surface", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        workspaceId: "workspace-1",
        selectedServerIds: ["server-1"],
        sandboxToken: "sandbox-token",
        surface: "preview",
        chatSessionId: "chat-session-1",
        messages: [{ role: "user", content: "preview request" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: ["server-1"],
        includeMcpToolInventory: true,
      }),
    );
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "chat-session-1",
        workspaceId: "workspace-1",
        sourceType: "sandbox",
        sandboxToken: "sandbox-token",
        surface: "preview",
        modelId: "openai/gpt-5-mini",
        modelSource: "mcpjam",
      }),
    );
  });
});
