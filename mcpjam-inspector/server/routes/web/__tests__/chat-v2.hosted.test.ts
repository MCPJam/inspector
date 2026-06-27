import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  managerListToolsMock,
  managerReadResourceMock,
  emitConstructorRpcLogMock,
  validateAppToolEntriesMock,
  AppToolValidationErrorMock,
  validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPromptMock,
  WidgetModelContextValidationErrorMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  managerListToolsMock: vi.fn(),
  managerReadResourceMock: vi.fn(),
  emitConstructorRpcLogMock: vi.fn(),
  validateAppToolEntriesMock: vi.fn(() => []),
  AppToolValidationErrorMock: class AppToolValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AppToolValidationError";
    }
  },
  validateWidgetModelContextEntriesMock: vi.fn(() => []),
  buildWidgetModelContextSystemPromptMock: vi.fn(() => ""),
  WidgetModelContextValidationErrorMock: class WidgetModelContextValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "WidgetModelContextValidationError";
    }
  },
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
        listTools: managerListToolsMock,
        readResource: managerReadResourceMock,
      };
    }),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: prepareChatV2Mock,
  validateAppToolEntries: validateAppToolEntriesMock,
  AppToolValidationError: AppToolValidationErrorMock,
  validateWidgetModelContextEntries: validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPrompt: buildWidgetModelContextSystemPromptMock,
  WidgetModelContextValidationError: WidgetModelContextValidationErrorMock,
}));

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
  // No-op dev-only diagnostic; tests don't need real signal-missing
  // logging behavior but must surface the symbol so the route module
  // can import it without ReferenceError.
  warnIfChatAbortSignalMissing: () => {},
}));

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: persistChatSessionToConvexMock,
    pickEnrichmentHeaders: vi.fn(() => ({})),
  };
});

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: fetchHostRuntimeConfigMock,
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
import { MCPClientManager } from "@mcpjam/sdk";

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
    managerListToolsMock.mockResolvedValue({ tools: [] });
    managerReadResourceMock.mockResolvedValue({ contents: [] });
    emitConstructorRpcLogMock.mockReset();
    // Default: host runtime-config resolves to a non-harness config so the
    // host-bound (Playground) path routes straight through to the handler.
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { selectedServerIds: ["server-1"] },
    });

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
                  internalLogContext: {
                    authType: "signedIn",
                    userId: "u-alice",
                    projectId: payload.projectId ?? null,
                  },
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
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatboxId: "cbx_1",
        accessVersion: 1,
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
        projectId: "project-1",
        sourceType: "chatbox",
        chatboxId: "cbx_1",
        accessVersion: 1,
        surface: "preview",
        modelId: "openai/gpt-5-mini",
        modelSource: "mcpjam",
      })
    );
    // Non-direct flows must NOT send hostConfig — backend skips with
    // missing_field, which is the desired behavior for chatbox/serverShare.
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(persistArgs.hostConfig).toBeUndefined();
  });

  // PR3: host-bound direct session (Playground previewing a saved host).
  it("a direct session with hostId fetches the authoritative host runtime-config and routes through", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        hostId: "host-1",
        chatSessionId: "chat-host-1",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic", name: "Haiku" },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(fetchHostRuntimeConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-1" })
    );
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED when the host runtime-config fetch fails — never runs the engine", async () => {
    const { app, token } = createWebTestApp();
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 502,
      error: "backend unreachable",
    });

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        hostId: "host-1",
        chatSessionId: "chat-host-2",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic", name: "Haiku" },
      },
      token
    );

    expect(response.status).not.toBe(200);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("a chatbox session ignores a stray hostId (chatbox path wins)", async () => {
    const { app, token } = createWebTestApp();

    await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatboxId: "cbx_1",
        accessVersion: 1,
        hostId: "host-1",
        chatSessionId: "chat-cb-1",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      },
      token
    );

    expect(fetchHostRuntimeConfigMock).not.toHaveBeenCalled();
  });

  it("passes shared chatbox link context into the hosted model handler", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatboxId: "cbx_shared",
        accessVersion: 2,
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
        chatboxId: "cbx_shared",
        accessVersion: 2,
        projectId: "project-1",
      })
    );
  });

  it("uses one authorize-batch request for multi-server hosted chat", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
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
    // Membership chat (no share/chatbox token) sends no accessScope — the
    // backend authorizes via project ownership for both guest and authed
    // users uniformly. accessScope is only set when a token is in play.
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.convex.site/web/authorize-batch",
      expect.objectContaining({
        method: "POST",
        // `localRuntime: true` is set whenever HOSTED_MODE is false (the
        // default in tests — VITE_MCPJAM_HOSTED_MODE is not "true" here).
        // Convex uses it to skip the HTTPS-only check on MCP server URLs
        // for local Inspector callers; see normalizeAuthorizeResult in
        // mcpjam-backend/convex/http.ts.
        body: JSON.stringify({
          projectId: "project-1",
          serverIds: ["server-1", "server-2"],
          localRuntime: true,
        }),
      })
    );
  });

  it("forwards MCP profile protocol pins into the hosted chat manager", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Stateless"],
        clientInfo: { name: "mcpjam-inspector", version: "1.0.0" },
        supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
        mcpProtocolVersionsByServerId: {
          "server-1": "2026-07-28",
        },
        chatSessionId: "chat-session-stateless",
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
    expect(MCPClientManager).toHaveBeenCalledWith(
      {
        "server-1": expect.objectContaining({
          url: "https://server-1.example.com/mcp",
          clientInfo: { name: "mcpjam-inspector", version: "1.0.0" },
          supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
          mcpProtocolVersion: "2026-07-28",
        }),
      },
      expect.any(Object)
    );
  });

  it("normalizes mixed stateless host defaults with stateful per-server overrides", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-stateful", "server-stateless"],
        selectedServerNames: ["Excalidraw", "stateless"],
        clientInfo: { name: "mcpjam-inspector", version: "1.0.0" },
        supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
        mcpProtocolVersionsByServerId: {
          "server-stateful": "2025-11-25",
          "server-stateless": "2026-07-28",
        },
        chatSessionId: "chat-session-mixed",
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
    expect(MCPClientManager).toHaveBeenCalledWith(
      {
        "server-stateful": expect.objectContaining({
          url: "https://server-stateful.example.com/mcp",
          supportedProtocolVersions: ["2025-11-25"],
          mcpProtocolVersion: "2025-11-25",
        }),
        "server-stateless": expect.objectContaining({
          url: "https://server-stateless.example.com/mcp",
          supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
          mcpProtocolVersion: "2026-07-28",
        }),
      },
      expect.any(Object)
    );
  });

  it("forwards directVisibility for hosted direct chats", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Asana"],
        chatSessionId: "chat-session-direct",
        directVisibility: "project",
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
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVisibleMcpImageToolResults: true,
      })
    );
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "chat-session-direct",
        projectId: "project-1",
        sourceType: "direct",
        directVisibility: "project",
        resumeConfig: expect.objectContaining({
          selectedServers: ["Asana"],
        }),
        hostConfig: expect.objectContaining({
          // Phase 3: hostStyle defaults to 'claude' when omitted —
          // no more legacy 'direct' on the wire.
          hostStyle: "claude",
          modelId: "openai/gpt-5-mini",
          selectedServerIds: ["server-1"],
          // resolvedTemperature from prepareChatV2Mock default (0.7)
          temperature: 0.7,
        }),
      })
    );
  });

  it("honors direct chat image visibility opt-out from the request body", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Asana"],
        chatSessionId: "chat-session-direct-images-off",
        directVisibility: "project",
        modelVisibleMcpImageToolResults: false,
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
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVisibleMcpImageToolResults: false,
      })
    );
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          modelVisibleMcpImageToolResults: false,
        }),
        resumeConfig: expect.objectContaining({
          modelVisibleMcpImageToolResults: false,
        }),
      })
    );
  });

  it("does not resolve linked image resources from browser-replayed history", async () => {
    const { app, token } = createWebTestApp();
    managerListToolsMock.mockResolvedValue({
      tools: [{ name: "qa_return_linked_image_resource" }],
    });
    managerReadResourceMock.mockResolvedValue({
      contents: [
        {
          uri: "example://linked-image.png",
          blob: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    });

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Asana"],
        modelVisibleMcpImageToolResults: true,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-linked-image",
                toolName: "qa_return_linked_image_resource",
                input: {},
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-linked-image",
                toolName: "qa_return_linked_image_resource",
                output: {
                  type: "json",
                  value: {
                    content: [
                      {
                        type: "resource_link",
                        uri: "example://linked-image.png",
                        name: "Linked PNG resource",
                        mimeType: "image/png",
                      },
                    ],
                  },
                },
              },
            ],
          },
          { role: "user", content: "what can you tell me about the image" },
        ],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    expect(managerListToolsMock).not.toHaveBeenCalled();
    expect(managerReadResourceMock).not.toHaveBeenCalled();
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        priorMessages: expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            content: [
              expect.objectContaining({
                type: "tool-result",
                output: {
                  type: "json",
                  value: {
                    content: [
                      {
                        type: "resource_link",
                        uri: "example://linked-image.png",
                        name: "Linked PNG resource",
                        mimeType: "image/png",
                      },
                    ],
                  },
                },
              }),
            ],
          }),
        ]),
      })
    );
  });

  it("attaches a numeric hostConfig.temperature when resolvedTemperature is undefined (GPT-5 path)", async () => {
    prepareChatV2Mock.mockResolvedValueOnce({
      allTools: {},
      enhancedSystemPrompt: "system",
      // GPT-5 paths leave resolvedTemperature undefined; the helper must coerce
      // to a numeric fallback so the backend's HostConfigPayload guard accepts it.
      resolvedTemperature: undefined,
    });
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatSessionId: "chat-session-gpt5",
        temperature: 0.3,
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
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(typeof persistArgs.hostConfig.temperature).toBe("number");
    expect(persistArgs.hostConfig.temperature).toBe(0.3);
  });

  it("carries outgoing sender metadata into persisted direct session messages", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatSessionId: "chat-session-senders",
        directVisibility: "project",
        messages: [
          {
            role: "user",
            content: "hello from alice",
            metadata: { senderUserId: "u-alice" },
          },
        ],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(persistArgs.sessionMessages).toEqual([
      {
        role: "user",
        content: "preview request",
        senderUserId: "u-alice",
      },
    ]);
  });

  it("does not persist spoofed sender metadata from the client", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatSessionId: "chat-session-spoofed-sender",
        directVisibility: "project",
        messages: [
          {
            role: "user",
            content: "hello from alice",
            metadata: { senderUserId: "u-bob" },
          },
        ],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(200);
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(persistArgs.sessionMessages).toEqual([
      {
        role: "user",
        content: "preview request",
      },
    ]);
  });

  it("returns server names in hosted oauth-required chat errors", async () => {
    const { app, token } = createWebTestApp();

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
                    useOAuth: true,
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

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        selectedServerNames: ["Asana"],
        messages: [{ role: "user", content: "hello" }],
        model: {
          id: "openai/gpt-5-mini",
          provider: "openai",
          name: "GPT-5 Mini",
        },
      },
      token
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "UNAUTHORIZED",
        message:
          'Server "Asana" requires OAuth authentication. Please complete the OAuth flow first.',
        details: expect.objectContaining({
          oauthRequired: true,
          serverId: "server-1",
          serverName: "Asana",
          serverUrl: "https://server-1.example.com/mcp",
        }),
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
        projectId: "project-1",
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
