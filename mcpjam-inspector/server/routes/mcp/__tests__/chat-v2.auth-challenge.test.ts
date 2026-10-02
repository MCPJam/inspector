/**
 * Mid-session sign-in on the local chat route: the continuation builders the
 * route hands its engines, and the server side of "send without clicking" on
 * both engines (the cancel request, and history settlement when no cancel
 * arrives).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, streamText, type ModelMessage } from "ai";
import { parseChallengeHeader } from "@mcpjam/sdk";
import {
  AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
  authChallengeCancelledText,
  authChallengeRepeatText,
  isAuthChallengeNoticeDataPart,
} from "@/shared/auth-challenge";
import { SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE } from "@/shared/scope-step-up";
import {
  __resetLocalScopeStepUpContinuationsForTests,
  createLocalAuthChallengeContinuation,
  createLocalScopeStepUpContinuation,
  hasRecentLocalAuthSignIn,
  settleLocalAuthChallengeHistoryCall,
} from "../../../utils/scope-step-up-continuation.js";
import { resumeScopeStepUpBeforeDirectTurn } from "../../../utils/direct-chat-scope-step-up.js";
import { __peekLocalScopeStepUpContinuationForTests } from "../../../utils/scope-step-up-continuation.js";
import { handleMCPJamFreeChatModel } from "../../../utils/mcpjam-stream-handler.js";
import {
  buildLocalScopeStepUpCancellation,
  buildLocalScopeStepUpResume,
  buildLocalSuspendedCallSettlement,
} from "../chat-v2.js";
import { endsWithNewUserMessage } from "../../../utils/direct-chat-scope-step-up.js";

vi.mock("../../../utils/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const BINDING = "actor/project/conversation";
const CHALLENGE =
  'Bearer error="invalid_token", error_description="Sign in to read orders", scope="orders:read"';

function http401(): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: { authChallenge: parseChallengeHeader(CHALLENGE) },
  });
}

function saveSignIn(toolCallId = "call-1") {
  return createLocalAuthChallengeContinuation({
    bindingKey: BINDING,
    serverId: "Orders",
    serverName: "Orders",
    toolCallId,
    toolName: "get_my_orders",
    toolInput: { since: "2026-01-01" },
    challenge: { serverId: "Orders", toolCallId },
  });
}

function ordersTool(execute: (input: unknown) => unknown) {
  return {
    get_my_orders: {
      inputSchema: {},
      _serverId: "Orders",
      execute: vi.fn(async (input: unknown) => execute(input)),
    },
  } as any;
}

function collectWrites() {
  const chunks: any[] = [];
  return { chunks, write: (chunk: unknown) => chunks.push(chunk) };
}

function errorText(message: ModelMessage | undefined): unknown {
  const part = (message as any)?.content?.[0];
  return part?.output?.value;
}

/** The conversation as the client resends it after the user moved on. */
function historyWithUnresolvedCall(): ModelMessage[] {
  return [
    { role: "user", content: "show my orders" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "get_my_orders",
          input: { since: "2026-01-01" },
        },
      ],
    },
    { role: "user", content: "never mind, list the products" },
  ] as ModelMessage[];
}

describe("local sign-in continuation builders", () => {
  beforeEach(() => __resetLocalScopeStepUpContinuationsForTests());
  afterEach(() => __resetLocalScopeStepUpContinuationsForTests());

  it("answers a cancelled sign-in with the reason-aware copy", async () => {
    const { continuationId } = saveSignIn();
    const { chunks, write } = collectWrites();
    const resolution = await buildLocalScopeStepUpCancellation({
      request: { continuationId, toolCallId: "call-1" },
      bindingKey: BINDING,
    }).resolve(write);

    expect(resolution).toMatchObject({ kind: "recover" });
    expect(
      errorText(
        (resolution as { toolResultMessage: ModelMessage }).toolResultMessage,
      ),
    ).toBe(authChallengeCancelledText("Orders", "get_my_orders"));
    expect(chunks[0]).toMatchObject({
      type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
      data: { continuationId, outcome: "cancelled" },
    });
  });

  it("keeps the step-up cancel copy unchanged", async () => {
    const event = createLocalScopeStepUpContinuation({
      bindingKey: BINDING,
      serverId: "Orders",
      toolCallId: "call-2",
      toolName: "cancel_order",
      toolInput: {},
      challenge: { serverId: "Orders", requiredScope: "orders:write" },
    });
    const resolution = await buildLocalScopeStepUpCancellation({
      request: { continuationId: event.continuationId, toolCallId: "call-2" },
      bindingKey: BINDING,
    }).resolve(() => undefined);
    expect(
      errorText(
        (resolution as { toolResultMessage: ModelMessage }).toolResultMessage,
      ),
    ).toBe("Authorization was not completed, so the tool was not retried.");
  });

  it("replays the saved call after sign-in", async () => {
    const { continuationId } = saveSignIn();
    const result = { content: [{ type: "text", text: "2 orders" }] };
    const tools = ordersTool(() => result);
    const { chunks, write } = collectWrites();
    const resolution = await buildLocalScopeStepUpResume({
      request: { continuationId, toolCallId: "call-1" },
      bindingKey: BINDING,
      tools,
    }).resolve(write);

    expect(resolution.kind).toBe("complete");
    expect(tools.get_my_orders.execute).toHaveBeenCalledWith(
      { since: "2026-01-01" },
      expect.anything(),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: expect.objectContaining({ outcome: "completed" }),
      }),
    );
  });

  it("treats a 401 on the replay as permanent: repeat copy, notice, no new card", async () => {
    const { continuationId } = saveSignIn();
    const { chunks, write } = collectWrites();
    const resolution = await buildLocalScopeStepUpResume({
      request: { continuationId, toolCallId: "call-1" },
      bindingKey: BINDING,
      tools: ordersTool(() => {
        throw http401();
      }),
    }).resolve(write);

    expect(resolution.kind).toBe("recover");
    expect(
      errorText(
        (resolution as { toolResultMessage: ModelMessage }).toolResultMessage,
      ),
    ).toBe(authChallengeRepeatText("Orders", "get_my_orders"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      data: { reason: "repeat-after-sign-in" },
    });
    expect(isAuthChallengeNoticeDataPart(chunks[0])).toBe(true);
    // A later challenge for the same operation is answered the same way.
    expect(
      hasRecentLocalAuthSignIn({
        bindingKey: BINDING,
        serverId: "Orders",
        toolName: "get_my_orders",
      }),
    ).toBe(true);
  });

  it("treats a `_meta`-challenged replay as a repeat, never as a success", async () => {
    const { continuationId } = saveSignIn();
    const { chunks, write } = collectWrites();
    const resolution = await buildLocalScopeStepUpResume({
      request: { continuationId, toolCallId: "call-1" },
      bindingKey: BINDING,
      tools: ordersTool(() => ({
        isError: true,
        content: [{ type: "text", text: "sign in" }],
        _meta: { "mcp/www_authenticate": [CHALLENGE] },
      })),
    }).resolve(write);

    expect(resolution.kind).toBe("recover");
    expect(
      errorText(
        (resolution as { toolResultMessage: ModelMessage }).toolResultMessage,
      ),
    ).toBe(authChallengeRepeatText("Orders", "get_my_orders"));
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE &&
          chunk.data.outcome === "completed",
      ),
    ).toBe(false);
  });

  it("does not settle a step-up as completed on a `_meta`-challenged replay", async () => {
    const event = createLocalScopeStepUpContinuation({
      bindingKey: BINDING,
      serverId: "Orders",
      toolCallId: "call-2",
      toolName: "get_my_orders",
      toolInput: {},
      challenge: { serverId: "Orders", requiredScope: "orders:write" },
    });
    const { chunks, write } = collectWrites();
    const resolution = await buildLocalScopeStepUpResume({
      request: { continuationId: event.continuationId, toolCallId: "call-2" },
      bindingKey: BINDING,
      tools: ordersTool(() => ({
        isError: true,
        content: [{ type: "text", text: "sign in" }],
        _meta: { "mcp/www_authenticate": CHALLENGE },
      })),
    }).resolve(write);

    expect(resolution.kind).toBe("recover");
    expect(chunks).toHaveLength(0);
  });
});

// ── Send without clicking: the MCPJam engine ───────────────────────────────

const buildSsePayload = (events: unknown[]) =>
  `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(buildSsePayload(events)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

const managerStub = () =>
  ({
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    hasServer: vi.fn().mockReturnValue(true),
    listServers: vi.fn().mockReturnValue(["Orders"]),
    readResource: vi.fn(),
  }) as any;

function modelRequestMessages(fetchMock: ReturnType<typeof vi.fn>): any[] {
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
  const messages =
    typeof body.messages === "string"
      ? JSON.parse(body.messages)
      : body.messages;
  return Array.isArray(messages) ? messages : [];
}

describe("send without clicking — MCPJam engine", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetLocalScopeStepUpContinuationsForTests();
    fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Here are the products." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop" },
      ]),
    );
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __resetLocalScopeStepUpContinuationsForTests();
  });

  async function run(options: Record<string, unknown>) {
    const response = await handleMCPJamFreeChatModel({
      messages: historyWithUnresolvedCall(),
      modelId: "test-model",
      systemPrompt: "sys",
      tools: ordersTool(() => {
        throw new Error("a suspended call must never run again");
      }),
      authHeader: "Bearer test",
      mcpClientManager: managerStub(),
      ...options,
    } as any);
    return response.text();
  }

  it("the cancel request answers the call and the turn continues", async () => {
    const { continuationId } = saveSignIn();
    const body = await run({
      scopeStepUpResume: buildLocalScopeStepUpCancellation({
        request: { continuationId, toolCallId: "call-1" },
        bindingKey: BINDING,
      }),
    });

    expect(body).toContain(
      JSON.stringify(
        authChallengeCancelledText("Orders", "get_my_orders"),
      ).slice(1, -1),
    );
    expect(body).toContain("Here are the products.");
    expect(JSON.stringify(modelRequestMessages(fetchMock))).toContain(
      "the user did not sign in",
    );
  });

  it("a cancel spliced into the new message runs the turn (unknown continuation)", async () => {
    const body = await run({
      settleSuspendedHistoryToolCall: buildLocalSuspendedCallSettlement({
        bindingKey: BINDING,
        splicedCancel: { continuationId: "unknown", toolCallId: "call-1" },
        tools: ordersTool(() => undefined),
        getWriter: () => null,
      }),
      clientSuppliedHistory: true,
    });
    expect(body).toContain("the user did not sign in");
    expect(body).toContain("Here are the products.");
    expect(JSON.stringify(modelRequestMessages(fetchMock))).toContain(
      "never mind, list the products",
    );
  });

  it("history settlement answers the call when no cancel arrives", async () => {
    saveSignIn();
    const settle = ({ toolCallId }: { toolCallId: string }) => {
      const settled = settleLocalAuthChallengeHistoryCall({
        bindingKey: BINDING,
        toolCallId,
      });
      return settled
        ? authChallengeCancelledText(settled.serverName!, settled.toolName)
        : undefined;
    };
    for (const clientSuppliedHistory of [false, true]) {
      __resetLocalScopeStepUpContinuationsForTests();
      saveSignIn();
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(
        sseResponse([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Here are the products." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop" },
        ]),
      );
      const body = await run({
        settleSuspendedHistoryToolCall: settle,
        ...(clientSuppliedHistory ? { clientSuppliedHistory: true } : {}),
      });
      expect(body).toContain('"type":"tool-input-available"');
      expect(body).toContain("the user did not sign in");
      // Not the approval text: the call never waited for an approval.
      expect(body).not.toContain("without an approval the server issued");
      expect(body).toContain("Here are the products.");
      expect(JSON.stringify(modelRequestMessages(fetchMock))).toContain(
        "the user did not sign in",
      );
    }
  });
});

// ── Send without clicking: the direct (BYOK) engine ───────────────────────

function mockModel(seen: unknown[]) {
  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock",
    doStream: async (options) => {
      seen.push(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Here are the products." },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
}

async function runDirect(messages: ModelMessage[]) {
  const seen: unknown[] = [];
  const errors: unknown[] = [];
  const result = streamText({
    model: mockModel(seen),
    messages,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  await result.consumeStream();
  return { seen, errors };
}

describe("send without clicking — direct (BYOK) engine", () => {
  beforeEach(() => __resetLocalScopeStepUpContinuationsForTests());
  afterEach(() => __resetLocalScopeStepUpContinuationsForTests());

  it("fails on the unresolved call without settlement (the bug)", async () => {
    const { errors, seen } = await runDirect(historyWithUnresolvedCall());
    expect(seen).toHaveLength(0);
    expect(String((errors[0] as Error)?.name ?? errors[0])).toContain(
      "MissingToolResults",
    );
  });

  it("history settlement answers the call before the model runs", async () => {
    saveSignIn();
    const history = historyWithUnresolvedCall();
    const { chunks, write } = collectWrites();
    const proceed = await resumeScopeStepUpBeforeDirectTurn({
      writer: { write },
      messageHistory: history,
      settleSuspendedToolCall: ({ toolCallId }) => {
        const settled = settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId,
        });
        return settled
          ? authChallengeCancelledText(settled.serverName!, settled.toolName)
          : undefined;
      },
    });
    expect(proceed).toBe(true);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "tool-input-available",
      "tool-output-available",
    ]);
    expect(history[2]).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "call-1",
          output: {
            type: "error-text",
            value: authChallengeCancelledText("Orders", "get_my_orders"),
          },
        },
      ],
    });

    const { errors, seen } = await runDirect(history);
    expect(errors).toEqual([]);
    expect(JSON.stringify(seen[0])).toContain("the user did not sign in");
  });

  it("the cancel request answers the call before the model runs", async () => {
    const { continuationId } = saveSignIn();
    const history = historyWithUnresolvedCall();
    const proceed = await resumeScopeStepUpBeforeDirectTurn({
      writer: { write: () => undefined },
      messageHistory: history,
      resume: buildLocalScopeStepUpCancellation({
        request: { continuationId, toolCallId: "call-1" },
        bindingKey: BINDING,
      }),
    });
    expect(proceed).toBe(true);
    const { errors, seen } = await runDirect(history);
    expect(errors).toEqual([]);
    expect(JSON.stringify(seen[0])).toContain("the user did not sign in");
  });

  it("leaves calls it did not suspend for the engine's own handling", async () => {
    const history = historyWithUnresolvedCall();
    const settle = vi.fn(() => undefined);
    await resumeScopeStepUpBeforeDirectTurn({
      writer: { write: () => undefined },
      messageHistory: history,
      settleSuspendedToolCall: settle,
    });
    expect(settle).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "get_my_orders",
    });
    expect(history).toHaveLength(3);
  });
});

// ── The cancel the client splices into the user's next message ──────

describe("a cancel spliced into the user's next message", () => {
  beforeEach(() => __resetLocalScopeStepUpContinuationsForTests());
  afterEach(() => __resetLocalScopeStepUpContinuationsForTests());

  const tools = ordersTool(() => {
    throw new Error("never runs");
  });

  function settlement(splicedCancel?: {
    continuationId: string;
    toolCallId: string;
  }) {
    const { chunks, write } = collectWrites();
    const settle = buildLocalSuspendedCallSettlement({
      bindingKey: BINDING,
      ...(splicedCancel ? { splicedCancel } : {}),
      tools,
      getWriter: () => ({ write }),
    });
    return {
      chunks,
      settle: async (call: { toolCallId: string; toolName: string }) =>
        settle(call),
    };
  }

  it("is recognized only when the request ends with a new user message", () => {
    expect(endsWithNewUserMessage(historyWithUnresolvedCall())).toBe(true);
    expect(
      endsWithNewUserMessage(historyWithUnresolvedCall().slice(0, 2)),
    ).toBe(false);
    expect(endsWithNewUserMessage([])).toBe(false);
    expect(endsWithNewUserMessage(undefined)).toBe(false);
  });

  it("cancels a waiting sign-in and answers the call with the sign-in copy", async () => {
    const { continuationId } = saveSignIn();
    const { chunks, settle } = settlement({
      continuationId,
      toolCallId: "call-1",
    });
    await expect(
      settle({ toolCallId: "call-1", toolName: "get_my_orders" }),
    ).resolves.toBe(authChallengeCancelledText("Orders", "get_my_orders"));
    expect(__peekLocalScopeStepUpContinuationForTests(continuationId)).toEqual({
      status: "cancelled",
      inputPresent: false,
    });
    expect(chunks).toEqual([
      expect.objectContaining({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: expect.objectContaining({ continuationId, outcome: "cancelled" }),
      }),
    ]);
  });

  it("answers the call even when the continuation is unknown", async () => {
    const { chunks, settle } = settlement({
      continuationId: "lost-in-a-restart",
      toolCallId: "call-1",
    });
    await expect(
      settle({ toolCallId: "call-1", toolName: "get_my_orders" }),
    ).resolves.toBe(authChallengeCancelledText("Orders", "get_my_orders"));
    expect(chunks).toHaveLength(0);
  });

  it("answers an expired sign-in without a finished part", async () => {
    vi.useFakeTimers();
    try {
      const { continuationId } = saveSignIn();
      vi.advanceTimersByTime(11 * 60_000);
      const { chunks, settle } = settlement({
        continuationId,
        toolCallId: "call-1",
      });
      await expect(
        settle({ toolCallId: "call-1", toolName: "get_my_orders" }),
      ).resolves.toBe(authChallengeCancelledText("Orders", "get_my_orders"));
      expect(chunks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the step-up copy for a step-up the store still knows", async () => {
    const event = createLocalScopeStepUpContinuation({
      bindingKey: BINDING,
      serverId: "Orders",
      toolCallId: "call-2",
      toolName: "cancel_order",
      toolInput: {},
      challenge: { serverId: "Orders", requiredScope: "orders:write" },
    });
    const { settle } = settlement({
      continuationId: event.continuationId,
      toolCallId: "call-2",
    });
    await expect(
      settle({ toolCallId: "call-2", toolName: "cancel_order" }),
    ).resolves.toBe(
      "Authorization was not completed, so the tool was not retried.",
    );
  });

  it("still settles other suspended calls from the store", async () => {
    saveSignIn("call-3");
    const { settle } = settlement({
      continuationId: "other",
      toolCallId: "call-1",
    });
    await expect(
      settle({ toolCallId: "call-3", toolName: "get_my_orders" }),
    ).resolves.toBe(authChallengeCancelledText("Orders", "get_my_orders"));
    await expect(
      settle({ toolCallId: "call-4", toolName: "get_my_orders" }),
    ).resolves.toBeUndefined();
  });

  it("runs the user's message on the direct engine, even for an unknown continuation", async () => {
    const history = historyWithUnresolvedCall();
    const { settle } = settlement({
      continuationId: "lost-in-a-restart",
      toolCallId: "call-1",
    });
    expect(
      await resumeScopeStepUpBeforeDirectTurn({
        writer: { write: () => undefined },
        messageHistory: history,
        settleSuspendedToolCall: settle,
      }),
    ).toBe(true);
    const { errors, seen } = await runDirect(history);
    expect(errors).toEqual([]);
    expect(JSON.stringify(seen[0])).toContain("never mind, list the products");
  });
});
