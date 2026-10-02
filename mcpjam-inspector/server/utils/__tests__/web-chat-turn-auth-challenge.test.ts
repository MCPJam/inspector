/**
 * Hosted chat wiring for mid-session sign-in: which hosted turns react
 * to a 401, which of them can save the call, and which never offer a card.
 * The engines are mocked; the tool set they are handed is exercised directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChallengeHeader } from "@mcpjam/sdk";
import {
  AUTH_REQUIRED_DATA_PART_TYPE,
  isAuthRequiredDataPart,
} from "@/shared/auth-challenge";

const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async () => new Response("mcpjam")),
  hostedOrg: vi.fn(async () => new Response("org-hosted")),
  localOrg: vi.fn(async () => new Response("org-local")),
}));

const store = vi.hoisted(() => ({
  create: vi.fn(),
  cancel: vi.fn(),
  scrub: vi.fn(),
}));

vi.mock("../mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handlers.mcpjamFree,
  warnIfChatAbortSignalMissing: vi.fn(),
}));

vi.mock("../org-model-stream-handler.js", () => ({
  handleHostedOrgChatModel: handlers.hostedOrg,
  handleLocalOrgChatModel: handlers.localOrg,
}));

vi.mock("../org-model-config.js", () => ({
  deriveOrgProviderKey: vi.fn(() => ({ ok: true, key: "openai" })),
  isLocalRuntimeEligible: vi.fn(() => false),
  resolveOrgProviderRuntime: vi.fn(),
}));

vi.mock("../mrtr-continuation-state.js", async () => {
  const actual = await vi.importActual<
    typeof import("../mrtr-continuation-state.js")
  >("../mrtr-continuation-state.js");
  return {
    ...actual,
    createContinuation: store.create,
    cancelContinuation: store.cancel,
    scrubContinuation: store.scrub,
  };
});

const CHALLENGE = 'Bearer error="invalid_token", scope="orders:read"';

function http401(): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: { authChallenge: parseChallengeHeader(CHALLENGE) },
  });
}

vi.mock("../chat-v2-orchestration.js", () => ({
  prepareChatV2: vi.fn(async () => ({
    allTools: {
      get_my_orders: {
        description: "orders",
        inputSchema: {},
        _serverId: "server-1",
        execute: async () => {
          throw http401();
        },
      },
    },
    enhancedSystemPrompt: "",
    resolvedTemperature: undefined,
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
  buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
}));

vi.mock("../mcp-tool-result-model-output.js", () => ({
  convertToMcpjamModelMessages: vi.fn(async () => []),
}));

import { streamWebChatTurn } from "../web-chat-turn";
import { recordConnectionEffectiveAuth } from "../connection-effective-auth.js";
import { isScopeStepUpSuspendSignal } from "../scope-step-up-continuation.js";

function makeManager() {
  const manager = {
    disconnectAllServers: vi.fn(async () => {}),
    hasServer: () => true,
    getInitializationInfo: () => ({
      protocolVersion: "2026-07-28",
      serverCapabilities: { tools: {} },
      serverVersion: { name: "orders", version: "1" },
    }),
    getServerConfig: () => ({ url: "https://orders.example/mcp" }),
    getAllToolAnnotations: () => ({ get_my_orders: { readOnlyHint: true } }),
  };
  recordConnectionEffectiveAuth(manager, "server-1", "discover");
  return manager;
}

function args(options: {
  chatSessionId?: string;
  scenario?: boolean;
  authChallenge?: boolean;
  scopeStepUp?: boolean;
  cancelRequest?: { continuationId: string; toolCallId: string };
}) {
  const c = {
    req: {
      raw: { headers: new Headers(), signal: undefined },
      header: () => undefined,
    },
  } as never;
  return {
    manager: makeManager() as never,
    prepare: {
      selectedServerIds: ["server-1"],
      modelDefinition: {
        id: "test-model",
        name: "test",
        provider: "openai",
        hosted: false,
      } as never,
      uiMessages: [],
    },
    persist: {
      chatSessionId: options.chatSessionId,
      projectId: "p1",
      sourceType: options.scenario
        ? ("scenario" as const)
        : ("direct" as const),
      origin: options.scenario
        ? ("scenario" as const)
        : ("playground" as const),
      originalMessages: [],
      selectedServerIds: ["server-1"],
      selectedServerNames: ["Orders"],
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c,
      ...(options.authChallenge === false ? {} : { authChallenge: {} }),
      ...(options.scopeStepUp
        ? {
            scopeStepUp: {
              bearer: "convex-bearer",
              authPrincipal: "user-1",
              ...(options.cancelRequest
                ? { cancelRequest: options.cancelRequest }
                : {}),
            },
          }
        : {}),
    },
  };
}

async function runTool(turn: ReturnType<typeof args>) {
  await streamWebChatTurn(turn as never);
  const options = handlers.hostedOrg.mock.calls.at(-1)?.[0] as any;
  const chunks: any[] = [];
  options.onStreamWriterReady({
    write: (chunk: unknown) => chunks.push(chunk),
  });
  const outcome = await options.tools.get_my_orders
    .execute({ since: "2026-01-01" }, { toolCallId: "call-1" })
    .then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  return { chunks, outcome, options };
}

describe("hosted chat: mid-session sign-in wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
    store.create.mockImplementation(async (_bearer: string, body: any) => ({
      ok: true,
      continuationId: body.continuationId,
      status: "awaiting_input",
      round: 0,
      stateVersion: 0,
      expiresAt: 1_900_000_000_000,
      createdAt: 1,
      idempotent: false,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("saves and suspends the call on a chat with a session", async () => {
    const { chunks, outcome, options } = await runTool(
      args({ chatSessionId: "chat-1", scopeStepUp: true }),
    );
    expect(isScopeStepUpSuspendSignal((outcome as any).error)).toBe(true);
    expect(store.create).toHaveBeenCalledTimes(1);
    const card = chunks.find((c) => c.type === AUTH_REQUIRED_DATA_PART_TYPE);
    expect(card?.data).toMatchObject({
      continuationId: expect.stringMatching(/^authz-/),
      serverId: "server-1",
      serverName: "Orders",
      effectiveAuth: "discover",
      action: "prompt",
      readOnly: true,
      expiresAt: 1_900_000_000_000,
    });
    expect(isAuthRequiredDataPart(card)).toBe(true);
    expect(JSON.parse(store.create.mock.calls[0][1].resumeState)).toMatchObject(
      {
        reason: "authorization_required",
        credentialBinding: { kind: "none" },
      },
    );
    // A later turn that resends the call unresolved settles it.
    expect(typeof options.settleSuspendedHistoryToolCall).toBe("function");
  });

  it("offers a display-only card without a chat session (nothing can resume)", async () => {
    const { chunks, outcome, options } = await runTool(args({}));
    expect((outcome as any).error).toBeInstanceOf(Error);
    expect(isScopeStepUpSuspendSignal((outcome as any).error)).toBe(false);
    expect(store.create).not.toHaveBeenCalled();
    const card = chunks.find((c) => c.type === AUTH_REQUIRED_DATA_PART_TYPE);
    expect(card?.data).toMatchObject({ action: "prompt" });
    expect(card?.data).not.toHaveProperty("continuationId");
    expect(isAuthRequiredDataPart(card)).toBe(true);
    expect(options.settleSuspendedHistoryToolCall).toBeUndefined();
  });

  it("never offers a card to a scenario or share-link visitor", async () => {
    const { chunks, outcome } = await runTool(
      args({ chatSessionId: "chat-1", scopeStepUp: true, scenario: true }),
    );
    expect((outcome as any).error).toBeInstanceOf(Error);
    expect(store.create).not.toHaveBeenCalled();
    expect(
      chunks.filter((c) => c.type === AUTH_REQUIRED_DATA_PART_TYPE),
    ).toHaveLength(0);
  });

  it("leaves other hosted callers exactly as they were", async () => {
    const { chunks, outcome, options } = await runTool(
      args({
        chatSessionId: "chat-1",
        scopeStepUp: true,
        authChallenge: false,
      }),
    );
    expect((outcome as any).error).toBeInstanceOf(Error);
    expect(store.create).not.toHaveBeenCalled();
    expect(chunks.filter((c) => String(c.type).includes("auth"))).toHaveLength(
      0,
    );
    expect(options.settleSuspendedHistoryToolCall).toBeUndefined();
  });

  it("settles a resent call by cancelling its derived continuation", async () => {
    store.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
    store.scrub.mockResolvedValue({ ok: true });
    const { options } = await runTool(
      args({ chatSessionId: "chat-1", scopeStepUp: true }),
    );
    await expect(
      options.settleSuspendedHistoryToolCall({
        toolCallId: "call-1",
        toolName: "get_my_orders",
      }),
    ).resolves.toContain('MCP server "Orders" asked the user to sign in');
    expect(store.cancel).toHaveBeenCalledWith(
      "convex-bearer",
      expect.objectContaining({
        continuationId: expect.stringMatching(/^authz-/),
      }),
    );
    // A client-fulfilled or unknown tool never costs a store round trip.
    store.cancel.mockClear();
    await expect(
      options.settleSuspendedHistoryToolCall({
        toolCallId: "call-9",
        toolName: "ui_navigate",
      }),
    ).resolves.toBeUndefined();
    expect(store.cancel).not.toHaveBeenCalled();
  });

  describe("a cancel spliced into the user's next message", () => {
    const history = [
      { role: "user", content: "show my orders" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "get_my_orders",
            input: {},
          },
        ],
      },
    ];

    async function dispatch(withNewMessage: boolean, continuationId: string) {
      const conversion = await import("../mcp-tool-result-model-output.js");
      vi.mocked(conversion.convertToMcpjamModelMessages).mockResolvedValueOnce(
        (withNewMessage
          ? [...history, { role: "user", content: "never mind" }]
          : history) as never,
      );
      await streamWebChatTurn(
        args({
          chatSessionId: "chat-1",
          scopeStepUp: true,
          cancelRequest: { continuationId, toolCallId: "call-1" },
        }) as never,
      );
      return handlers.hostedOrg.mock.calls.at(-1)?.[0] as any;
    }

    it("settles the named call instead of driving a resume leg", async () => {
      store.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
      store.scrub.mockResolvedValue({ ok: true });
      const options = await dispatch(true, "authz-abc");
      expect(options.scopeStepUpResume).toBeUndefined();
      const chunks: any[] = [];
      options.onStreamWriterReady({
        write: (chunk: unknown) => chunks.push(chunk),
      });
      await expect(
        options.settleSuspendedHistoryToolCall({
          toolCallId: "call-1",
          toolName: "get_my_orders",
        }),
      ).resolves.toContain('MCP server "Orders" asked the user to sign in');
      expect(store.cancel).toHaveBeenCalledWith(
        "convex-bearer",
        expect.objectContaining({ continuationId: "authz-abc" }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: "data-scope-step-up-finished",
          data: expect.objectContaining({
            continuationId: "authz-abc",
            outcome: "cancelled",
          }),
        }),
      );
    });

    it("answers the call even when the store no longer holds it", async () => {
      store.cancel.mockResolvedValue({
        ok: false,
        status: 404,
        error: "not found",
      });
      const options = await dispatch(true, "authz-gone");
      await expect(
        options.settleSuspendedHistoryToolCall({
          toolCallId: "call-1",
          toolName: "get_my_orders",
        }),
      ).resolves.toContain("the user did not sign in");
      expect(store.scrub).not.toHaveBeenCalled();
    });

    it("keeps the step-up copy for a step-up continuation", async () => {
      store.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
      store.scrub.mockResolvedValue({ ok: true });
      const options = await dispatch(true, "step-up-1");
      await expect(
        options.settleSuspendedHistoryToolCall({
          toolCallId: "call-1",
          toolName: "get_my_orders",
        }),
      ).resolves.toBe(
        "Authorization was not completed, so the tool was not retried.",
      );
    });

    it("keeps the re-drive path for a bare cancel (no new message)", async () => {
      const options = await dispatch(false, "authz-abc");
      expect(options.scopeStepUpResume).toMatchObject({ toolCallId: "call-1" });
    });
  });
});
