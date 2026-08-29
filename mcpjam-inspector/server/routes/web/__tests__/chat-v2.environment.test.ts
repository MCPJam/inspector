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

// Spread the REAL module: this suite exercises the environment-TARGET path,
// which never fetches a scenario config, but chat-v2 imports several pure
// readers from here. A bare factory would leave those undefined and 500 the
// route for a reason that has nothing to do with what is under test.
vi.mock("../../../utils/scenario-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/scenario-runtime-config.js")
  >("../../../utils/scenario-runtime-config.js");
  return { ...actual, fetchScenarioRuntimeConfig: fetchScenarioRuntimeConfigMock };
});

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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
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

  it("400s scenarioId + executionTarget instead of silently picking one", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        scenarioId: "cbx_1",
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
    expect(fetchScenarioRuntimeConfigMock).not.toHaveBeenCalled();
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
    // INS-4: "asana" is the PLUGIN-contributed server. It ran this turn, but
    // `resumeConfig` is a durable reconnect instruction replayed with no
    // plugin lifecycle check — a plugin server belongs to its environment at
    // launch, never to a stored session list.
    expect(persistArgs.resumeConfig.selectedServers).toEqual(["linear"]);
    expect(JSON.stringify(persistArgs)).not.toContain("body-server-9");
  });

  it("injects blueprint context into the turn prompt but persists the RAW prompt in resumeConfig", async () => {
    const RUNTIME_CONTEXT = {
      imageName: "staging-box",
      knowledge: [{ name: "Setup", contents: "Use pnpm, not npm." }],
      maintenance: [{ name: "deps", run: "pnpm install" }],
    };
    // Same environment spec, now booting from a blueprint image: a `bash`
    // built-in on a personal computer is what makes the turn advertise bash
    // and trigger the runtime-context fetch.
    const SPEC_WITH_BASH = {
      ...ENV_SPEC,
      host: {
        ...ENV_SPEC.host,
        runtimeConfig: {
          ...ENV_SPEC.host.runtimeConfig,
          builtInToolIds: ["bash"],
          computer: { kind: "personal" },
        },
      },
    };
    convexQueryMock.mockImplementation(async (ref: string) =>
      ref === "computerEnvironments:getEnvironmentRuntimeContext"
        ? RUNTIME_CONTEXT
        : SPEC_WITH_BASH
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
    expect(response.status).toBe(200);

    // bash advertised ⇒ the image's runtime context is fetched for this turn.
    expect(convexQueryMock).toHaveBeenCalledWith(
      "computerEnvironments:getEnvironmentRuntimeContext",
      { projectId: "project-1" }
    );

    // The MODEL-facing prompt for THIS turn carries the injected image block,
    // appended after the resolved host prompt.
    const prepareArgs = prepareChatV2Mock.mock.calls.at(-1)![0];
    expect(prepareArgs.systemPrompt).toContain("## Computer image: staging-box");
    expect(prepareArgs.systemPrompt).toContain("Use pnpm, not npm.");
    expect(prepareArgs.systemPrompt.startsWith("environment prompt")).toBe(true);

    // The PERSISTED resume config keeps the RAW user prompt — a resumed turn
    // re-injects fresh context, so baking this turn's block in would leave
    // stale image context and double-append on resume.
    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    expect(persistArgs.resumeConfig.systemPrompt).toBe("environment prompt");
    expect(persistArgs.resumeConfig.systemPrompt).not.toContain(
      "Computer image"
    );
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
        // This suite runs un-hosted; the service declares the local venue.
        runtimeVenue: "local",
      }
    );
  });

  it("narrows to the retained plugin versions without touching the backend query", async () => {
    // The attribution probe is what supplies the version → server edge the
    // narrowing needs; without it the turn fails closed rather than keeping a
    // switched-off plugin's server.
    convexQueryMock.mockImplementation(async (ref: string) =>
      ref === "plugins:resolvePluginRuntimePreview"
        ? {
            pluginVersions: [ENV_SPEC.pluginVersions[0]],
            effectiveServerIds: ["env-server-2"],
            serverComponents: [
              {
                pluginVersionId: ENV_SPEC.pluginVersions[0].pluginVersionId,
                componentKey: "server:asana",
                placement: "remote",
                authenticationPolicy: "on_use",
                materializedServerId: "env-server-2",
              },
            ],
            pluginSkills: [],
            unavailableComponents: [],
          }
        : ENV_SPEC
    );
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
        // "run this turn with none of the environment's plugins".
        environmentOverrides: { pluginVersionIds: [] },
      },
      token
    );
    expect(response.status).toBe(200);

    // The narrowing is applied to the RESOLVED spec: the deployed query takes
    // no plugin argument, and sending one would fail its validator.
    expect(convexQueryMock).toHaveBeenCalledWith(
      "projectEnvironments:resolveEnvironmentForRuntime",
      { projectId: "project-1", environmentId: "env_1", runtimeVenue: "local" }
    );

    // The plugin's server is gone from the turn; the host's own remains.
    expect(prepareChatV2Mock.mock.calls.at(-1)![0].selectedServers).toEqual([
      "env-server-1",
    ]);
  });

  it("rejects a plugin version the environment does not pin", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
        environmentOverrides: { pluginVersionIds: ["pv_1", "pv_not_pinned"] },
      },
      token
    );
    // An override is a request, not a grant.
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/can only narrow/i);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
  });

  it("stops the turn when a deselected plugin's components can't be identified", async () => {
    // Probe reports the version as unavailable ⇒ no attribution for it. The
    // honest outcomes are "run everything the user just switched off" or
    // "stop"; we stop.
    convexQueryMock.mockImplementation(async (ref: string) =>
      ref === "plugins:resolvePluginRuntimePreview"
        ? {
            pluginVersions: [],
            effectiveServerIds: [],
            serverComponents: [],
            pluginSkills: [],
            unavailableComponents: [
              { pluginVersionId: "pv_1", reason: "disabled" },
            ],
          }
        : ENV_SPEC
    );
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...BASE_BODY,
        executionTarget: { kind: "environment", environmentId: "env_1" },
        environmentOverrides: { pluginVersionIds: [] },
      },
      token
    );
    expect(response.status).toBe(409);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
  });

  it("delivers ONLY the resolved skills to the emulated engine (no cloudSkills)", async () => {
    // The attribution probe answers the single-call shape: pv_1 contributed
    // env-server-2 and no skills, so the capability set carries no plugin
    // skills and no problems.
    convexQueryMock.mockImplementation(async (ref: string) =>
      ref === "plugins:resolvePluginRuntimePreview"
        ? {
            pluginVersions: [ENV_SPEC.pluginVersions[0]],
            effectiveServerIds: ["env-server-2"],
            serverComponents: [
              {
                pluginVersionId: ENV_SPEC.pluginVersions[0].pluginVersionId,
                componentKey: "server:asana",
                placement: "remote",
                authenticationPolicy: "on_use",
                materializedServerId: "env-server-2",
              },
            ],
            pluginSkills: [],
            unavailableComponents: [],
          }
        : ENV_SPEC
    );
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
    // INS-3: the emulated engine now receives the whole EffectiveCapabilitySet
    // rather than a flat skill list, because its tools address skills by REF
    // (`<plugin>/<skill>` for a plugin skill). This environment pins no
    // plugins, so the one resolved skill is standalone and its ref is its name.
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
    expect(args.skillsSource.capabilities.pluginSkills).toEqual([]);
    expect(args.skillsSource.capabilities.problems).toEqual([]);
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

// INS-3: a turn whose environment pins plugins must be able to SAY where each
// server and skill came from. The runtime spec carries the pins and the plugin
// server ids as two flat lists with no edge between them, so the route asks the
// per-version probe to recover it — and must degrade, never fail, if it can't.
describe("web chat-v2 — plugin capability attribution", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;
  const originalFetch = global.fetch;

  const PLUGIN_SPEC = {
    ...ENV_SPEC,
    skills: [
      {
        skillId: "sk_plugin",
        name: "summarize",
        description: "Summarize",
        content: "plugin skill body",
        aggregateHash: "agg_plugin",
        channels: ["plugin"],
        files: [],
      },
    ],
  };

  const PREVIEW_RESPONSE = {
    pluginVersions: [
      {
        pluginId: "pl_1",
        pluginVersionId: "pv_1",
        name: "linear",
        bundleHash: "abc",
      },
    ],
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
    pluginSkills: [
      {
        pluginVersionId: "pv_1",
        modelRef: "linear/summarize",
        materializedSkillId: "sk_plugin",
      },
    ],
    unavailableComponents: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    handleMCPJamFreeChatModelMock.mockResolvedValue(
      new Response("ok", { status: 200 })
    );
    global.fetch = vi.fn(async (input: any, init: any) => {
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
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // `delete` on absent, never assignment: Node coerces an assigned
    // `undefined` to the literal string "undefined", which a later test in the
    // same worker would happily build a Convex client against.
    if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvexUrl;
  });

  it("namespaces the plugin skill and attributes its server to the pinned version", async () => {
    convexQueryMock.mockImplementation(async (ref: string) =>
      ref === "plugins:resolvePluginRuntimePreview"
        ? PREVIEW_RESPONSE
        : PLUGIN_SPEC
    );
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

    const capabilities =
      prepareChatV2Mock.mock.calls.at(-1)![0].skillsSource.capabilities;
    expect(capabilities.pluginSkills).toEqual([
      expect.objectContaining({
        ref: "linear/summarize",
        content: "plugin skill body",
        plugin: expect.objectContaining({
          pluginVersionId: "pv_1",
          bundleHash: "abc",
        }),
      }),
    ]);
    expect(capabilities.standaloneSkills).toEqual([]);
    expect(capabilities.explicitServerIds).toEqual(["env-server-1"]);
    expect(capabilities.pluginServerIds).toEqual(["env-server-2"]);
    expect(
      capabilities.servers.find((s: any) => s.serverId === "env-server-2")
        .plugin.name
    ).toBe("linear");
    expect(capabilities.problems).toEqual([]);
  });

  it("still runs the turn — with origin unreported — when the probe fails", async () => {
    convexQueryMock.mockImplementation(async (ref: string) => {
      if (ref === "plugins:resolvePluginRuntimePreview") {
        throw new Error("Could not find public function");
      }
      return PLUGIN_SPEC;
    });
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
    const capabilities =
      prepareChatV2Mock.mock.calls.at(-1)![0].skillsSource.capabilities;
    // The server set is untouched; only what we can SAY about it degraded.
    expect(capabilities.pluginServerIds).toEqual(["env-server-2"]);
    expect(capabilities.pluginSkills[0].ref).toBe("summarize");
    expect(capabilities.pluginSkills[0].plugin).toBeUndefined();
    expect(capabilities.problems.map((p: any) => p.code)).toEqual([
      "plugin_origin_unavailable",
      "plugin_skill_ref_unavailable",
    ]);
  });
});

describe("web chat-v2 — turn provenance (P1)", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  const PROVENANCE = {
    skillId: "sk_env",
    projectSkillVersionId: "psv_1",
    projectSkillVersionNumber: 3,
    versionPinned: true,
    name: "release-notes",
    description: "Write release notes",
    contentHash: "h_env",
    sharing: "project",
    channels: ["environment"],
  };
  const SPEC_WITH_PROVENANCE = {
    ...ENV_SPEC,
    skills: [{ ...ENV_SPEC.skills[0], provenance: PROVENANCE }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchHostRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
    fetchScenarioRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
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
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Delete rather than assign when the var was absent: assigning `undefined`
    // stores the literal string "undefined", which leaks into later suites as
    // a truthy Convex URL. The two describe blocks above already do this.
    if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvexUrl;
  });

  async function runEnvironmentTurn() {
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
    return persistChatSessionToConvexMock.mock.calls.at(-1)![0];
  }

  it("records the environment and its skill rows on the turn trace", async () => {
    convexQueryMock.mockResolvedValue(SPEC_WITH_PROVENANCE);
    const persistArgs = await runEnvironmentTurn();
    expect(persistArgs.turnTrace.environmentAtTurn).toEqual({
      environmentId: "env_1",
      name: "Staging",
      revision: 7,
    });
    expect(persistArgs.turnTrace.skillsAtTurn).toEqual([PROVENANCE]);
    // The rest of the trace is untouched — provenance is merged onto it, not
    // substituted for it.
    expect(persistArgs.turnTrace.turnId).toBe("t");
    expect(persistArgs.turnTrace.spans).toEqual([]);
  });

  it("records a delivered CAPTURED server skill alongside the authored ones", async () => {
    // End-to-end wiring for the helper's serverSkills branch: a captured
    // MCP-server skill reaches the model through the same capability set as an
    // authored one, so it must appear in the record of what ran.
    const CAPTURE_PROVENANCE = {
      serverSkillId: "ss_1",
      serverSkillVersionId: "ssv_1",
      serverSkillVersionNumber: 2,
      name: "refunds",
      modelRef: "acme/refunds",
      contentHash: "h_capture",
      sharing: "project",
      channels: ["mcp-server"],
    };
    convexQueryMock.mockResolvedValue({
      ...SPEC_WITH_PROVENANCE,
      serverSkills: [
        {
          serverSkillId: "ss_1",
          versionId: "ssv_1",
          serverId: "env-server-1",
          serverSlug: "acme",
          serverLabel: "Acme",
          ref: "acme/refunds",
          skillUri: "skill://acme/refunds/SKILL.md",
          name: "refunds",
          description: "Handle refunds",
          content: "captured body",
          contentSha256: "raw-digest",
          contentHash: "h_capture",
          versionHash: "vh_1",
          versionNumber: 2,
          capturedAt: 1,
          provenance: CAPTURE_PROVENANCE,
          files: [],
        },
      ],
    });

    const persistArgs = await runEnvironmentTurn();
    expect(persistArgs.turnTrace.skillsAtTurn).toEqual([
      PROVENANCE,
      CAPTURE_PROVENANCE,
    ]);
  });

  it("never carries skill CONTENT into the record", async () => {
    convexQueryMock.mockResolvedValue(SPEC_WITH_PROVENANCE);
    const persistArgs = await runEnvironmentTurn();
    expect(JSON.stringify(persistArgs.turnTrace)).not.toContain(
      "env skill body"
    );
  });

  it("records an empty skill list rather than going silent, on an older backend", async () => {
    // Deploy skew: the backend resolves skills but attaches no provenance
    // rows. The turn still records WHICH environment ran — the part this side
    // can prove — and claims nothing about skills it cannot describe.
    convexQueryMock.mockResolvedValue(ENV_SPEC);
    const persistArgs = await runEnvironmentTurn();
    expect(persistArgs.turnTrace.environmentAtTurn).toEqual({
      environmentId: "env_1",
      name: "Staging",
      revision: 7,
    });
    expect(persistArgs.turnTrace.skillsAtTurn).toEqual([]);
  });

  it("a direct turn with no environment records nothing", async () => {
    convexQueryMock.mockResolvedValue(ENV_SPEC);
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      { ...BASE_BODY, hostId: "host_legacy" },
      token
    );
    expect(response.status).toBe(200);
    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    expect(persistArgs.turnTrace.environmentAtTurn).toBeUndefined();
    expect(persistArgs.turnTrace.skillsAtTurn).toBeUndefined();
  });
});
