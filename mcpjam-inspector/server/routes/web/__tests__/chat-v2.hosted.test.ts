import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  checkHarnessRuntimeAvailableMock,
  prepareChatV2Mock,
  listCloudRuntimeSkillsMock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  fetchScenarioRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  managerListToolsMock,
  managerReadResourceMock,
  emitConstructorRpcLogMock,
  validateAppToolEntriesMock,
  AppToolValidationErrorMock,
  validateUiToolEntriesMock,
  UiToolValidationErrorMock,
  validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPromptMock,
  WidgetModelContextValidationErrorMock,
} = vi.hoisted(() => ({
  checkHarnessRuntimeAvailableMock: vi.fn(() => ({ ok: true })),
  prepareChatV2Mock: vi.fn(),
  listCloudRuntimeSkillsMock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  fetchScenarioRuntimeConfigMock: vi.fn(),
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
  validateUiToolEntriesMock: vi.fn(() => []),
  UiToolValidationErrorMock: class UiToolValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UiToolValidationError";
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

const imagePolicy = (image: boolean) => ({
  directContent: { image },
  embeddedResources: { blob: { image } },
  linkedResources: { blob: { image } },
});

const resolvedImagePolicyMatcher = (image: boolean) =>
  expect.objectContaining({
    directContent: expect.objectContaining({ image }),
    embeddedResources: expect.objectContaining({
      blob: expect.objectContaining({ image }),
    }),
    linkedResources: expect.objectContaining({
      blob: expect.objectContaining({ image }),
    }),
  });

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
  validateUiToolEntries: validateUiToolEntriesMock,
  UiToolValidationError: UiToolValidationErrorMock,
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

// Only the PREFLIGHT is stubbed, and only so a harness-typed host can reach the
// dispatch in a unit test (the real gate needs a computers data plane). Every
// other export stays real — `harnessModelEligibleForRuntime` in particular,
// which is the shared eligibility answer the dispatch reads.
vi.mock("../../../utils/harness/harness-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-availability.js")
  >("../../../utils/harness/harness-availability.js");
  return {
    ...actual,
    checkHarnessRuntimeAvailable: (...args: unknown[]) =>
      checkHarnessRuntimeAvailableMock(...(args as [])),
  };
});

vi.mock("../../../utils/scenario-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/scenario-runtime-config.js")
  >("../../../utils/scenario-runtime-config.js");
  // Keep `readScenarioEnvironment` REAL (the route parses the environment
  // payload through it on every scenario turn); mock only the network fetch.
  return {
    ...actual,
    fetchScenarioRuntimeConfig: fetchScenarioRuntimeConfigMock,
  };
});

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

vi.mock("../../../utils/computers/cloud-skill-tools.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >("../../../utils/computers/cloud-skill-tools.js");
  return {
    ...actual,
    listCloudRuntimeSkills: (...args: unknown[]) =>
      listCloudRuntimeSkillsMock(...args),
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

    checkHarnessRuntimeAvailableMock.mockReturnValue({ ok: true });
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
    listCloudRuntimeSkillsMock.mockReset().mockResolvedValue([]);
    // Default: scenario runtime-config resolves (empty = host has no
    // overrides). Scenario turns now FAIL CLOSED on a failed fetch, so the
    // happy-path tests must resolve it rather than lean on the old fallback.
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {},
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

  it("persists scenario preview chats with internal surface", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_1",
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
        sourceType: "scenario",
        scenarioId: "cbx_1",
        surface: "preview",
        modelId: "openai/gpt-5-mini",
        modelSource: "mcpjam",
      })
    );
    // Non-direct flows must NOT send hostConfig — backend skips with
    // missing_field, which is the desired behavior for scenario/serverShare.
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(persistArgs.hostConfig).toBeUndefined();
  });

  it("ignores a client uiTools snapshot on direct AND scenario turns (agent-route-only, never rejected)", async () => {
    const { app, token } = createWebTestApp();
    // Non-empty/stale snapshot a cached pre-cutover client may still send.
    const uiTools = [
      { name: "ui_navigate", description: "Navigate", readOnly: false },
    ];
    const baseBody = {
      projectId: "project-1",
      selectedServerIds: ["server-1"],
      chatSessionId: "chat-session-1",
      messages: [{ role: "user", content: "hi" }],
      model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      uiTools,
    };

    // Direct hosted chat: the field is dropped at the boundary — never
    // validated (a malformed snapshot must not 400 the turn) and never
    // forwarded into prepareChatV2.
    const direct = await postJson(app, "/api/web/chat-v2", baseBody, token);
    expect(direct.status).toBe(200);
    expect(validateUiToolEntriesMock).not.toHaveBeenCalled();
    // streamWebChatTurn's uiTools plumbing stays (the agent route uses it),
    // so the key exists — but this route never populates the snapshot.
    let prepareArgs = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(prepareArgs.uiTools).toBeUndefined();

    // Scenario-bound turn: same silent-ignore treatment.
    const scenario = await postJson(
      app,
      "/api/web/chat-v2",
      { ...baseBody, scenarioId: "cbx_1", accessVersion: 1, surface: "preview" },
      token
    );
    expect(scenario.status).toBe(200);
    expect(validateUiToolEntriesMock).not.toHaveBeenCalled();
    prepareArgs = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(prepareArgs.uiTools).toBeUndefined();
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

  it("host-bound turn reads the enterprise-auth policy server-authoritatively — an invalid stored policy 409s regardless of the body", async () => {
    const { app, token } = createWebTestApp();
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        selectedServerIds: ["server-1"],
        mcpProfile: {
          profileVersion: 1,
          extensions: {
            "com.mcpjam/enterprise-managed-auth": { idp: "okta" },
          },
        },
      },
    });

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        hostId: "host-1",
        chatSessionId: "chat-host-policy",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic", name: "Haiku" },
        // The body says nothing about the policy — the stored host config is
        // authoritative, so the unsupported idp fails the turn closed.
      },
      token
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("unsupported enterprise-managed");
    expect(body.details?.reason).toBe("xaa_policy_invalid");
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("ad-hoc turn strictly validates a body-supplied enterprise-auth policy", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatSessionId: "chat-adhoc-policy",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic", name: "Haiku" },
        xaaPolicy: { idp: "okta" },
      },
      token
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("Unsupported enterprise-managed");
    expect(body.details?.reason).toBe("xaa_policy_invalid");
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the scenario runtime-config fetch fails — never runs the engine", async () => {
    const { app, token } = createWebTestApp();
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
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
        scenarioId: "cbx_1",
        accessVersion: 1,
        chatSessionId: "chat-cb-fail",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      },
      token
    );

    // The fetched config is the only source of harness/computer and of the
    // host-wins protections; falling back to body values would silently
    // downgrade a harness scenario and reopen the tampered-body window.
    // Pin the full status/code/message mapping so it can't regress silently:
    // upstream 5xx maps to 502 with the INTERNAL_ERROR envelope + the
    // upstream error surfaced in the message.
    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
    };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("Couldn't load this scenario's settings");
    expect(body.message).toContain("backend unreachable");
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("tags a 403 scenario runtime-config refusal as SCENARIO_ACCESS_DENIED", async () => {
    const { app, token } = createWebTestApp();
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Scenario not found or access denied",
    });

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_1",
        accessVersion: 1,
        chatSessionId: "chat-cb-denied",
        messages: [{ role: "user", content: "preview request" }],
        model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      },
      token
    );

    // 403 is an ACCESS verdict, not an internal fault. The dedicated code is
    // what lets the browser tell "re-redeem and retry" from "the server
    // broke" instead of classifying off message substrings.
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
    };
    expect(body.code).toBe("SCENARIO_ACCESS_DENIED");
    expect(body.message).toContain("Couldn't load this scenario's settings");
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("forwards the body's accessVersion so the backend can enforce it", async () => {
    const { app, token } = createWebTestApp();

    await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_1",
        accessVersion: 7,
        chatSessionId: "chat-cb-version",
        messages: [{ role: "user", content: "hi" }],
        model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      },
      token
    );

    expect(fetchScenarioRuntimeConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioId: "cbx_1", accessVersion: 7 })
    );
  });

  it("surfaces a stale-version refusal as 409 SCENARIO_ACCESS_STALE", async () => {
    const { app, token } = createWebTestApp();
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "SCENARIO_ACCESS_STALE",
      error: "Scenario access version is stale; re-redeem.",
    });

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_1",
        accessVersion: 1,
        chatSessionId: "chat-cb-stale",
        messages: [{ role: "user", content: "hi" }],
        model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
      },
      token
    );

    // Recoverable, and distinct from a denial: the client re-redeems and
    // replays the turn without the tester seeing anything.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("SCENARIO_ACCESS_STALE");
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("a scenario session ignores a stray hostId (scenario path wins)", async () => {
    const { app, token } = createWebTestApp();

    await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_1",
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

  it("passes shared scenario link context into the hosted model handler", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        scenarioId: "cbx_shared",
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
        scenarioId: "cbx_shared",
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
    // Membership chat (no share/scenario token) sends no accessScope — the
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
        modelVisibleMcpToolResults: resolvedImagePolicyMatcher(true),
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
    const persistArgs = persistChatSessionToConvexMock.mock.calls[0][0];
    expect(
      "modelVisibleMcpToolResults" in persistArgs.hostConfig
    ).toBe(false);
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
        modelVisibleMcpToolResults: imagePolicy(false),
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
        modelVisibleMcpToolResults: resolvedImagePolicyMatcher(false),
      })
    );
    expect(persistChatSessionToConvexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          modelVisibleMcpToolResults: resolvedImagePolicyMatcher(false),
        }),
        resumeConfig: expect.objectContaining({
          modelVisibleMcpToolResults: resolvedImagePolicyMatcher(false),
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
        modelVisibleMcpToolResults: imagePolicy(true),
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

  /**
   * The project pool on a target that resolves NO environment (host / adhoc).
   *
   * This is the arm the convergence rewired: it used to reach the orchestrator as
   * a `cloudSkills` option that chose one exclusive branch of a chain, and it now
   * arrives as a live capability set alongside every other origin. The three
   * cases below are the three the route can actually be in, and they differ in
   * ways that matter: an EMPTY catalog is authoritative, a FAILED one is not.
   */
  describe("hosted chat-v2 — the project skill catalog", () => {
    const bodyWithSkills = {
      projectId: "project-1",
      selectedServerIds: ["server-1"],
      chatSessionId: "chat-session-1",
      messages: [{ role: "user", content: "hi" }],
      model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
    };

    it("delivers a non-empty catalog as a live resolved source", async () => {
      listCloudRuntimeSkillsMock.mockResolvedValue([
        {
          skillId: "sk_1",
          ref: "release-notes",
          name: "release-notes",
          description: "Write release notes",
          aggregateHash: "agg_1",
          channels: [],
          content: async () => "# release-notes",
          files: [],
        },
      ]);
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        bodyWithSkills,
        token
      );
      expect(response.status).toBe(200);

      const args = prepareChatV2Mock.mock.calls.at(-1)![0];
      expect(args.skillsSource.kind).toBe("resolved");
      // Live, so a connected server's SEP-2640 skills compose on top rather than
      // being displaced by the project's.
      expect(args.skillsSource.composeLiveServerSkills).toBe(true);
      expect(
        args.skillsSource.capabilities.standaloneSkills.map(
          (skill: { ref: string }) => skill.ref
        )
      ).toEqual(["release-notes"]);
    });

    it("keeps an empty catalog authoritative rather than falling back", async () => {
      listCloudRuntimeSkillsMock.mockResolvedValue([]);
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        bodyWithSkills,
        token
      );
      expect(response.status).toBe(200);

      // "This project has no skills" is an answer, not a gap: the source is still
      // resolved and still live, it is simply empty.
      const args = prepareChatV2Mock.mock.calls.at(-1)![0];
      expect(args.skillsSource.kind).toBe("resolved");
      expect(args.skillsSource.capabilities.standaloneSkills).toEqual([]);
      expect(args.skillsSource.composeLiveServerSkills).toBe(true);
    });

    it("loses the turn's project skills, and nothing else, when the catalog fails", async () => {
      listCloudRuntimeSkillsMock.mockRejectedValue(new Error("convex down"));
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        bodyWithSkills,
        token
      );
      // Losing the skills must not lose the turn.
      expect(response.status).toBe(200);

      // No source at all is the LIVE shape: the orchestrator still composes the
      // connected servers' skills, which never failed. Collapsing to
      // `{ kind: "none" }` here would take those down with the project's.
      const args = prepareChatV2Mock.mock.calls.at(-1)![0];
      expect(args.skillsSource).toBeUndefined();
    });
  });

  /**
   * The Cursor CLI host seeds `modelId: "cursor/auto"` — a neutral sentinel.
   * The adapter passes NO model (`toNativeModel: () => undefined`) and Cursor
   * Auto picks one on the customer's own account, so the sentinel is the only
   * honest thing a Cursor turn can record.
   *
   * It could not survive the round trip. The Playground picker cannot hold the
   * sentinel (it is not in `availableModels`), so the browser sent whatever
   * model was last selected, and the non-scenario host-model override refused
   * to correct it — leaving the session row naming a model the turn never
   * touched, or nothing at all.
   */
  describe("an external-account harness host records ITS OWN model", () => {
    const cursorHost = {
      ok: true,
      config: {
        selectedServerIds: ["server-1"],
        modelId: "cursor/auto",
        harness: "cursor",
      },
    };

    it("persists the host's cursor/auto sentinel, not the browser's leftover pick", async () => {
      fetchHostRuntimeConfigMock.mockResolvedValue(cursorHost);
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        {
          projectId: "project-1",
          selectedServerIds: ["server-1"],
          hostId: "host-cursor",
          chatSessionId: "chat-cursor-1",
          messages: [{ role: "user", content: "preview request" }],
          // What the picker actually holds on a Cursor host: an unrelated
          // model, because the sentinel is not a selectable entry.
          model: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            name: "Haiku",
          },
        },
        token
      );

      expect(response.status).toBe(200);
      expect(persistChatSessionToConvexMock).toHaveBeenCalledTimes(1);
      const persisted = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
      // The sentinel — never blank, and never the Haiku id that nothing ran.
      expect(persisted.modelId).toBe("cursor/auto");
      // And not billed to MCPJam: the turn ran on the customer's Cursor account.
      expect(persisted.modelSource).toBe("external-account");
      expect(persisted.hostConfig?.modelId).toBe("cursor/auto");
    });

    it("routes the turn to the harness instead of demanding an org `cursor` provider key", async () => {
      fetchHostRuntimeConfigMock.mockResolvedValue(cursorHost);
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        {
          projectId: "project-1",
          selectedServerIds: ["server-1"],
          hostId: "host-cursor",
          chatSessionId: "chat-cursor-2",
          messages: [{ role: "user", content: "preview request" }],
          model: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            name: "Haiku",
          },
        },
        token
      );

      // `cursor/auto` is not an MCPJam-hosted model, so without the
      // external-account exemption this turn takes the org-BYOK branch and
      // asks Convex for a `cursor` provider key — which answers
      // `provider_not_configured: cursor`.
      expect(response.status).toBe(200);
      expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledTimes(1);
      const engineArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
      expect(engineArgs.harness).toBe("cursor");
      expect(engineArgs.modelId).toBe("cursor/auto");
    });

    it("leaves a NON-harness host's model to the body, as before", async () => {
      // The exemption is scoped to external-account harnesses. A Playground
      // preview of an ordinary host must keep letting the owner's in-session
      // model choice win — that is the whole point of `override-wins`.
      fetchHostRuntimeConfigMock.mockResolvedValue({
        ok: true,
        config: {
          selectedServerIds: ["server-1"],
          modelId: "openai/gpt-5-mini",
        },
      });
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        {
          projectId: "project-1",
          selectedServerIds: ["server-1"],
          hostId: "host-plain",
          chatSessionId: "chat-plain-1",
          messages: [{ role: "user", content: "preview request" }],
          model: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            name: "Haiku",
          },
        },
        token
      );

      expect(response.status).toBe(200);
      const persisted = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
      expect(persisted.modelId).toBe("anthropic/claude-haiku-4.5");
    });

    it("refuses a body whose model carries no id, rather than persisting a blank one", async () => {
      // The harness rail is the one live path with no downstream model-id
      // check (it skips both `deriveOrgProviderKey` and the harness model
      // gates), so an id-less body used to run a whole turn and write
      // `String(undefined)` / `""` into the session row.
      fetchHostRuntimeConfigMock.mockResolvedValue(cursorHost);
      const { app, token } = createWebTestApp();

      const response = await postJson(
        app,
        "/api/web/chat-v2",
        {
          projectId: "project-1",
          selectedServerIds: ["server-1"],
          hostId: "host-cursor",
          chatSessionId: "chat-cursor-3",
          messages: [{ role: "user", content: "preview request" }],
          model: { provider: "anthropic", name: "Haiku" },
        },
        token
      );

      expect(response.status).toBe(400);
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
      expect(persistChatSessionToConvexMock).not.toHaveBeenCalled();
    });
  });
});
