import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the ENVIRONMENT-BACKED CHATBOX half of web/chat-v2 (Phase 5,
// mcpjam-backend #805): when the chatbox runtime config carries the additive
// `environment` payload, the turn runs on the environment's resolved server
// set and skill union — never the request body's — and a present-but-malformed
// payload stops the turn instead of silently falling back. An absent payload
// keeps the legacy host-backed behavior byte-identical.

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  fetchChatboxRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  convexQueryMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  fetchChatboxRuntimeConfigMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, convertToModelMessages: vi.fn((messages) => messages) };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
  })),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    })),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return { ...actual, prepareChatV2: prepareChatV2Mock };
});

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
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

vi.mock("../../../utils/chatbox-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chatbox-runtime-config.js")
  >("../../../utils/chatbox-runtime-config.js");
  // The route's parsing (`readChatboxEnvironment`) stays REAL — that is the
  // seam under test; only the network fetch is mocked.
  return {
    ...actual,
    fetchChatboxRuntimeConfig: fetchChatboxRuntimeConfigMock,
  };
});

vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import { createWebTestApp, postJson } from "./helpers/test-app.js";

/** The base (host-backed) chatbox runtime config — no environment payload. */
const CHATBOX_CONFIG = {
  chatboxId: "cbx_env",
  accessVersion: 3,
  modelId: "openai/gpt-5-mini",
  systemPrompt: "chatbox prompt",
  temperature: 0.7,
  requireToolApproval: false,
  hostStyle: "claude",
};

/** The additive payload an environment-backed chatbox carries (backend #805). */
const ENVIRONMENT_PAYLOAD = {
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  servers: {
    effectiveServerIds: ["env-server-1", "env-server-2"],
    connectable: [
      { serverId: "env-server-1", name: "linear", source: "host_or_group" },
      { serverId: "env-server-2", name: "asana", source: "plugin" },
    ],
  },
  skills: [
    {
      skillId: "sk_env",
      name: "release-notes",
      description: "Write release notes",
      content: "env skill body",
      aggregateHash: "agg_env",
      channels: ["environment"],
      files: [],
    },
  ],
};

const BASE_BODY = {
  projectId: "project-1",
  chatboxId: "cbx_env",
  accessVersion: 3,
  // Deliberately WRONG/stale: an environment-backed chatbox turn must ignore
  // this entirely; a host-backed one still honors it (legacy behavior).
  selectedServerIds: ["body-server-9"],
  selectedServerNames: ["body-server"],
  chatSessionId: "chat-session-1",
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

describe("web chat-v2 — environment-backed chatbox", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";

    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { ...CHATBOX_CONFIG, environment: ENVIRONMENT_PAYLOAD },
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      await options.onConversationComplete?.(
        [{ role: "user", content: "hi" }],
        {
          turnId: "t",
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
        const serverIds: string[] = Array.isArray(payload?.serverIds)
          ? payload.serverIds
          : [];
        return new Response(
          JSON.stringify({
            results: Object.fromEntries(
              serverIds.map((serverId) => [
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
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvexUrl;
  });

  it("runs on the payload's server set everywhere, never the body's", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    // Manager authorization batch.
    const authorizeCall = (global.fetch as any).mock.calls.find(
      ([url]: [string]) => String(url).endsWith("/web/authorize-batch")
    );
    expect(JSON.parse(authorizeCall[1].body).serverIds).toEqual([
      "env-server-1",
      "env-server-2",
    ]);

    // prepareChatV2.
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: ["env-server-1", "env-server-2"],
      })
    );

    // Nothing persisted may carry the body's stale id.
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(JSON.stringify(persistArgs)).not.toContain("body-server-9");
  });

  it("delivers the payload's skills to the emulated engine, cloud skills off", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const args = prepareChatV2Mock.mock.calls.at(-1)![0];
    // Project-wide cloud skills would double-deliver alongside the resolved
    // set — the same single-channel rule as an environment target.
    expect(args.cloudSkills).toBeUndefined();
    expect(args.skillsSource.kind).toBe("resolved");
    expect(args.skillsSource.capabilities.standaloneSkills).toEqual([
      {
        ref: "release-notes",
        skillId: "sk_env",
        name: "release-notes",
        description: "Write release notes",
        content: "env skill body",
        aggregateHash: "agg_env",
        channels: ["environment"],
        files: [],
      },
    ]);
    // The plugin-sourced server keeps its classification even with no
    // attribution probe on this path.
    expect(args.skillsSource.capabilities.pluginServerIds).toEqual([
      "env-server-2",
    ]);

    const handlerArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(handlerArgs.runtimeSkillsOverride).toEqual([
      {
        skillId: "sk_env",
        name: "release-notes",
        description: "Write release notes",
        content: "env skill body",
        aggregateHash: "agg_env",
      },
    ]);
  });

  it("treats an ABSENT skills array as authoritative-empty, not project-wide fallback", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...CHATBOX_CONFIG,
        environment: {
          environmentRef: ENVIRONMENT_PAYLOAD.environmentRef,
          servers: { effectiveServerIds: ["env-server-1"] },
        },
      },
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const args = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(args.cloudSkills).toBeUndefined();
    expect(args.skillsSource.capabilities.standaloneSkills).toEqual([]);
    // Deploy-skew fallback: no `connectable` projection ⇒ raw ids connect and
    // the manager shows the id as the name.
    expect(args.selectedServers).toEqual(["env-server-1"]);
    const handlerArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(handlerArgs.runtimeSkillsOverride).toEqual([]);
  });

  it("keeps a host-backed chatbox (no payload) byte-identical to today", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: CHATBOX_CONFIG,
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    // Legacy path: the body's server list still drives the turn.
    const authorizeCall = (global.fetch as any).mock.calls.find(
      ([url]: [string]) => String(url).endsWith("/web/authorize-batch")
    );
    expect(JSON.parse(authorizeCall[1].body).serverIds).toEqual([
      "body-server-9",
    ]);
    const args = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(args.skillsSource).toBeUndefined();
    const handlerArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(handlerArgs.runtimeSkillsOverride).toBeUndefined();
  });

  it("stops the turn on a present-but-malformed payload instead of falling back", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...CHATBOX_CONFIG,
        // Present, but missing the closed server set — an UNKNOWN environment.
        environment: {
          environmentRef: ENVIRONMENT_PAYLOAD.environmentRef,
          servers: {},
        },
      },
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(502);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("still fails closed when the runtime-config fetch itself fails", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "boom",
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(502);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
  });
});
