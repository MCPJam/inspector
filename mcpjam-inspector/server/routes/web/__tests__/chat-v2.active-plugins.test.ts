import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// A HOST-target Playground turn runs the project's ACTIVE plugins: the
// backend's `plugins:resolveActivePlugins` is read every turn, plugin servers
// join the turn's set (never from the body), plugin skills join the one
// merged skill surface, and anything skipped is said once in a notice.
// Environment turns are untouched.

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  persistChatSessionToConvexMock,
  convexQueryMock,
  readActivePluginsMock,
  listCloudRuntimeSkillsMock,
  checkHarnessRuntimeAvailableMock,
  ensureConnectedMock,
  removeServerMock,
  managerConfigs,
  setPluginOriginMock,
  writtenParts,
  hostedMode,
  validateGuestTokenMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  convexQueryMock: vi.fn(),
  readActivePluginsMock: vi.fn(),
  listCloudRuntimeSkillsMock: vi.fn(),
  checkHarnessRuntimeAvailableMock: vi.fn(),
  ensureConnectedMock: vi.fn(),
  removeServerMock: vi.fn(),
  managerConfigs: [] as Array<Record<string, unknown>>,
  setPluginOriginMock: vi.fn(),
  writtenParts: [] as unknown[],
  hostedMode: { value: false },
  validateGuestTokenMock: vi.fn(),
}));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode.value;
    },
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock(
  "../../../services/plugins/active-plugins.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/plugins/active-plugins.js")
      >();
    return { ...actual, readActivePlugins: readActivePluginsMock };
  },
);

vi.mock(
  "../../../utils/harness/local/readiness.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../utils/harness/local/readiness.js")
    >()),
    localHarnessAccountEnabled: vi.fn(async () => false),
  }),
);

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
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation((configs) => {
      managerConfigs.push(configs);
      return {
        disconnectAllServers: vi.fn(),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        readResource: vi.fn().mockResolvedValue({ contents: [] }),
        ensureSkillsSupport: ensureConnectedMock,
        removeServer: removeServerMock,
        getInitializationInfo: vi.fn(),
      };
    }),
  };
});

vi.mock("../hosted-rpc-logs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hosted-rpc-logs.js")>();
  return {
    ...actual,
    createHostedRpcLogCollector: (
      ...args: Parameters<typeof actual.createHostedRpcLogCollector>
    ) => {
      const collector = actual.createHostedRpcLogCollector(...args);
      const original = collector.setPluginOriginByServerId.bind(collector);
      collector.setPluginOriginByServerId = (origins) => {
        setPluginOriginMock(origins);
        original(origins);
      };
      return collector;
    },
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

vi.mock("../../../utils/harness/harness-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-availability.js")
  >("../../../utils/harness/harness-availability.js");
  return {
    ...actual,
    checkHarnessRuntimeAvailable: checkHarnessRuntimeAvailableMock,
  };
});

vi.mock("../apps.js", () => ({ default: new Hono() }));

import { parseActivePluginsResponse } from "../../../services/plugins/active-plugins.js";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

/** The contract's `ActivePluginsResult`, as the backend returns it. */
function activeResult(overrides: Record<string, unknown> = {}) {
  const bits = {
    pluginId: "pl_bits",
    pluginVersionId: "pv_bits",
    name: "bits",
    bundleHash: "hash_bits",
  };
  return {
    enabled: true,
    pluginVersions: [bits],
    servers: {
      selectedServerIds: [],
      pluginServerIds: ["plugin-server-1"],
      baseEffectiveServerIds: ["plugin-server-1"],
      effectiveServerIds: ["plugin-server-1"],
      connectable: [
        { serverId: "plugin-server-1", name: "bits-server", source: "plugin" },
      ],
    },
    skills: [
      {
        skillId: "sk_plugin",
        name: "keycaps",
        description: "Pick a keycap",
        content: "plugin skill body",
        aggregateHash: "agg_plugin",
        channels: ["plugin"],
        provenance: { modelRef: "bits/keycaps" },
        files: [
          {
            path: "references/sizes.md",
            size: 12,
            url: "https://signed/sizes",
          },
        ],
      },
    ],
    serverSkills: [],
    attribution: {
      pluginVersions: [bits],
      effectiveServerIds: ["plugin-server-1"],
      serverComponents: [
        {
          pluginVersionId: "pv_bits",
          componentKey: "server",
          placement: "remote",
          authenticationPolicy: "on_use",
          materializedServerId: "plugin-server-1",
        },
      ],
      pluginSkills: [
        {
          pluginVersionId: "pv_bits",
          modelRef: "bits/keycaps",
          materializedSkillId: "sk_plugin",
        },
      ],
      unavailableComponents: [],
    },
    plugins: [
      {
        pluginId: "pl_bits",
        pluginVersionId: "pv_bits",
        name: "bits",
        displayName: "Bits & Bolts",
        status: "active",
        servers: [
          {
            serverId: "plugin-server-1",
            name: "bits-server",
            componentKey: "server",
            placement: "remote",
          },
        ],
        skills: [
          {
            skillId: "sk_plugin",
            modelRef: "bits/keycaps",
            name: "keycaps",
            description: "Pick a keycap",
          },
        ],
      },
      {
        pluginId: "pl_auth",
        pluginVersionId: "pv_auth",
        name: "needsauth",
        displayName: null,
        status: "skipped",
        reason: "needs_auth",
        componentKey: "server",
        servers: [
          {
            serverId: "plugin-server-auth",
            name: "auth-server",
            componentKey: "server",
            placement: "remote",
          },
        ],
        skills: [],
      },
      {
        pluginId: "pl_off",
        pluginVersionId: "pv_off",
        name: "off",
        displayName: null,
        status: "skipped",
        reason: "disabled",
        servers: [
          {
            serverId: "plugin-server-off",
            name: "off-server",
            componentKey: "server",
            placement: "remote",
          },
        ],
        skills: [],
      },
    ],
    ...overrides,
  };
}

const STANDALONE_SKILL = {
  ref: "release-notes",
  skillId: "sk_standalone",
  name: "release-notes",
  description: "Write release notes",
  content: "standalone body",
  aggregateHash: "agg_standalone",
  files: [],
  channels: [],
};

const BASE_BODY = {
  projectId: "project-1",
  hostId: "host_1",
  selectedServerIds: ["body-server-1"],
  selectedServerNames: ["linear"],
  chatSessionId: "chat-session-1",
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

/** Per-server authorize results; anything not listed authorizes. */
let authorizeOverrides: Record<string, Record<string, unknown>> = {};

function authorizeCalls(): string[][] {
  return (global.fetch as any).mock.calls
    .filter(([url]: [string]) => String(url).endsWith("/web/authorize-batch"))
    .map(
      ([, init]: [string, RequestInit]) =>
        JSON.parse(String(init.body)).serverIds,
    );
}

function lastPrepare() {
  return prepareChatV2Mock.mock.calls.at(-1)![0];
}

function pluginNotices() {
  return writtenParts.filter(
    (part) => (part as { type?: string }).type === "data-plugin-notice",
  ) as Array<{ type: string; transient: boolean; data: any }>;
}

async function send(body: Record<string, unknown> = {}) {
  const { app, token } = createWebTestApp();
  return postJson(app, "/api/web/chat-v2", { ...BASE_BODY, ...body }, token);
}

describe("web chat-v2 — a host turn's active plugins", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    managerConfigs.length = 0;
    writtenParts.length = 0;
    hostedMode.value = false;
    authorizeOverrides = {};
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";

    validateGuestTokenMock.mockImplementation(async (token: string) =>
      token === "guest-jwt"
        ? { valid: true, guestId: "guest-1" }
        : { valid: false, reason: "not_guest" },
    );
    readActivePluginsMock.mockResolvedValue(
      parseActivePluginsResponse(activeResult()),
    );
    listCloudRuntimeSkillsMock.mockResolvedValue([STANDALONE_SKILL]);
    checkHarnessRuntimeAvailableMock.mockReturnValue({ ok: true });
    ensureConnectedMock.mockResolvedValue({ active: false });
    removeServerMock.mockResolvedValue(undefined);
    convexQueryMock.mockResolvedValue(null);
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: "host_1", hostStyle: "claude" },
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({
        write: (part: unknown) => writtenParts.push(part),
      });
      await options.onConversationComplete?.(
        [{ role: "user", content: "hi" }],
        {
          turnId: "t",
          promptIndex: 0,
          startedAt: 1,
          endedAt: 2,
          spans: [],
          modelId: "test-model",
        },
      );
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    global.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("/web/authorize-project")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (String(input).endsWith("/web/authorize-batch")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const serverIds: string[] = payload.serverIds ?? [];
        return new Response(
          JSON.stringify({
            results: Object.fromEntries(
              serverIds.map((serverId) => [
                serverId,
                authorizeOverrides[serverId] ?? {
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
              ]),
            ),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
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

  it("connects the active plugin's server, offers <plugin>/<skill> beside the project's skills, and keeps plugins out of the host config and resume list", async () => {
    const response = await send();
    expect(response.status).toBe(200);

    // Read once, for this project, with bodies and signed URLs.
    expect(readActivePluginsMock).toHaveBeenCalledTimes(1);
    expect(readActivePluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runtimeVenue: "local",
      }),
    );

    // The authorize batch: the body's server, then the plugin's.
    expect(authorizeCalls()).toEqual([["body-server-1", "plugin-server-1"]]);
    expect(Object.keys(managerConfigs[0]!)).toEqual([
      "body-server-1",
      "plugin-server-1",
    ]);
    // The plugin's connection was awaited before tools were listed.
    expect(ensureConnectedMock).toHaveBeenCalledWith("plugin-server-1");
    expect(removeServerMock).not.toHaveBeenCalled();

    const prepare = lastPrepare();
    expect(prepare.selectedServers).toEqual([
      "body-server-1",
      "plugin-server-1",
    ]);
    // ONE merged surface: standalone + plugin, ref-addressed, still live.
    expect(prepare.skillsSource.kind).toBe("resolved");
    expect(prepare.skillsSource.composeLiveServerSkills).toBe(true);
    const capabilities = prepare.skillsSource.capabilities;
    expect(capabilities.standaloneSkills.map((s: any) => s.ref)).toEqual([
      "release-notes",
    ]);
    expect(capabilities.pluginSkills.map((s: any) => s.ref)).toEqual([
      "bits/keycaps",
    ]);
    expect(capabilities.pluginSkills[0].files).toEqual([
      { path: "references/sizes.md", size: 12, url: "https://signed/sizes" },
    ]);
    expect(capabilities.pluginVersions).toEqual([
      {
        pluginId: "pl_bits",
        pluginVersionId: "pv_bits",
        name: "bits",
        bundleHash: "hash_bits",
      },
    ]);

    // Plugin origin on the turn's RPC frames.
    expect(setPluginOriginMock).toHaveBeenCalledWith({
      "plugin-server-1": {
        pluginId: "pl_bits",
        pluginVersionId: "pv_bits",
        name: "bits",
        bundleHash: "hash_bits",
      },
    });

    const persistArgs = persistChatSessionToConvexMock.mock.calls[0]![0];
    // The trace's host config names the user's server only.
    expect(persistArgs.hostConfig.selectedServerIds).toEqual(["body-server-1"]);
    // Resume list: names (ids and names stayed aligned), plugin left out.
    expect(persistArgs.resumeConfig.selectedServers).toEqual(["linear"]);
    expect(JSON.stringify(persistArgs.resumeConfig)).not.toContain(
      "plugin-server-1",
    );
    expect(JSON.stringify(persistArgs.resumeConfig)).not.toContain(
      "bits-server",
    );
  });

  it("says once which plugins it skipped, never a disabled one, and runs the rest", async () => {
    const response = await send();
    expect(response.status).toBe(200);
    const notices = pluginNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      type: "data-plugin-notice",
      transient: true,
      data: {
        kind: "skipped",
        plugins: [
          {
            pluginId: "pl_auth",
            name: "needsauth",
            displayName: null,
            reason: "needs_auth",
          },
        ],
      },
    });
    // A skipped plugin's server is never connected.
    expect(authorizeCalls().flat()).not.toContain("plugin-server-auth");
  });

  it("strips plugin server ids a body names, active or skipped, and adds them only from the resolver", async () => {
    const response = await send({
      selectedServerIds: [
        "plugin-server-auth",
        "body-server-1",
        "plugin-server-1",
        "plugin-server-off",
      ],
      selectedServerNames: [
        "auth-server",
        "linear",
        "bits-server",
        "off-server",
      ],
    });
    expect(response.status).toBe(200);
    expect(authorizeCalls()).toEqual([["body-server-1", "plugin-server-1"]]);
    expect(lastPrepare().selectedServers).toEqual([
      "body-server-1",
      "plugin-server-1",
    ]);
    expect(
      persistChatSessionToConvexMock.mock.calls[0]![0].resumeConfig
        .selectedServers,
    ).toEqual(["linear"]);
  });

  it("runs without plugins and says so when the read fails", async () => {
    readActivePluginsMock.mockResolvedValue({
      status: "unavailable",
      error: "boom",
    });
    const response = await send();
    expect(response.status).toBe(200);
    expect(authorizeCalls()).toEqual([["body-server-1"]]);
    const prepare = lastPrepare();
    expect(prepare.selectedServers).toEqual(["body-server-1"]);
    expect(prepare.skillsSource.capabilities.pluginSkills).toEqual([]);
    expect(pluginNotices().map((part) => part.data)).toEqual([
      { kind: "unavailable", plugins: [] },
    ]);
  });

  it.each([
    ["the backend has no such function", { status: "off" }],
    ["the gate is off", parseActivePluginsResponse({ enabled: false })],
  ])("is silent and unchanged when %s", async (_label, read) => {
    readActivePluginsMock.mockResolvedValue(read);
    const response = await send();
    expect(response.status).toBe(200);
    expect(authorizeCalls()).toEqual([["body-server-1"]]);
    const prepare = lastPrepare();
    expect(prepare.selectedServers).toEqual(["body-server-1"]);
    expect(prepare.skillsSource.capabilities.pluginSkills).toEqual([]);
    expect(
      prepare.skillsSource.capabilities.standaloneSkills.map((s: any) => s.ref),
    ).toEqual(["release-notes"]);
    expect(pluginNotices()).toEqual([]);
    expect(setPluginOriginMock).not.toHaveBeenCalled();
    expect(ensureConnectedMock).not.toHaveBeenCalled();
  });

  it("keeps the skill surface live when the project catalog read failed", async () => {
    listCloudRuntimeSkillsMock.mockRejectedValue(new Error("catalog down"));
    const response = await send();
    expect(response.status).toBe(200);
    const source = lastPrepare().skillsSource;
    expect(source.composeLiveServerSkills).toBe(true);
    expect(source.capabilities.standaloneSkills).toEqual([]);
    expect(source.capabilities.pluginSkills.map((s: any) => s.ref)).toEqual([
      "bits/keycaps",
    ]);
  });

  it("drops a plugin whose server does not connect, says so, and runs the rest", async () => {
    ensureConnectedMock.mockImplementation(async (key: string) => {
      if (key === "plugin-server-1") throw new Error("ECONNREFUSED");
      return { active: false };
    });
    const response = await send();
    expect(response.status).toBe(200);
    expect(removeServerMock).toHaveBeenCalledWith("plugin-server-1");
    const prepare = lastPrepare();
    expect(prepare.selectedServers).toEqual(["body-server-1"]);
    // The plugin left whole: its skill went with its server.
    expect(prepare.skillsSource.capabilities.pluginSkills ?? []).toEqual([]);
    expect(pluginNotices()[0]!.data).toEqual({
      kind: "skipped",
      plugins: [
        expect.objectContaining({ pluginId: "pl_auth", reason: "needs_auth" }),
        {
          pluginId: "pl_bits",
          name: "bits",
          displayName: "Bits & Bolts",
          reason: "connect_failed",
        },
      ],
    });
    expect(
      persistChatSessionToConvexMock.mock.calls[0]![0].resumeConfig
        .selectedServers,
    ).toEqual(["linear"]);
  });

  it("drops a plugin whose server is refused at authorization", async () => {
    authorizeOverrides["plugin-server-1"] = {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "This plugin is disabled.",
    };
    const response = await send();
    expect(response.status).toBe(200);
    expect(Object.keys(managerConfigs[0]!)).toEqual(["body-server-1"]);
    expect(lastPrepare().selectedServers).toEqual(["body-server-1"]);
    expect(
      pluginNotices()[0]!.data.plugins.map((p: any) => [p.pluginId, p.reason]),
    ).toEqual([
      ["pl_auth", "needs_auth"],
      ["pl_bits", "connect_failed"],
    ]);
  });

  it("still fails the turn when a server the user selected is refused", async () => {
    authorizeOverrides["body-server-1"] = {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Not allowed",
    };
    const response = await send();
    expect(response.status).toBe(403);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("counts plugin servers as MCP servers for the harness approval gate", async () => {
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: "host_1", hostStyle: "claude", harness: "claude-code" },
    });
    checkHarnessRuntimeAvailableMock.mockReturnValue({
      ok: false,
      kind: "tool-approval",
      reason: "can't pause for approval of MCP-server tools",
    });
    const response = await send({
      selectedServerIds: [],
      selectedServerNames: [],
    });
    expect(response.status).toBe(422);
    expect(checkHarnessRuntimeAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasSelectedMcpServers: true }),
    );
  });

  it("hands a harness turn its plugins as live plugins, never as an environment's set", async () => {
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: "host_1", hostStyle: "claude", harness: "claude-code" },
    });
    const response = await send();
    expect(response.status).toBe(200);
    const options = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(options.harness).toBe("claude-code");
    expect(options.effectiveCapabilities).toBeUndefined();
    expect(options.runtimeSkillsOverride).toBeUndefined();
    expect(options.livePlugins.skills.map((skill: any) => skill.name)).toEqual([
      "keycaps",
    ]);
    expect(
      options.livePlugins.capabilities.pluginSkills.map(
        (skill: any) => skill.ref,
      ),
    ).toEqual(["bits/keycaps"]);
    expect(options.livePlugins.capabilities.pluginServerIds).toEqual([
      "plugin-server-1",
    ]);
    expect(options.selectedServers).toEqual([
      "body-server-1",
      "plugin-server-1",
    ]);
  });

  it("gives an emulated turn no live plugins (its skills ride the merged set)", async () => {
    await send();
    const options = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
    expect(options.livePlugins).toBeUndefined();
  });

  it("adds a skills-only plugin's skills without touching the body's servers", async () => {
    const result = activeResult({
      servers: {
        selectedServerIds: [],
        pluginServerIds: [],
        baseEffectiveServerIds: [],
        effectiveServerIds: [],
        connectable: [],
      },
    });
    (result.plugins[0] as any).servers = [];
    (result.attribution as any).serverComponents = [];
    readActivePluginsMock.mockResolvedValue(parseActivePluginsResponse(result));
    const response = await send();
    expect(response.status).toBe(200);
    expect(authorizeCalls()).toEqual([["body-server-1"]]);
    expect(ensureConnectedMock).not.toHaveBeenCalled();
    const prepare = lastPrepare();
    expect(prepare.selectedServers).toEqual(["body-server-1"]);
    expect(
      prepare.skillsSource.capabilities.pluginSkills.map((s: any) => s.ref),
    ).toEqual(["bits/keycaps"]);
  });

  it("reads with the hosted venue on a hosted deployment", async () => {
    hostedMode.value = true;
    const response = await send();
    expect(response.status).toBe(200);
    expect(readActivePluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeVenue: "hosted" }),
    );
  });

  it("never reads active plugins for an environment turn", async () => {
    convexQueryMock.mockResolvedValue({
      specVersion: 1,
      environmentRef: { environmentId: "env_1", name: "Staging", revision: 1 },
      host: {
        hostId: "host_env",
        runtimeConfig: { hostId: "host_env", hostStyle: "claude" },
      },
      servers: {
        effectiveServerIds: ["env-server-1"],
        connectable: [
          { serverId: "env-server-1", name: "env", source: "host_or_group" },
        ],
      },
      skills: [],
      pluginVersions: [],
    });
    const { hostId: _hostId, ...body } = BASE_BODY;
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        ...body,
        executionTarget: { kind: "environment", environmentId: "env_1" },
      },
      token,
    );
    expect(response.status).toBe(200);
    expect(readActivePluginsMock).not.toHaveBeenCalled();
    expect(pluginNotices()).toEqual([]);
    expect(authorizeCalls()).toEqual([["env-server-1"]]);
  });

  it("never reads active plugins for a guest", async () => {
    const { app } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      BASE_BODY,
      "guest-jwt",
    );
    expect(response.status).toBe(200);
    expect(readActivePluginsMock).not.toHaveBeenCalled();
  });

  it("records plugin provenance on the turn's telemetry", async () => {
    const analytics = await import("../../../utils/analytics.js");
    const capture = vi.spyOn(analytics, "captureServerEvent");
    await send();
    const event = capture.mock.calls.find(
      ([, name]) => name === "send_message_server",
    );
    expect(event?.[2]).toMatchObject({
      plugin_version_ids: ["pv_bits"],
      plugin_bundle_hashes: ["hash_bits"],
      plugin_server_count: 1,
      plugin_skill_count: 1,
      plugin_skipped_reasons: ["needs_auth"],
    });
    expect(JSON.stringify(event?.[2])).not.toContain("Bits & Bolts");
    capture.mockRestore();
  });
});
