import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the ENVIRONMENT-BACKED SCENARIO half of web/chat-v2 (Phase 5,
// mcpjam-backend #805): when the scenario runtime config carries the additive
// `environment` payload, the turn runs on the environment's resolved server
// set and skill union — never the request body's — and a present-but-malformed
// payload stops the turn instead of silently falling back. An absent payload
// keeps the legacy host-backed behavior byte-identical.

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  fetchScenarioRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  convexQueryMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  fetchScenarioRuntimeConfigMock: vi.fn(),
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

vi.mock("../../../utils/scenario-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/scenario-runtime-config.js")
  >("../../../utils/scenario-runtime-config.js");
  // The route's parsing (`readScenarioEnvironment`) stays REAL — that is the
  // seam under test; only the network fetch is mocked.
  return {
    ...actual,
    fetchScenarioRuntimeConfig: fetchScenarioRuntimeConfigMock,
  };
});

vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import { createWebTestApp, postJson } from "./helpers/test-app.js";

/** The base (host-backed) scenario runtime config — no environment payload. */
const SCENARIO_CONFIG = {
  scenarioId: "cbx_env",
  accessVersion: 3,
  modelId: "openai/gpt-5-mini",
  systemPrompt: "scenario prompt",
  temperature: 0.7,
  requireToolApproval: false,
  hostStyle: "claude",
};

/** The additive payload an environment-backed scenario carries (backend #805). */
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
  scenarioId: "cbx_env",
  accessVersion: 3,
  // Deliberately WRONG/stale: an environment-backed scenario turn must ignore
  // this entirely; a host-backed one still honors it (legacy behavior).
  selectedServerIds: ["body-server-9"],
  selectedServerNames: ["body-server"],
  chatSessionId: "chat-session-1",
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

describe("web chat-v2 — environment-backed scenario", () => {
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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { ...SCENARIO_CONFIG, environment: ENVIRONMENT_PAYLOAD },
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

  it("records turn provenance — the isDirectChat gate must NOT swallow it", async () => {
    // THE BYPASS THIS PINS. `resumeConfig` and friends are merged only for a
    // direct chat, because they are the restorable-resume surface. Provenance
    // is not: a scenario turn runs through an environment too, and gating it
    // the same way would leave User Testing — the most environment-driven
    // surface there is — with no record of what it ran.
    const PROVENANCE = {
      skillId: "sk_env",
      projectSkillVersionNumber: 3,
      versionPinned: true,
      name: "release-notes",
      contentHash: "h_env",
      sharing: "project",
      channels: ["environment"],
    };
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
        environment: {
          ...ENVIRONMENT_PAYLOAD,
          skills: [
            { ...ENVIRONMENT_PAYLOAD.skills[0], provenance: PROVENANCE },
          ],
        },
      },
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    // A scenario turn: no resumeConfig (the gate is still doing its job)…
    expect(persistArgs.resumeConfig).toBeUndefined();
    // …and provenance regardless.
    expect(persistArgs.turnTrace.environmentAtTurn).toEqual({
      environmentId: "env_1",
      name: "Staging",
      revision: 7,
    });
    expect(persistArgs.turnTrace.skillsAtTurn).toEqual([PROVENANCE]);
  });

  it("drops a malformed provenance entry without failing the turn", async () => {
    // Tolerant pass-through: losing a provenance LABEL must never cost a turn.
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
        environment: {
          ...ENVIRONMENT_PAYLOAD,
          skills: [
            { ...ENVIRONMENT_PAYLOAD.skills[0], provenance: "not an object" },
          ],
        },
      },
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    expect(persistArgs.turnTrace.skillsAtTurn).toEqual([]);
    expect(persistArgs.turnTrace.environmentAtTurn).toBeDefined();
    // Delivery is unaffected — the skill still reaches the engine.
    const args = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(args.skillsSource.capabilities.standaloneSkills).toHaveLength(1);
  });

  it("a HOST-backed scenario records nothing — there is no environment", async () => {
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: SCENARIO_CONFIG,
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    expect(persistArgs.turnTrace.environmentAtTurn).toBeUndefined();
    expect(persistArgs.turnTrace.skillsAtTurn).toBeUndefined();
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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
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

  it("keeps a host-backed scenario (no payload) byte-identical to today", async () => {
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: SCENARIO_CONFIG,
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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "boom",
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(502);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
  });

  // ── Phase 6.1: plugin provenance from the payload's pinned versions ──────

  /** The pinned version the payload carries once mcpjam-backend serves it. */
  const PINNED_VERSION = {
    pluginId: "pl_1",
    pluginVersionId: "pv_1",
    name: "linear-tools",
    bundleHash: "hash_1",
  };

  it("attributes plugin origin when the payload pins versions and the probe answers", async () => {
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
        environment: {
          ...ENVIRONMENT_PAYLOAD,
          pluginVersions: [PINNED_VERSION],
        },
      },
    });
    convexQueryMock.mockImplementation(async (ref: string) => {
      if (ref === "plugins:resolvePluginRuntimePreview") {
        return {
          pluginVersions: [PINNED_VERSION],
          effectiveServerIds: ["env-server-2"],
          serverComponents: [
            {
              pluginVersionId: "pv_1",
              componentKey: "server:asana",
              placement: "remote",
              authenticationPolicy: "on_use",
              materializedServerId: "env-server-2",
            },
          ],
          pluginSkills: [],
          unavailableComponents: [],
        };
      }
      throw new Error(`Unexpected convex query: ${ref}`);
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    expect(convexQueryMock).toHaveBeenCalledWith(
      "plugins:resolvePluginRuntimePreview",
      { projectId: "project-1", pluginVersionIds: ["pv_1"] }
    );

    const capabilities =
      prepareChatV2Mock.mock.calls.at(-1)![0].skillsSource.capabilities;
    expect(capabilities.problems).toEqual([]);
    expect(
      capabilities.servers.find(
        (server: { serverId: string }) => server.serverId === "env-server-2"
      ).plugin
    ).toEqual(PINNED_VERSION);
  });

  it("degrades to no origin when the probe fails — the turn still runs", async () => {
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...SCENARIO_CONFIG,
        environment: {
          ...ENVIRONMENT_PAYLOAD,
          pluginVersions: [PINNED_VERSION],
        },
      },
    });
    // The member-gated probe rejecting is exactly what a guest turn sees.
    convexQueryMock.mockRejectedValue(new Error("Not a member of this project"));

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    const capabilities =
      prepareChatV2Mock.mock.calls.at(-1)![0].skillsSource.capabilities;
    expect(
      capabilities.problems.map((problem: { code: string }) => problem.code)
    ).toEqual(["plugin_origin_unavailable"]);
    // Classification survives (`source: "plugin"`); only the version label is
    // unreported.
    expect(capabilities.pluginServerIds).toEqual(["env-server-2"]);
    expect(
      capabilities.servers.find(
        (server: { serverId: string }) => server.serverId === "env-server-2"
      ).plugin
    ).toBeUndefined();
  });

  it("adds no probe read when the payload pins no versions", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});
