import { act, renderHook, waitFor } from "@testing-library/react";
import { generateId } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useHarnessWorkdirStore } from "@/stores/harness-workdir-store";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  authFetch: vi.fn(),
  buildServerRequest: vi.fn(),
  getAccessToken: vi.fn(async () => "access-token"),
  getGuestBearerToken: vi.fn(async () => "guest-token"),
  getCachedGuestSession: vi.fn(() => null),
  hasToken: vi.fn(() => false),
  getToken: vi.fn(() => ""),
  getOpenRouterSelectedModels: vi.fn(() => []),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getAzureBaseUrl: vi.fn(() => ""),
  getCustomProviderByName: vi.fn(),
  setSelectedModelId: vi.fn(),
  useSharedChatWidgetCapture: vi.fn(),
  latestOnData: undefined as ((part: unknown) => void) | undefined,
  latestOnToolCall: undefined as
    | ((options: { toolCall: unknown }) => Promise<void> | void)
    | undefined,
  addToolOutput: vi.fn(),
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
  detectOllamaModels: vi.fn(async () => ({
    isRunning: false,
    availableModels: [],
  })),
  detectOllamaToolCapableModels: vi.fn(async () => []),
  getToolsMetadata: vi.fn(async () => ({
    metadata: {},
    toolServerMap: {},
    tokenCounts: null,
  })),
  countTextTokens: vi.fn(async () => null),
  selectedModelId: "anthropic/claude-haiku-4.5",
}));
let lastTransportOptions: any;

async function resolveConfig<T>(value: T | (() => T | Promise<T>)) {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : value;
}

const guestModel = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic" as const,
};
const gatedAnthropicModel = {
  id: "anthropic/claude-opus-4.6",
  name: "Claude Opus 4.6",
  provider: "anthropic" as const,
};
const allowedHostedModel = {
  id: "qwen/qwen3.6-plus",
  name: "Qwen 3.6 Plus",
  provider: "qwen" as const,
};
const allowedOpenAiModel = {
  id: "openai/gpt-4o-mini",
  name: "GPT-4o Mini",
  provider: "openai" as const,
};
const orgOpenAiModel = {
  id: "gpt-4o-mini",
  name: "GPT-4o Mini",
  provider: "openai" as const,
};
const gatedOpenAiModel = {
  id: "openai/gpt-5.4-pro",
  name: "GPT-5.4 Pro",
  provider: "openai" as const,
};
const gatedGoogleModel = {
  id: "google/gemini-3.1-pro-preview",
  name: "Gemini 3.1 Pro Preview",
  provider: "google" as const,
};

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [], status: "fallback" }),
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [
    gatedAnthropicModel,
    gatedGoogleModel,
    gatedOpenAiModel,
    allowedHostedModel,
    allowedOpenAiModel,
    guestModel,
  ]),
  buildAvailableModelsFromOrgConfig: vi.fn(() => [
    orgOpenAiModel,
    allowedHostedModel,
    allowedOpenAiModel,
    guestModel,
  ]),
  getDefaultModel: vi.fn((models: Array<typeof guestModel>) => models[0]),
  isMCPJamProvidedModelMenuItem: vi.fn((model: { id: string }) =>
    String(model.id).includes("/")
  ),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: mockState.hasToken,
    getToken: mockState.getToken,
    getOpenRouterSelectedModels: mockState.getOpenRouterSelectedModels,
    getOllamaBaseUrl: mockState.getOllamaBaseUrl,
    getAzureBaseUrl: mockState.getAzureBaseUrl,
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: [],
    getCustomProviderByName: mockState.getCustomProviderByName,
  }),
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({
    selectedModelId: mockState.selectedModelId,
    setSelectedModelId: mockState.setSelectedModelId,
    selectedModelIds: [mockState.selectedModelId],
    setSelectedModelIds: vi.fn(),
    multiModelEnabled: false,
    setMultiModelEnabled: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSharedChatWidgetCapture", () => ({
  useSharedChatWidgetCapture: mockState.useSharedChatWidgetCapture,
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: mockState.detectOllamaModels,
  detectOllamaToolCapableModels: mockState.detectOllamaToolCapableModels,
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  getToolsMetadata: mockState.getToolsMetadata,
}));

vi.mock("@/lib/apis/mcp-tokenizer-api", () => ({
  countTextTokens: mockState.countTextTokens,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockState.authFetch(...args),
  getAuthHeaders: vi.fn(() => ({})),
  addTokenToUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: mockState.getGuestBearerToken,
  getCachedGuestSession: mockState.getCachedGuestSession,
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildServerRequest: mockState.buildServerRequest,
  buildResolvedServerBatchRequest: vi.fn(
    ({
      projectId,
      serverIds,
      serverNames,
      oauthTokens,
      accessScope,
      scenarioId,
      accessVersion,
    }: {
      projectId: string;
      serverIds: string[];
      serverNames: string[];
      oauthTokens?: Record<string, string>;
      accessScope?: string;
      scenarioId?: string;
      accessVersion?: number;
    }) => ({
      projectId,
      serverIds,
      serverNames,
      ...(oauthTokens ? { oauthTokens } : {}),
      ...(accessScope ? { accessScope } : {}),
      ...(scenarioId ? { scenarioId } : {}),
      ...(scenarioId && Number.isFinite(accessVersion) ? { accessVersion } : {}),
    })
  ),
  getApiContextRevision: vi.fn(() => 0),
  subscribeApiContext: vi.fn(() => () => {}),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockState.getAccessToken,
  }),
}));

vi.mock("convex/react", () => ({
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => mockState.convexAuth,
  // useChatSession reads the credit balance (to lock free models at 0
  // credits); no balance in these tests → outOfCredits resolves false.
  useQuery: () => undefined,
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");

  return {
    useChat: vi.fn(
      ({
        id,
        transport,
        onData,
        onToolCall,
      }: {
        id: string;
        transport: {
          sendMessages: (options: any) => Promise<unknown>;
        };
        onData?: (part: unknown) => void;
        onToolCall?: (options: {
          toolCall: unknown;
        }) => Promise<void> | void;
      }) => {
        const latchedIdRef = React.useRef(id);
        const latchedTransportRef = React.useRef(transport);
        mockState.latestOnData = onData;
        mockState.latestOnToolCall = onToolCall;

        if (latchedIdRef.current !== id) {
          latchedIdRef.current = id;
          latchedTransportRef.current = transport;
        }

        return {
          messages: [],
          sendMessage: async (message: any) => {
            await latchedTransportRef.current.sendMessages({
              chatId: latchedIdRef.current,
              messages: [
                {
                  id: "user-1",
                  role: "user",
                  parts:
                    "text" in message
                      ? [{ type: "text", text: message.text }]
                      : [],
                },
              ],
              abortSignal: new AbortController().signal,
              metadata: undefined,
              headers: undefined,
              body: undefined,
              trigger: "submit-message",
              messageId: undefined,
            });
          },
          stop: mockState.stop,
          status: "ready",
          error: undefined,
          setMessages: mockState.setMessages,
          addToolApprovalResponse: mockState.addToolApprovalResponse,
          addToolOutput: mockState.addToolOutput,
        };
      }
    ),
  };
});

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    options: any;
    sendMessages: ReturnType<typeof vi.fn>;

    constructor(options: unknown) {
      lastTransportOptions = options;
      this.options = options;
      this.sendMessages = vi.fn(async (requestOptions: any) => {
        const resolvedBody = await resolveConfig(this.options.body);
        const resolvedHeaders = await resolveConfig(this.options.headers);
        const requestBody = {
          ...resolvedBody,
          id: requestOptions.chatId,
          messages: requestOptions.messages,
          trigger: requestOptions.trigger,
          messageId: requestOptions.messageId,
        };
        await this.options.fetch?.(this.options.api, {
          method: "POST",
          headers: resolvedHeaders,
          body: JSON.stringify(requestBody),
        });
        return new ReadableStream();
      });
    }
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession hosted mode", () => {
  beforeEach(() => {
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
    mockState.authFetch.mockReset();
    mockState.authFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockState.setMessages.mockReset();
    mockState.buildServerRequest.mockReset();
    mockState.getAccessToken.mockReset();
    mockState.getAccessToken.mockResolvedValue("access-token");
    mockState.getGuestBearerToken.mockReset();
    mockState.getGuestBearerToken.mockResolvedValue("guest-token");
    mockState.selectedModelId = "anthropic/claude-haiku-4.5";
    mockState.latestOnData = undefined;
    mockState.latestOnToolCall = undefined;
    mockState.addToolOutput.mockReset();
    vi.mocked(generateId).mockReset();
    vi.mocked(generateId).mockReturnValue("chat-session-id");
    useTrafficLogStore.getState().clear();
  });

  it("announces the hosted-elicitation handshake", async () => {
    // The server registers its elicitation callback (and therefore advertises
    // the capability) ONLY when it sees this. Catalog hosts already declare
    // elicitation, so a client that doesn't announce would be left hanging on a
    // prompt it can't render — this field is the rollout gate.
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    expect(lastTransportOptions.body()).toMatchObject({
      hostedElicitationVersion: 1,
    });
  });

  it("announces the hosted-MRTR handshake", async () => {
    // §12.5: the server only registers the SUSPENDING collector — and so only
    // takes the durable continuation path — when it sees this. Without it a
    // stale bundle would be handed a continuationId it cannot render or
    // resume, and the operation would sit until its TTL.
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    expect(lastTransportOptions.body()).toMatchObject({
      hostedMrtrVersion: 1,
    });
  });

  it("includes chatSessionId in the hosted transport body", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
        },
      })
    );

    const body = lastTransportOptions.body();
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(body).toMatchObject({
      projectId: "project-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      selectedServerNames: ["server-1"],
      scenarioId: "cbx_test",
      accessVersion: 1,
      accessScope: "chat_v2",
    });
    unmount();
  });

  it("includes scenarioId and accessVersion in the hosted transport body", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
          oauthTokens: {
            "server-id-1": "browser-token",
          },
        },
      })
    );

    const body = lastTransportOptions.body();
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(body).toMatchObject({
      projectId: "project-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      selectedServerNames: ["server-1"],
      scenarioId: "cbx_test",
      accessVersion: 1,
      accessScope: "chat_v2",
    });
    expect(body).not.toHaveProperty("oauthTokens");
    unmount();
  });

  it("includes scenario surface in the hosted transport body", async () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
          scenarioSurface: "preview",
        },
      })
    );

    const body = lastTransportOptions.body();
    expect(body).toMatchObject({
      scenarioId: "cbx_test",
      accessVersion: 1,
      surface: "preview",
    });
    unmount();
  });

  it("never ships WebMCP ui_* tools from the generic hook", async () => {
    // MCPJam UI tools are agent-surface-only: even with a non-empty internal
    // registry, the generic chat body must not carry a `uiTools` field on any
    // surface. The only sender is agent-chat-instances.ts
    // (/api/web/mcpjam-agent).
    const unregister = useUiToolsRegistry.getState().registerUiTool({
      name: "ui_navigate",
      description: "Navigate the MCPJam inspector",
      readOnly: false,
      execute: async () => ({
        content: [{ type: "text" as const, text: "{}" }],
      }),
    });
    try {
      // Direct hosted chat: no uiTools field.
      const direct = renderHook(() =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
          },
        })
      );
      expect(lastTransportOptions.body()).not.toHaveProperty("uiTools");
      direct.unmount();

      // Scenario session (published/share-link or owner preview): same —
      // the field is absent entirely, not sent as an empty list.
      const scenario = renderHook(() =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
            scenarioId: "cbx_test",
            accessVersion: 1,
          },
        })
      );
      expect(lastTransportOptions.body()).not.toHaveProperty("uiTools");
      scenario.unmount();
    } finally {
      unregister();
    }
  });

  it("does not claim a server-origin ui_* tool call in the generic hook", async () => {
    // Provenance boundary regression: an MCP server may legitimately expose a
    // tool named `ui_server_action`. Even when the internal MCPJam UI registry
    // holds a same-named entry, the generic hook's onToolCall must NOT execute
    // it in the browser or synthesize a tool output — the call falls through
    // to the server's execute path like any other MCP tool.
    const uiExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "{}" }],
    }));
    const unregister = useUiToolsRegistry.getState().registerUiTool({
      name: "ui_server_action",
      description: "Registry twin that must not claim the server call",
      readOnly: false,
      execute: uiExecute,
    });
    try {
      const { unmount } = renderHook(() =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
          },
        })
      );
      expect(mockState.latestOnToolCall).toBeDefined();

      await act(async () => {
        await mockState.latestOnToolCall?.({
          toolCall: {
            toolName: "ui_server_action",
            toolCallId: "tool-call-ui-1",
            input: {},
          },
        });
      });

      expect(uiExecute).not.toHaveBeenCalled();
      expect(mockState.addToolOutput).not.toHaveBeenCalled();
      unmount();
    } finally {
      unregister();
    }
  });

  it("uses organization provider config to expose BYOK hosted models", async () => {
    mockState.selectedModelId = "gpt-4o-mini";

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedOrgModelConfig: {
          providers: [
            {
              providerKey: "openai",
              enabled: true,
              hasSecret: true,
            },
          ],
        },
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    await waitFor(() => {
      expect(result.current.availableModels.map((model) => model.id)).toContain(
        "gpt-4o-mini"
      );
    });
    expect(result.current.selectedModel.id).toBe("gpt-4o-mini");
    expect(result.current.isMcpJamModel).toBe(false);
    expect(result.current.traceViewsSupported).toBe(true);
    unmount();
  });

  it("resets the thread when the hosted scope changes under the same auth header", async () => {
    vi.mocked(generateId)
      .mockImplementationOnce(() => "chat-session-id")
      .mockImplementation(() => "chat-session-id-2");
    const onReset = vi.fn();

    const { result, rerender } = renderHook(
      ({
        hostedContext,
      }: {
        hostedContext: {
          projectId: string;
          selectedServerIds: string[];
          scenarioId: string;
          accessVersion: number;
        };
      }) =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext,
          onReset,
        }),
      {
        initialProps: {
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
            scenarioId: "cbx_1",
            accessVersion: 1,
          },
        },
      }
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    expect(result.current.chatSessionId).toBe("chat-session-id");

    mockState.setMessages.mockClear();
    onReset.mockClear();

    rerender({
      hostedContext: {
        projectId: "project-2",
        selectedServerIds: ["server-id-2"],
        scenarioId: "cbx_2",
        accessVersion: 1,
      },
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("chat-session-id-2");
    });

    expect(mockState.setMessages).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith("auth-bootstrap");
  });

  it("marks session bootstrap complete only after auth setup finishes", async () => {
    let resolveAccessToken: (value: string) => void = () => {};
    mockState.getAccessToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveAccessToken = resolve;
        })
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    expect(result.current.isSessionBootstrapComplete).toBe(false);

    resolveAccessToken("access-token");

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });
  });

  it("uses the latest hosted selectedServerIds on the next send without changing chatSessionId", async () => {
    const { result, rerender } = renderHook(
      ({
        selectedServers,
        hostedSelectedServerIds,
      }: {
        selectedServers: string[];
        hostedSelectedServerIds: string[];
      }) =>
        useChatSession({
          selectedServers,
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: hostedSelectedServerIds,
          },
        }),
      {
        initialProps: {
          selectedServers: ["server-1"],
          hostedSelectedServerIds: ["server-id-1"],
        },
      }
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    const initialChatSessionId = result.current.chatSessionId;
    mockState.authFetch.mockClear();

    act(() => {
      result.current.sendMessage({ text: "first" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}"
        )
      )
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      selectedServerIds: ["server-id-1"],
    });

    rerender({
      selectedServers: ["server-2"],
      hostedSelectedServerIds: ["server-id-2"],
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);

    act(() => {
      result.current.sendMessage({ text: "second" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(2);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}"
        )
      )
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      selectedServerIds: ["server-id-2"],
    });
  });

  it("pairs preflight-resolved server ids with the names they were resolved from when the selection changes mid-preflight", async () => {
    let resolvePreflight!: (value: Array<{ serverId: string }>) => void;
    const ensureServerIds = vi.fn(
      () =>
        new Promise<Array<{ serverId: string }>>((resolve) => {
          resolvePreflight = resolve;
        })
    );

    const { result, rerender } = renderHook(
      ({ selectedServers }: { selectedServers: string[] }) =>
        useChatSession({
          selectedServers,
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: [],
            ensureServerIds,
          },
        }),
      { initialProps: { selectedServers: ["server-a", "server-b"] } }
    );

    mockState.authFetch.mockClear();

    // Send starts: the async preflight is now in flight for [server-a, server-b].
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage({ text: "hi" });
    });
    expect(ensureServerIds).toHaveBeenCalledWith(["server-a", "server-b"]);

    // Selection changes BEFORE the preflight resolves.
    rerender({ selectedServers: ["server-a"] });

    resolvePreflight([{ serverId: "id-a" }, { serverId: "id-b" }]);
    await act(async () => {
      await sendPromise;
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
    });
    const body = JSON.parse(
      String(
        (mockState.authFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined)
          ?.body ?? "{}"
      )
    );
    // Ids ride with the names they were resolved from — never stale ids
    // paired with the fresh (shrunk) selection.
    expect(body.selectedServerIds).toEqual(["id-a", "id-b"]);
    expect(body.selectedServerNames).toEqual(["server-a", "server-b"]);
  });

  it("fails a send closed when the session changes mid-preflight", async () => {
    // `useChat` runs on a stable `proxyTransport` that delegates at REQUEST
    // time to the latest transport, so the POST body carries whatever
    // `chatSessionId` is live when it fires — not the one the message was
    // composed against. Without a guard, a session change during the async
    // server-id preflight posts this turn into an unrelated transcript, and
    // ingestion writes it there. Sibling of the target-key check above.
    // `resetChat` mints through `generateId`, stubbed to a constant for this
    // suite — so it must vary here or the session would never actually move.
    vi.mocked(generateId)
      .mockImplementationOnce(() => "chat-session-id")
      .mockImplementation(() => "chat-session-id-2");

    let resolvePreflight!: (value: Array<{ serverId: string }>) => void;
    const ensureServerIds = vi.fn(
      () =>
        new Promise<Array<{ serverId: string }>>((resolve) => {
          resolvePreflight = resolve;
        })
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-a"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
          ensureServerIds,
        },
      })
    );

    // `authFetch`, not `mockState.sendMessage`: the mocked `useChat` returns
    // its OWN inline `sendMessage` that drives the transport directly, so
    // `mockState.sendMessage` is never wired in and asserting on it would be
    // vacuously true. The transport's fetch is the only real post signal.
    mockState.authFetch.mockClear();

    let sendPromise: Promise<boolean> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage({ text: "hi" }) as unknown as
        | Promise<boolean>
        | undefined;
    });
    expect(ensureServerIds).toHaveBeenCalledWith(["server-a"]);

    // The thread moves under the in-flight preflight.
    act(() => {
      result.current.resetChat();
    });
    expect(result.current.chatSessionId).toBe("chat-session-id-2");

    resolvePreflight([{ serverId: "id-a" }]);
    const dispatched = await act(async () => await sendPromise);

    // Fails closed: resolves `false` and never posts, so the turn cannot land
    // under the session that replaced the one it was composed against.
    expect(dispatched).toBe(false);
    expect(mockState.authFetch).not.toHaveBeenCalled();
  });

  it("does not block submit on unresolved server ids when a send-time resolver is provided", async () => {
    const ensureServerIds = vi.fn(async (names: string[]) =>
      names.map((name) => ({ serverId: `id-${name}` }))
    );
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["adhoc-server"],
        hostedContext: {
          projectId: "project-1",
          // Ad-hoc/App servers have no pre-resolved Convex ids — the
          // sendMessage preflight is what persists them.
          selectedServerIds: [],
          ensureServerIds,
        },
      })
    );
    await waitFor(() => {
      expect(result.current.inputDisabled).toBe(false);
    });
  });

  it("ingests hosted rpc logs from chat error responses", async () => {
    mockState.authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "chat failed",
          _rpcLogs: [
            {
              serverId: "server-id-1",
              serverName: "server-1",
              direction: "send",
              timestamp: "2026-04-10T12:00:00.000Z",
              message: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              },
            },
          ],
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            serverId: "server-id-1",
            serverName: "server-1",
            method: "tools/list",
          }),
        ])
      );
    });
  });

  it("ingests hosted rpc log data parts from the chat stream", async () => {
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    act(() => {
      mockState.latestOnData?.({
        type: "data-rpc-log",
        data: {
          serverId: "server-id-1",
          serverName: "server-1",
          direction: "receive",
          timestamp: "2026-04-10T12:00:00.000Z",
          message: {
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [] },
          },
        },
      });
    });

    expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "server-id-1",
          serverName: "server-1",
          direction: "RECEIVE",
          method: "result",
        }),
      ])
    );
  });

  it("leaves all hosted models enabled for anonymous hosted viewers (guests un-gated)", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
        },
      })
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    expect(result.current.availableModels.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4.6",
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.4-pro",
      "qwen/qwen3.6-plus",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
    ]);
    // Guests are no longer model-curated: NO hosted model is locked with the
    // "Sign in" reason. Anonymous hosted users are still funnelled to sign in
    // by the input-level disableForAuthentication gate, not per-model locks.
    for (const model of result.current.availableModels) {
      expect(model.disabled).toBeUndefined();
    }
    unmount();
  });

  it("keeps a formerly-gated persisted model selected for an anonymous hosted viewer", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));
    mockState.selectedModelId = "google/gemini-3.1-pro-preview";

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
        },
      })
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    // No longer gated → the persisted model stays selected (no fallback).
    expect(result.current.selectedModel.id).toBe(
      "google/gemini-3.1-pro-preview"
    );
    unmount();
  });
  it("treats anonymous shared-chat viewers as guest users", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
        },
      })
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    // Every hosted model is now enabled for a guest shared-chat viewer.
    expect(
      result.current.availableModels
        .filter((model) => !model.disabled)
        .map((model) => model.id)
    ).toEqual([
      "anthropic/claude-opus-4.6",
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.4-pro",
      "qwen/qwen3.6-plus",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(result.current.isAuthReady).toBe(true);
    unmount();
  });

  it("passes persisted widget snapshot tool call ids to the capture hook after loading history", async () => {
    mockState.useSharedChatWidgetCapture.mockClear();
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    await result.current.loadChatSession({
      chatSessionId: "history-session-1",
      messagesBlobUrl: null,
      version: 3,
      widgetSnapshots: [
        {
          toolCallId: "tool-call-1",
          toolName: "search",
          serverId: "server-id-1",
          uiType: "mcp-apps",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
        },
      ],
    });

    await waitFor(() => {
      expect(mockState.useSharedChatWidgetCapture).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chatSessionId: "history-session-1",
          persistedSnapshotToolCallIds: ["tool-call-1"],
        })
      );
    });

    unmount();
  });

  it("hydrates persisted widget snapshot tool output for replayed widgets", async () => {
    const toolOutput = {
      content: [{ type: "text", text: "rendered" }],
      structuredContent: { checkpointId: "checkpoint-1" },
      _meta: {
        ui: { resourceUri: "ui://excalidraw/mcp-app.html" },
        _serverId: "server-id-1",
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(toolOutput), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    await result.current.loadChatSession({
      chatSessionId: "history-session-2",
      messagesBlobUrl: null,
      version: 4,
      widgetSnapshots: [
        {
          toolCallId: "tool-call-1",
          toolName: "create_view",
          serverId: "server-id-1",
          uiType: "mcp-apps",
          resourceUri: "ui://excalidraw/mcp-app.html",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
          toolOutputUrl: "https://storage.example.com/tool-output.json",
        },
      ],
    });

    await waitFor(() => {
      expect(
        result.current.restoredToolRenderOverrides["tool-call-1"]?.toolOutput
      ).toEqual(toolOutput);
    });

    fetchSpy.mockRestore();
    unmount();
  });

  it("sets liveFetchPreferred for mcp-apps revisits but leaves openai-apps on the cached path", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      })
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    await result.current.loadChatSession({
      chatSessionId: "history-session-revisit",
      messagesBlobUrl: null,
      version: 5,
      widgetSnapshots: [
        {
          toolCallId: "tool-call-mcp",
          toolName: "create_view",
          serverId: "server-id-1",
          uiType: "mcp-apps",
          resourceUri: "ui://excalidraw/mcp-app.html",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
          widgetHtmlUrl: "https://storage.example.com/mcp-widget.html",
        },
        {
          toolCallId: "tool-call-openai",
          toolName: "show_pizzeria",
          serverId: "server-id-1",
          uiType: "openai-apps",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
          widgetHtmlUrl: "https://storage.example.com/openai-widget.html",
        },
      ],
    });

    await waitFor(() => {
      const mcp = result.current.restoredToolRenderOverrides["tool-call-mcp"];
      const openai =
        result.current.restoredToolRenderOverrides["tool-call-openai"];
      expect(mcp).toBeDefined();
      expect(openai).toBeDefined();
      // MCP Apps revisit: live-first with cached fallback. Cached URL is
      // preserved so the renderer can fall back if the server is no longer
      // connected.
      expect(mcp?.liveFetchPreferred).toBe(true);
      expect(mcp?.cachedWidgetHtmlUrl).toBe(
        "https://storage.example.com/mcp-widget.html"
      );
      // OpenAI Apps revisit: cached path only (cannot live-fetch
      // `outputTemplate = "__cached__"`).
      expect(openai?.liveFetchPreferred).toBe(false);
      expect(openai?.cachedWidgetHtmlUrl).toBe(
        "https://storage.example.com/openai-widget.html"
      );
      expect(openai?.isOffline).toBe(true);
    });

    unmount();
  });

  it("keeps even gated hosted models available for authenticated viewers", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
          scenarioId: "cbx_test",
          accessVersion: 1,
        },
      })
    );

    await waitFor(() => {
      expect(result.current.availableModels.map((model) => model.id)).toContain(
        "openai/gpt-5.4-pro"
      );
    });
    expect(
      result.current.availableModels.find(
        (model) => model.id === "openai/gpt-5.4-pro"
      )?.disabled
    ).toBeUndefined();
    unmount();
  });
});

// ── Project Environments — Phase 2.3 (request serialization) ────────────────
//
// The wire contract these cover is not "an extra optional field". It is a
// closed union that `normalizeExecutionTarget` REJECTS ambiguity in, plus an
// override envelope whose absent / `[]` distinction is load-bearing all the way
// to the backend resolver. Both are exactly the kind of thing that regresses
// silently — a body that still carries `hostId` 400s, and a body that always
// carries `environmentOverrides` would pin the environment's own set as if the
// user had chosen it.
describe("useChatSession — environment execution target", () => {
  const environmentContext = {
    projectId: "project-1",
    selectedServerIds: ["server-id-1"],
    requiresWebChatApi: true,
    executionTarget: { kind: "environment" as const, environmentId: "env_1" },
  };

  it("sends executionTarget and NEVER a legacy hostId alongside it", () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: environmentContext,
      })
    );

    const body = lastTransportOptions.body();
    expect(body).toMatchObject({
      executionTarget: { kind: "environment", environmentId: "env_1" },
    });
    // `hostId` + `executionTarget` is a 400, not a precedence question.
    expect(body).not.toHaveProperty("hostId");
    unmount();
  });

  it("omits environmentOverrides entirely before the user overrides anything", () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: environmentContext,
      })
    );

    // Absent ⇒ "resolve the environment's own server set". Sending an envelope
    // here would freeze whatever the set happened to be at page load.
    expect(lastTransportOptions.body()).not.toHaveProperty(
      "environmentOverrides"
    );
    unmount();
  });

  it("sends an EMPTY explicit override as an override, not as absence", () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          ...environmentContext,
          environmentOverrides: { serverIds: [] },
        },
      })
    );

    // `[]` means "run this turn with no MCP servers" and must survive the trip.
    expect(lastTransportOptions.body()).toMatchObject({
      environmentOverrides: { serverIds: [] },
    });
    unmount();
  });

  it("forwards an explicit narrowing by id", () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          ...environmentContext,
          environmentOverrides: { serverIds: ["srv_a", "srv_b"] },
        },
      })
    );

    expect(lastTransportOptions.body()).toMatchObject({
      environmentOverrides: { serverIds: ["srv_a", "srv_b"] },
    });
    unmount();
  });

  it("never runs the name→id persistence preflight for an environment turn", async () => {
    // Environment servers already carry authoritative Convex ids, and
    // plugin-contributed ones are deliberately hidden from
    // `servers:getProjectServers` — resolving them BY NAME would fail outright
    // or persist a shadow copy that bypasses plugin lifecycle semantics.
    const ensureServerIds = vi.fn(async () => [
      { serverName: "server-1", serverId: "server-id-1" },
    ]);
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: { ...environmentContext, ensureServerIds },
      })
    );

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(ensureServerIds).not.toHaveBeenCalled();
    unmount();
  });

  it("does not gate submit on browser-resolved server ids", async () => {
    // The hosted environment path is server-connected: the backend resolves and
    // connects the set. Requiring one browser-known id per selected server would
    // never open for a plugin-contributed environment.
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1", "hidden-plugin-server"],
        hostedContext: { ...environmentContext, selectedServerIds: [] },
      })
    );

    await waitFor(() => expect(result.current.submitBlocked).toBe(false));

    // Control: the same shape WITHOUT an environment target stays blocked,
    // because that path really does need one Convex id per selected server.
    const hostMode = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1", "hidden-plugin-server"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
          requiresWebChatApi: true,
          hostId: "host_1",
        },
      })
    );
    expect(hostMode.result.current.submitBlocked).toBe(true);
    hostMode.unmount();
    unmount();
  });

  it("caches the harness workdir under the PRESENTATION host, not the project fallback", () => {
    // An environment target carries no `hostId` on the wire (the server
    // re-resolves the host from the environment), so the workdir cache used to
    // land under the project key — while the Playground Shell reads it by the
    // environment's resolved host id. The terminal then opened at the box home
    // instead of inside the harness session directory.
    useHarnessWorkdirStore.setState({ byKey: {} });
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          ...environmentContext,
          presentationHostId: "host_env",
        },
      })
    );

    act(() => {
      mockState.latestOnData?.({
        type: "data-harness-session",
        data: { workdir: "/home/user/claude-code-abc" },
      });
    });

    // `h:<hostId>` is the store's own key shape, and the rail reads it with the
    // previewed host id — which in environment mode IS the environment's host.
    expect(useHarnessWorkdirStore.getState().byKey["h:host_env"]).toBe(
      "/home/user/claude-code-abc"
    );
    unmount();
  });

  it("aborts a send whose target changed while the name→id preflight was in flight", async () => {
    // The preflight is async and the transport body is built from the LATEST
    // props when the request finally goes out. A message composed against a
    // host would otherwise resume into the environment the user just selected
    // and run against a different bundle entirely.
    let resolvePreflight!: (value: Array<{ serverId: string }>) => void;
    const ensureServerIds = vi.fn(
      () =>
        new Promise<Array<{ serverId: string }>>((resolve) => {
          resolvePreflight = resolve;
        })
    );

    const { result, rerender, unmount } = renderHook(
      ({ inEnvironment }: { inEnvironment: boolean }) =>
        useChatSession({
          selectedServers: ["server-a"],
          hostedContext: inEnvironment
            ? environmentContext
            : {
                projectId: "project-1",
                selectedServerIds: [],
                requiresWebChatApi: true,
                hostId: "host_1",
                ensureServerIds,
              },
        }),
      { initialProps: { inEnvironment: false } }
    );
    mockState.authFetch.mockClear();

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage({ text: "hi" });
    });
    expect(ensureServerIds).toHaveBeenCalledWith(["server-a"]);

    // The user switches to an environment before the preflight settles.
    rerender({ inEnvironment: true });
    resolvePreflight([{ serverId: "id-a" }]);
    await act(async () => {
      await sendPromise;
    });

    // Fail CLOSED: nothing goes out. The user resends against the target they
    // can actually see.
    expect(mockState.authFetch).not.toHaveBeenCalled();
    unmount();
  });

  describe("scenario access recovery", () => {
    const TURN_URL = "/api/web/chat-v2";

    function turnInit(accessVersion: number) {
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioId: "cbx_recover",
          accessVersion,
          messages: [{ role: "user", content: "hi" }],
        }),
      } satisfies RequestInit;
    }

    function accessErrorResponse(code: string, status: number) {
      return new Response(JSON.stringify({ code, message: "no" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    function renderScenario(
      hostedOverrides: Record<string, unknown>
    ) {
      return renderHook(() =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
            scenarioId: "cbx_recover",
            accessVersion: 1,
            requiresWebChatApi: true,
            ...hostedOverrides,
          },
        })
      );
    }

    /** The transport's fetch IS chatFetch — call it directly. */
    function chatFetch() {
      return lastTransportOptions.fetch as (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => Promise<Response>;
    }

    it("recovers from a 409 stale turn and replays it with the fresh accessVersion", async () => {
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: true, accessVersion: 12 });
      const onAccessRevoked = vi.fn();
      const { unmount } = renderScenario({
        refreshAccessSession,
        onAccessRevoked,
      });

      mockState.authFetch
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_STALE", 409))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const response = await chatFetch()(TURN_URL, turnInit(1));

      expect(response.status).toBe(200);
      expect(refreshAccessSession).toHaveBeenCalledTimes(1);
      expect(mockState.authFetch).toHaveBeenCalledTimes(2);

      // The replay is byte-identical except for the field that went stale.
      const replayInit = mockState.authFetch.mock.calls[1][1] as RequestInit;
      expect(JSON.parse(replayInit.body as string)).toEqual({
        scenarioId: "cbx_recover",
        accessVersion: 12,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(onAccessRevoked).not.toHaveBeenCalled();
      unmount();
    });

    it("recovers from a direct denial too — /redeem re-mints the link grant", async () => {
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: true, accessVersion: 3 });
      const { unmount } = renderScenario({ refreshAccessSession });

      mockState.authFetch
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_DENIED", 403))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const response = await chatFetch()(TURN_URL, turnInit(1));

      expect(response.status).toBe(200);
      expect(refreshAccessSession).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("never recovers twice — a replay that also fails is final", async () => {
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: true, accessVersion: 2 });
      const onAccessRevoked = vi.fn();
      const { unmount } = renderScenario({
        refreshAccessSession,
        onAccessRevoked,
      });

      mockState.authFetch
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_STALE", 409))
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_STALE", 409));

      const response = await chatFetch()(TURN_URL, turnInit(1));

      expect(response.status).toBe(409);
      expect(refreshAccessSession).toHaveBeenCalledTimes(1);
      expect(mockState.authFetch).toHaveBeenCalledTimes(2);
      // A still-stale replay is not a revocation.
      expect(onAccessRevoked).not.toHaveBeenCalled();
      unmount();
    });

    it("revokes when the replay itself comes back denied", async () => {
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: true, accessVersion: 2 });
      const onAccessRevoked = vi.fn();
      const { unmount } = renderScenario({
        refreshAccessSession,
        onAccessRevoked,
      });

      mockState.authFetch
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_DENIED", 403))
        .mockResolvedValueOnce(accessErrorResponse("SCENARIO_ACCESS_DENIED", 403));

      await chatFetch()(TURN_URL, turnInit(1));

      expect(onAccessRevoked).toHaveBeenCalledTimes(1);
      expect(onAccessRevoked).toHaveBeenCalledWith(
        expect.objectContaining({ status: 403, code: "SCENARIO_ACCESS_DENIED" })
      );
      unmount();
    });

    it("revokes when the recovery redeem is itself definitively refused", async () => {
      const error = { status: 403, code: "SCENARIO_MEMBERS_ONLY", message: "no" };
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: "denied", error });
      const onAccessRevoked = vi.fn();
      const { unmount } = renderScenario({
        refreshAccessSession,
        onAccessRevoked,
      });

      mockState.authFetch.mockResolvedValue(
        accessErrorResponse("SCENARIO_ACCESS_DENIED", 403)
      );

      const response = await chatFetch()(TURN_URL, turnInit(1));

      expect(response.status).toBe(403);
      // No replay — the redeem already said no.
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
      expect(onAccessRevoked).toHaveBeenCalledWith(error);
      unmount();
    });

    it("leaves a transient recovery failure to the normal error path", async () => {
      const refreshAccessSession = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: "transient" });
      const onAccessRevoked = vi.fn();
      const { unmount } = renderScenario({
        refreshAccessSession,
        onAccessRevoked,
      });

      mockState.authFetch.mockResolvedValue(
        accessErrorResponse("SCENARIO_ACCESS_STALE", 409)
      );

      const response = await chatFetch()(TURN_URL, turnInit(1));

      // The original error surfaces; the next send gets a fresh attempt.
      expect(response.status).toBe(409);
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
      expect(onAccessRevoked).not.toHaveBeenCalled();
      unmount();
    });

    it("skips classification entirely on a non-scenario turn", async () => {
      const refreshAccessSession = vi.fn();
      const { unmount } = renderHook(() =>
        useChatSession({
          selectedServers: ["server-1"],
          hostedContext: {
            projectId: "project-1",
            selectedServerIds: ["server-id-1"],
            requiresWebChatApi: true,
            refreshAccessSession,
          },
        })
      );

      mockState.authFetch.mockResolvedValue(
        accessErrorResponse("SCENARIO_ACCESS_STALE", 409)
      );

      await chatFetch()(TURN_URL, turnInit(1));

      expect(refreshAccessSession).not.toHaveBeenCalled();
      unmount();
    });
  });
});
