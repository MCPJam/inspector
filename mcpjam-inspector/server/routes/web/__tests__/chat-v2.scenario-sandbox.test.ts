import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Phase 4 — an env-backed scenario's `bash` runs on a per-CONVERSATION ephemeral
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
  fetchScenarioRuntimeConfigMock,
  persistChatSessionToConvexMock,
  disconnectAllServersMock,
  provisionScenarioSandboxMock,
  ackScenarioSandboxNoticesMock,
  isComputersDataPlaneConfiguredMock,
  maybeAppendEnvironmentContextMock,
  buildSandboxBashToolMock,
  buildBashToolMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchScenarioRuntimeConfigMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  provisionScenarioSandboxMock: vi.fn(),
  ackScenarioSandboxNoticesMock: vi.fn(),
  isComputersDataPlaneConfiguredMock: vi.fn(),
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

vi.mock("../../../utils/scenario-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/scenario-runtime-config.js")
  >("../../../utils/scenario-runtime-config.js");
  // `readComputerSandboxMode` stays REAL — the marker narrowing is the seam
  // under test; only the network fetch is mocked.
  return {
    ...actual,
    fetchScenarioRuntimeConfig: fetchScenarioRuntimeConfigMock,
  };
});

vi.mock("../../../utils/computers/control-plane-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/control-plane-client.js")
  >("../../../utils/computers/control-plane-client.js");
  return {
    ...actual,
    provisionScenarioSandbox: provisionScenarioSandboxMock,
    ackScenarioSandboxNotices: ackScenarioSandboxNoticesMock,
    // Env-derived in the real module (false in a bare test process). The
    // preflight consults it BEFORE provisioning, so the suite pins it `true`
    // by default and individual tests flip it to model a local inspector.
    isComputersDataPlaneConfigured: isComputersDataPlaneConfiguredMock,
  };
});

// Spread the REAL module: only the network-backed image-context fetch is
// mocked. `appendSandboxNoticeContext` is a pure formatter and IS under test —
// and a bare factory would leave it undefined and 500 the route for a reason
// that has nothing to do with the assertion.
vi.mock("../../../utils/computers/environment-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/environment-context.js")
  >("../../../utils/computers/environment-context.js");
  return {
    ...actual,
    maybeAppendEnvironmentContext: maybeAppendEnvironmentContextMock,
  };
});

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

// Only `checkHarnessRuntimeAvailable` is stubbed. Spreading `actual` is
// load-bearing, not tidiness: a wholesale replacement makes every OTHER export
// the route calls `undefined(...)` at runtime — a 500 that looks like a routing
// bug rather than a missing mock entry.
vi.mock("../../../utils/harness/harness-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-availability.js")
  >("../../../utils/harness/harness-availability.js");
  return {
    ...actual,
    checkHarnessRuntimeAvailable: () => ({ ok: true }),
  };
});

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

/** An env-backed scenario whose host advertises bash + a personal computer. */
function scenarioConfig(
  computerSandbox?: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    scenarioId: "cbx_env",
    accessVersion: 3,
    modelId: "openai/gpt-5-mini",
    systemPrompt: "scenario prompt",
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
  scenarioId: "cbx_env",
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

describe("web chat-v2 — scenario ephemeral sandbox", () => {
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
    ackScenarioSandboxNoticesMock.mockResolvedValue(undefined);
    isComputersDataPlaneConfiguredMock.mockReturnValue(true);
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        workdir: "/srv/app",
        notices: [],
        noticeAckPending: false,
      },
    });
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: scenarioConfig({ mode: "ephemeral" }),
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

    expect(provisionScenarioSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "cbx_env",
        chatSessionId: "chat-session-1",
      })
    );
    // The image is resolved server-side; the client neither knows nor sends one.
    const provisionArgs = provisionScenarioSandboxMock.mock.calls[0]![0];
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
    expect(provisionScenarioSandboxMock).toHaveBeenCalledTimes(2);
    expect(
      buildSandboxBashToolMock.mock.calls.map(([a]) => (a as any).sandboxId)
    ).toEqual(["sbx_conversation_1", "sbx_conversation_1"]);
  });

  it("a different conversation asks for a different box", async () => {
    provisionScenarioSandboxMock
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
      provisionScenarioSandboxMock.mock.calls.map(([a]) => a.chatSessionId)
    ).toEqual(["chat-session-1", "chat-session-2"]);
    expect(
      buildSandboxBashToolMock.mock.calls.map(([a]) => (a as any).sandboxId)
    ).toEqual(["sbx_a", "sbx_b"]);
  });

  it("forwards peeked notices to the stream, exactly as delivered", async () => {
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset", "stale_image"],
        noticeAckPending: true,
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
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["invented_later"],
        noticeAckPending: true,
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

  it("acks the notices it actually put on the wire, and only after writing them", async () => {
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_ack",
        notices: ["sandbox_reset"],
        noticeAckPending: true,
      },
    });
    const order: string[] = [];
    ackScenarioSandboxNoticesMock.mockImplementation(async () => {
      order.push("ack");
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({
        write: (chunk: any) => {
          if (chunk?.type === "data-sandbox-notice") order.push("write");
        },
      });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    // Ordering is the contract: the control plane must not mark a notice
    // delivered until it demonstrably was.
    expect(order).toEqual(["write", "ack"]);
    expect(ackScenarioSandboxNoticesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRowId: "row_ack",
        notices: ["sandbox_reset"],
      })
    );
  });

  it("does NOT ack when the turn dies before a stream writer exists", async () => {
    // THE GAP THIS CLOSES. The notice stays pending server-side and is
    // re-delivered next turn instead of being silently destroyed — and a
    // dropped "your sandbox was reset" is the one that makes the model
    // confabulate about files it can no longer see.
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_ack",
        notices: ["sandbox_reset"],
        noticeAckPending: true,
      },
    });
    prepareChatV2Mock.mockRejectedValue(new Error("tool prep exploded"));

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(ackScenarioSandboxNoticesMock).not.toHaveBeenCalled();
  });

  it("acks only the notices whose write succeeded", async () => {
    // A chunk that threw was never delivered, so acking it would consume a
    // notice the user never saw.
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_ack",
        notices: ["sandbox_reset", "stale_image"],
        noticeAckPending: true,
      },
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      let seen = 0;
      options.onStreamWriterReady?.({
        write: (chunk: any) => {
          if (chunk?.type !== "data-sandbox-notice") return;
          seen += 1;
          if (seen === 2) throw new Error("socket closed");
        },
      });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(ackScenarioSandboxNoticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ notices: ["sandbox_reset"] })
    );
  });

  it("never acks against a backend that already consumed (pre-#829)", async () => {
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_legacy",
        notices: ["sandbox_reset"],
        // Absent field: an older deploy consumed at provision time.
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

    // Still shown — just nothing to ack.
    expect(
      writes.filter((chunk: any) => chunk?.type === "data-sandbox-notice")
    ).toHaveLength(1);
    expect(ackScenarioSandboxNoticesMock).not.toHaveBeenCalled();
  });

  it("tells the MODEL about a reset, not only the user's toast", async () => {
    // The toast warns the human; the model still has a transcript saying it
    // wrote files. Warning only the user moves the confabulation, it doesn't
    // prevent it.
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset"],
        noticeAckPending: true,
      },
    });
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    const prompt = prepareChatV2Mock.mock.calls.at(-1)![0].systemPrompt;
    expect(prompt).toMatch(/RESET since the last turn/);
    expect(prompt).toMatch(/re-check with bash/);
  });

  it("keeps the reset context OUT of the persisted resume prompt", async () => {
    // A resumed turn must not replay "your sandbox was reset" long after the
    // fact — same rule as the turn-injected blueprint image block.
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset"],
        noticeAckPending: true,
      },
    });
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    const persisted = persistChatSessionToConvexMock.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(persisted ?? {})).not.toMatch(/RESET since the last turn/);
  });

  it("adds no sandbox block when there are no notices", async () => {
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(prepareChatV2Mock.mock.calls.at(-1)![0].systemPrompt).not.toMatch(
      /## Sandbox state/
    );
  });

  it("does NOT ack a notice written into a closed stream", async () => {
    // The emulated engine's `safeWriter` is deliberately no-throw: it swallows
    // controller failures and no-ops once closed. Trusting a clean return would
    // ack — and permanently consume — a notice the browser never saw.
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset"],
        noticeAckPending: true,
      },
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({
        // Exactly the shipped safeWriter contract: never throws, reports state.
        write: () => {},
        isClosed: () => true,
      });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(ackScenarioSandboxNoticesMock).not.toHaveBeenCalled();
  });

  it("does not ack the chunk whose write closed the stream", async () => {
    provisionScenarioSandboxMock.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "sbx_conversation_1",
        sandboxRowId: "row_1",
        notices: ["sandbox_reset", "stale_image"],
        noticeAckPending: true,
      },
    });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      let closed = false;
      let seen = 0;
      options.onStreamWriterReady?.({
        write: (chunk: any) => {
          if (chunk?.type !== "data-sandbox-notice") return;
          seen += 1;
          // The client disconnects during the SECOND write; safeWriter would
          // swallow that and flip its state rather than throwing.
          if (seen === 2) closed = true;
        },
        isClosed: () => closed,
      });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(ackScenarioSandboxNoticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ notices: ["sandbox_reset"] })
    );
  });

  it("runs with NO bash — and no error — when provisioning fails", async () => {
    provisionScenarioSandboxMock.mockResolvedValue({
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
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        ...scenarioConfig({ mode: "unavailable", reason: "no ready build" }),
        computer: undefined,
      },
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
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
    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
  });

  it("never provisions from a server that is not a computers data plane", async () => {
    // `provisionScenarioSandbox` is bearer-authed and would SUCCEED from a
    // credential-less local inspector — stranding a BILLABLE box that
    // `sandbox-bash` (which has no remote delegation) could never exec in.
    // The capability check must therefore come before the reserve.
    isComputersDataPlaneConfiguredMock.mockReturnValue(false);
    const writes: unknown[] = [];
    handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
      options.onStreamWriterReady?.({ write: (c: unknown) => writes.push(c) });
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);
    expect(response.status).toBe(200);

    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect(builtInToolsFromLastTurn()?.bash).toBeUndefined();

    // The tester is told, instead of watching every command fail opaquely.
    expect(
      writes.filter((chunk: any) => chunk?.type === "data-sandbox-notice")
    ).toEqual([
      {
        type: "data-sandbox-notice",
        data: { reason: "sandbox_unavailable" },
        transient: true,
      },
    ]);
    // Inspector-minted notice: there is no backend notice row, nothing to ack.
    expect(ackScenarioSandboxNoticesMock).not.toHaveBeenCalled();
  });

  it("tells the MODEL bash is unavailable, not only the tester's toast", async () => {
    isComputersDataPlaneConfiguredMock.mockReturnValue(false);
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    const prompt = prepareChatV2Mock.mock.calls.at(-1)![0].systemPrompt;
    expect(prompt).toMatch(/NO bash tool this conversation/);
  });

  it("leaves a legacy marker-absent config untouched by the data-plane preflight", async () => {
    // Absent marker = personal-computer behavior. The preflight governs only
    // the ephemeral path; the personal path's own cloud-family resolution is a
    // different seam and must not start suppressing here.
    isComputersDataPlaneConfiguredMock.mockReturnValue(false);
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: scenarioConfig(),
    });

    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
    expect((builtInToolsFromLastTurn()?.bash as any)?.__path).toBe("personal");
  });

  it("tells the model the box survives between turns", async () => {
    const { app, token } = createWebTestApp();
    await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    // The default (`run`) copy says the box is destroyed after this session. A
    // model that believes that won't build work up across turns — which is the
    // entire reason a scenario box is conversation-scoped.
    expect(buildSandboxBashToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ lifetime: "conversation" })
    );
  });

  it("leaves a HARNESS scenario alone rather than producing a mixed-machine turn", async () => {
    // `run-harness-turn.ts` resolves its own machine (the member's personal
    // computer) and receives `prepare.builtInTools` verbatim. Provisioning here
    // would put the model's bash on one filesystem and the harness's Shell on
    // another. Harness-on-scenario is Phase 6; until then, hands off.
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: scenarioConfig({ mode: "ephemeral" }, { harness: "claude-code" }),
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
    // Today's behaviour, preserved end to end: personal bash AND the personal
    // machine's image context.
    expect(buildBashToolMock).toHaveBeenCalledTimes(1);
    expect(maybeAppendEnvironmentContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasBashTool: true })
    );
  });

  it("obeys an `unavailable` marker even if the payload still carries a computer", async () => {
    // Defense in depth. The backend drops `computer` in this state, but that is
    // its promise, not ours to depend on — a regression or a config-merging
    // proxy must not be able to expose the member's personal shell to a
    // share-link-reachable scenario turn.
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: scenarioConfig({ mode: "unavailable", reason: "no ready build" }),
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    expect(buildBashToolMock).not.toHaveBeenCalled();
    expect(buildSandboxBashToolMock).not.toHaveBeenCalled();
    expect(builtInToolsFromLastTurn()?.bash).toBeUndefined();
  });

  it("does not boot a paid box for a turn that is going to be rejected", async () => {
    // Provisioning is the step that spends money, so it must sit AFTER the
    // body validations and the manager authorization — not before them.
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/chat-v2",
      { ...BASE_BODY, appTools: [{ nope: true }] },
      token
    );

    expect(response.status).toBe(400);
    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
  });

  it("an ABSENT marker keeps today's personal-computer behaviour", async () => {
    fetchScenarioRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: scenarioConfig(),
    });
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", BASE_BODY, token);

    expect(response.status).toBe(200);
    // Old backend (or an environment with no image pinned): no provision, and
    // bash lands on the personal box exactly as before.
    expect(provisionScenarioSandboxMock).not.toHaveBeenCalled();
    expect(buildBashToolMock).toHaveBeenCalledTimes(1);
    expect((builtInToolsFromLastTurn()?.bash as any).__path).toBe("personal");
    // …and the acting member's image context is still appended, because on the
    // personal path it describes the right machine.
    expect(maybeAppendEnvironmentContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasBashTool: true })
    );
  });
});
