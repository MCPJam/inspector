import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the environment-target half of web/chat-v2 (Project Environments
// Phase 1): ingress normalization of the execution target, and the rule that
// once an environment resolves, EVERY downstream consumer uses the resolved
// values — never the raw body `selectedServerIds`.

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

vi.mock("../../../utils/chatbox-runtime-config.js", () => ({
  fetchChatboxRuntimeConfig: fetchChatboxRuntimeConfigMock,
}));

// The harness preflight checks server-level runtime prerequisites (broker
// delivery kill switch, computers data plane) that a unit test process has
// none of. Those gates are covered by harness-availability's own tests; here we
// only care about which skill set reaches which engine.
vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import { createWebTestApp, postJson } from "./helpers/test-app.js";

/** Two environment servers; the body will claim a DIFFERENT, single server. */
const ENV_SPEC = {
  specVersion: 1,
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  host: {
    hostId: "host_env",
    hostName: "Alpha",
    hostConfigId: "hc_1",
    runtimeConfig: {
      hostId: "host_env",
      hostConfigId: "hc_1",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "environment prompt",
      requireToolApproval: false,
      hostStyle: "claude",
    },
  },
  servers: {
    selectedServerIds: ["env-server-1"],
    pluginServerIds: ["env-server-2"],
    baseEffectiveServerIds: ["env-server-1", "env-server-2"],
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
  pluginVersions: [
    {
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
      name: "linear",
      bundleHash: "abc",
    },
  ],
};

const BASE_BODY = {
  projectId: "project-1",
  // Deliberately WRONG/stale: an environment turn must ignore this entirely.
  selectedServerIds: ["body-server-9"],
  selectedServerNames: ["body-server"],
  chatSessionId: "chat-session-1",
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

describe("web chat-v2 — environment execution target", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";

    convexQueryMock.mockResolvedValue(ENV_SPEC);
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchHostRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
    fetchChatboxRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
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

  it("400s chatboxId + executionTarget instead of silently picking one", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        chatboxId: "cbx_1",
        accessVersion: 1,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(
      /cannot be combined/i
    );
    // Neither resolution path may have run.
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(fetchChatboxRuntimeConfigMock).not.toHaveBeenCalled();
  });

  it("400s legacy hostId + executionTarget", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        hostId: "host_legacy",
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
    expect(response.status).toBe(400);
    expect(fetchHostRuntimeConfigMock).not.toHaveBeenCalled();
  });

  it("still honors a legacy hostId body (unchanged host-target path)", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      { ...BASE_BODY, hostId: "host_legacy" },
      token
    );
    expect(response.status).toBe(200);
    expect(fetchHostRuntimeConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host_legacy" })
    );
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it("uses the RESOLVED server set everywhere, never the body's", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
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

    // Direct-chat persistence + resume config.
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(persistArgs.hostConfig.selectedServerIds).toEqual([
      "env-server-1",
      "env-server-2",
    ]);
    expect(persistArgs.resumeConfig.selectedServers).toEqual([
      "linear",
      "asana",
    ]);
    expect(JSON.stringify(persistArgs)).not.toContain("body-server-9");
  });

  it("forwards the per-turn server override, keeping [] distinct from absent", async () => {
    const { app, token } = createWebTestApp();
    await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
        environmentOverrides: { serverIds: [] },
      },
      token
    );
    expect(convexQueryMock).toHaveBeenCalledWith(
      "projectEnvironments:resolveEnvironmentForRuntime",
      {
        projectId: "project-1",
        environmentId: "env_1",
        serverOverrideIds: [],
      }
    );
  });

  it("delivers ONLY the resolved skills to the emulated engine (no cloudSkills)", async () => {
    const { app, token } = createWebTestApp();
    await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
    const args = prepareChatV2Mock.mock.calls.at(-1)![0];
    // Project-wide cloud skills would double-deliver alongside the resolved set.
    expect(args.cloudSkills).toBeUndefined();
    expect(args.skillsSource).toEqual({
      kind: "resolved",
      skills: [
        {
          name: "release-notes",
          description: "Write release notes",
          content: "env skill body",
          contentHash: "agg_env",
          provenance: "authored",
        },
      ],
    });
  });

  it("hands the resolved skills to the HARNESS engine instead when the host runs one", async () => {
    convexQueryMock.mockResolvedValue({
      ...ENV_SPEC,
      host: {
        ...ENV_SPEC.host,
        runtimeConfig: {
          ...ENV_SPEC.host.runtimeConfig,
          harness: "claude-code",
        },
      },
    });
    const { app, token } = createWebTestApp();
    await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
    // Emulated skill tools must NOT be advertised on a harness turn.
    const prepareArgs = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(prepareArgs.skillsSource).toBeUndefined();
    expect(prepareArgs.cloudSkills).toBeUndefined();

    const handlerArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(handlerArgs.harness).toBe("claude-code");
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

  it("propagates a resolver ENV_* failure as a 409 rather than running the turn", async () => {
    const { ConvexError } = await import("convex/values");
    convexQueryMock.mockRejectedValue(
      new ConvexError({
        code: "ENV_HOST_MISSING",
        message: "This environment's host no longer exists.",
      })
    );
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token
    );
    expect(response.status).toBe(409);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });
});
