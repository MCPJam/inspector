import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Phase 4 — an env-backed chatbox's `bash` runs on a per-CONVERSATION ephemeral
// sandbox booted from the environment's image, NOT on the acting member's
// persistent personal computer.
//
// The behaviour change is the point of this file, so what it pins is mostly the
// negative space: the personal computer is never the fallback, the acting
// member's image context never reaches the prompt, and an old backend (absent
// marker) keeps today's behaviour byte-identical.

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchChatboxRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  provisionChatboxSandboxMock,
  maybeAppendEnvironmentContextMock,
  buildSandboxBashToolMock,
  buildBashToolMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchChatboxRuntimeConfigMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  provisionChatboxSandboxMock: vi.fn(),
  maybeAppendEnvironmentContextMock: vi.fn(),
  buildSandboxBashToolMock: vi.fn(),
  buildBashToolMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, convertToModelMessages: vi.fn((messages) => messages) };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: vi.fn(),
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

vi.mock("../../../utils/chatbox-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chatbox-runtime-config.js")
  >("../../../utils/chatbox-runtime-config.js");
  // `readComputerSandboxMode` stays REAL — the marker narrowing is the seam
  // under test; only the network fetch is mocked.
  return {
    ...actual,
    fetchChatboxRuntimeConfig: fetchChatboxRuntimeConfigMock,
  };
});

vi.mock("../../../utils/computers/control-plane-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/control-plane-client.js")
  >("../../../utils/computers/control-plane-client.js");
  return { ...actual, provisionChatboxSandbox: provisionChatboxSandboxMock };
});

vi.mock("../../../utils/computers/environment-context.js", () => ({
  maybeAppendEnvironmentContext: maybeAppendEnvironmentContextMock,
}));

// Distinguishable stand-ins so a test can tell which BASH PATH was taken —
// the whole question this feature answers.
vi.mock("../../../utils/built-in-tools/sandbox-bash.js", () => ({
  buildSandboxBashTool: buildSandboxBashToolMock,
}));
vi.mock("../../../utils/built-in-tools/bash.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/built-in-tools/bash.js")
  >("../../../utils/built-in-tools/bash.js");
  return { ...actual, buildBashTool: buildBashToolMock };
});

vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import { createWebTestApp, postJson } from "./helpers/test-app.js";

const ENVIRONMENT_PAYLOAD = {
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  servers: {
    effectiveServerIds: ["env-server-1"],
    connectable: [
      { serverId: "env-server-1", name: "linear", source: "host_or_group" },
    ],
  },
};

/** An env-backed chatbox whose host advertises bash + a personal computer. */
function chatboxConfig(
  computerSandbox?: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    chatboxId: "cbx_env",
    accessVersion: 3,
    modelId: "openai/gpt-5-mini",
    systemPrompt: "chatbox prompt",
    temperature: 0.7,
    requireToolApproval: false,
    hostStyle: "claude",
    builtInToolIds: ["bash"],
    computer: { kind: "personal", workdir: "/home/user" },
    environment: ENVIRONMENT_PAYLOAD,
    ...(computerSandbox ? { computerSandbox } : {}),
    ...overrides,
  };
}

const BASE_BODY = {
  projectId: "project-1",
  chatboxId: "cbx_env",
  accessVersion: 3,
  selectedServerIds: ["body-server-9"],
  chatSessionId: "chat-session-1",
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

/** The `builtInTools` set the route handed to prepare, on the last call. */
function builtInToolsFromLastTurn(): Record<string, unknown> | undefined {
  return prepareChatV2Mock.mock.calls.at(-1)?.[0]?.builtInTools;
}

describe("web chat-v2 — chatbox ephemeral sandbox", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";

    buildSandboxBashToolMock.mockImplementation((args: unknown) => ({
      __path: "ephemeral",
      args,
    }));
    buildBashToolMock.mockImplementation((args: unknown) => ({
      __path: "personal",
      args,
    }));
    maybeAppendEnvironmentContextMock.mockImplementation(
      async (args: { systemPrompt?: string }) => args.systemPrompt
    );
    provisionChatboxSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        workdir: "/srv/app",
        notices: [],
      },
    });
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: chatboxConfig({ mode: "ephemeral" }),
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    global.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const serverIds: string[] = payload?.serverIds ?? [];
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

  it("binds bash to the conversation's sandbox, never the personal computer", async () => {
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    expect(provisionChatboxSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatboxId: "cbx_env",
        chatSessionId: "chat-session-1",
      })
    );
    // The image is resolved server-side; the client neither knows nor sends one.
    const provisionArgs = provisionChatboxSandboxMock.mock.calls[0]![0];
    expect(JSON.stringify(provisionArgs)).not.toMatch(/template|e2b/i);

    expect(buildSandboxBashToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_conversation_1",
        workdir: "/srv/app",
      })
    );
    // THE regression this exists to prevent.
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect((builtInToolsFromLastTurn()?.bash as any).__path).toBe("ephemeral");
  });

  it("suppresses the acting member's image context — it describes the WRONG machine", async () => {
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    // That prompt block is derived from the acting member's computer row. On an
    // ephemeral box it would confidently describe a filesystem this turn's bash
    // cannot see — worse than no prompt at all.
    expect(maybeAppendEnvironmentContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasBashTool: false })
    );
  });

  it("re-obtains the SAME box on the next turn of the conversation", async () => {
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    // Get-or-create at the backend; the inspector just asks again. There is no
    // release between turns — the box belongs to the conversation.
    expect(provisionChatboxSandboxMock).toHaveBeenCalledTimes(2);
    expect(
      buildSandboxBashToolMock.mock.calls.map(([a]) => (a as any).sandboxId)
    ).toEqual(["sbx_conversation_1", "sbx_conversation_1"]);
  });

  it("a different conversation asks for a different box", async () => {
    provisionChatboxSandboxMock
      .mockResolvedValueOnce({
        ok: true,
        value: { sandboxId: "sbx_a", sandboxRowId: "row_a", notices: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { sandboxId: "sbx_b", sandboxRowId: "row_b", notices: [] },
      });
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    await postJson(
      app,
      "/api/web/chat-v2",
      { ...BASE_BODY, chatSessionId: "chat-session-2" },
      token
    );

    expect(
      provisionChatboxSandboxMock.mock.calls.map(([a]) => a.chatSessionId)
    ).toEqual(["chat-session-1", "chat-session-2"]);
    expect(
      buildSandboxBashToolMock.mock.calls.map(([a]) => (a as any).sandboxId)
    ).toEqual(["sbx_a", "sbx_b"]);
  });

  it("forwards consumed notices to the stream, exactly as delivered", async () => {
    provisionChatboxSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset", "stale_image"],
      },
    });
    const writes: unknown[] = [];
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({ write: (c: unknown) => writes.push(c) });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(
      writes.filter(
        (chunk: any) => chunk?.type === "data-sandbox-notice"
      )
    ).toEqual([
      {
        type: "data-sandbox-notice",
        data: { reason: "sandbox_reset" },
        transient: true,
      },
      {
        type: "data-sandbox-notice",
        data: { reason: "stale_image" },
        transient: true,
      },
    ]);
  });

  it("drops an unknown notice code instead of streaming it", async () => {
    provisionChatboxSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["invented_later"],
      },
    });
    const writes: unknown[] = [];
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({ write: (c: unknown) => writes.push(c) });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(
      writes.filter((chunk: any) => chunk?.type === "data-sandbox-notice")
    ).toEqual([]);
  });

  it("runs with NO bash — and no error — when provisioning fails", async () => {
    provisionChatboxSandboxMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "at capacity",
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    // The conversation is still useful without a shell, and 503 clears itself.
    expect(response.status).toBe(200);
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
    // Emphatically NOT the personal box: falling back there is the bug.
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect(builtInToolsFromLastTurn()?.bash).toBeUndefined();
  });

  it("advertises no bash when the marker says the image is unavailable", async () => {
    // The backend has already dropped `computer` in this state; assert the
    // inspector doesn't resurrect it from anywhere else.
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...chatboxConfig({ mode: "unavailable", reason: "no ready build" }),
        computer: undefined,
      },
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    expect(provisionChatboxSandboxMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).not.toHaveBeenCalled();
  });

  it("suppresses bash rather than sharing one box when the turn has no chatSessionId", async () => {
    const { app, token } = createWebTestApp();
    const { chatSessionId: _drop, ...noSession } = BASE_BODY;
    const response = await postJson(app, "/api/web/chat-v2", noSession, token);

    expect(response.status).toBe(200);
    // The conversation id IS the isolation boundary. Without one, binding
    // anyway would put every such session on one shared box.
    expect(provisionChatboxSandboxMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
  });

  it("an ABSENT marker keeps today's personal-computer behaviour", async () => {
    fetchChatboxRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: chatboxConfig(),
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    // Old backend (or an environment with no image pinned): no provision, and
    // bash lands on the personal box exactly as before.
    expect(provisionChatboxSandboxMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).toHaveBeenCalledTimes(1);
    expect((builtInToolsFromLastTurn()?.bash as any).__path).toBe("personal");
    // …and the acting member's image context is still appended, because on the
    // personal path it describes the right machine.
    expect(maybeAppendEnvironmentContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasBashTool: true })
    );
  });
});
