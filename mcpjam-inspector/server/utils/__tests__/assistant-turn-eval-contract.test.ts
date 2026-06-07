/**
 * Eval-contract tests for `runAssistantTurn` (PR 2 of the engine
 * consolidation in `~/mcpjam-docs/unification.md`).
 *
 * Purpose: lock in the configuration eval will rely on when PR 3 rewrites
 * `runIterationViaBackend` to drive `runAssistantTurn` directly. Eval's
 * needs are a strict subset of synthetic's, but the existing
 * `assistant-turn.test.ts` covers chatbox/direct surfaces — these tests
 * exercise eval-only behavior (sourceType:"eval", hosted-org dispatch
 * shape, JAM-paid attribution, the open-ended `extraBodyFields` channel
 * for eval-run attribution) so PR 3's refactor has an explicit safety
 * net.
 *
 * Audit conclusion: zero contract gaps in the engine surface. These
 * tests document and assert that conclusion rather than introduce new
 * surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { runAssistantTurn } from "../assistant-turn";
import type { ModelDefinition } from "@/shared/types";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

const buildSsePayload = (events: any[]) =>
  `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

const createSseResponse = (events: any[]) => {
  const encoder = new TextEncoder();
  const payload = buildSsePayload(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = {
        write: vi.fn((chunk) => {
          writtenChunks.push(chunk);
        }),
      };
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          lastExecution = Promise.resolve(execute({ writer })).then(
            async () => {
              await onFinish?.();
            }
          );
          await lastExecution;
          controller.close();
        },
      });
      return stream;
    }),
    createUIMessageStreamResponse: vi.fn().mockImplementation(({ stream }) => {
      return new Response(stream as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../chat-helpers", async () => {
  const actual = await vi.importActual<typeof import("../chat-helpers")>(
    "../chat-helpers"
  );
  return {
    ...actual,
    scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
    scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
  };
});

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

const baseModelDefinition: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
  name: "Claude Haiku 4.5",
} as ModelDefinition;

/**
 * Minimal stand-in for the inspector's `MCPClientManager`. The engine
 * touches `getAllToolsMetadata()` during tool prep; nothing else is
 * exercised in `streamSink: "none"` mode.
 */
const mcpClientManagerStub = {
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
} as any;

describe("runAssistantTurn — eval contract", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  function setupSuccessfulStream() {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Done." },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
      ])
    );
  }

  it("accepts sourceType:'eval' and threads it to the Convex /stream body", async () => {
    setupSuccessfulStream();

    await runAssistantTurn({
      messages: [{ role: "user", content: "Hello." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "You are an eval-mode assistant.",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      // Eval-specific configuration. These are the four switches PR 3 will
      // pass for every iteration call.
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      // `approvalMode: "auto-deny"` is honored inspector-side (the engine
      // never prompts and auto-rejects pending tool calls); it is NOT
      // forwarded to Convex. The assertion below covers `sourceType` only
      // — the absence of an exception from the call confirms the engine
      // accepted `approvalMode: "auto-deny"` for this `sourceType`.
      approvalMode: "auto-deny",
    });

    await lastExecution;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.sourceType).toBe("eval");
  });

  it("returns the transcript synchronously for streamSink:'none' — no Response, no caller callback", async () => {
    setupSuccessfulStream();

    // Eval consumes the transcript via the return value, NOT via
    // onConversationComplete. Asserting that:
    //   (a) the result object carries `messages` + `turnTrace`;
    //   (b) the caller-supplied `onConversationComplete` is NOT invoked
    //       (eval owns its writer via persistEvalTraceFanout);
    //   (c) no Hono Response is built (eval has no HTTP context).
    const callerOnConversationComplete = vi.fn();

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Hello." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      onConversationComplete: callerOnConversationComplete,
    });

    await lastExecution;

    // (a) Transcript + turnTrace populated by engine's internal capture tap.
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.turnTrace).toBeDefined();
    expect(result.turnTrace?.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
    });
    expect(result.finishReason).toBe("stop");

    // (b) Caller's onConversationComplete suppressed in persistMode:"caller".
    expect(callerOnConversationComplete).not.toHaveBeenCalled();

    // (c) No Hono Response — eval is not an HTTP route.
    expect(result.response).toBeUndefined();
  });

  it("threads hosted-org BYOK dispatch (endpointPath:'/stream/org' + providerKey)", async () => {
    setupSuccessfulStream();

    // Mirrors what PR 3's `dispatchEvalTurn` will pass when the test
    // runs against a hosted-org BYOK provider — `endpointPath` flips to
    // `/stream/org` and the providerKey + org-target ride on
    // `extraBodyFields`, exactly like `handleHostedOrgChatModel` does
    // for live chat today.
    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      endpointPath: "/stream/org",
      extraBodyFields: {
        providerKey: "byok_anthropic_prod",
        projectId: "proj_test",
      },
    });

    await lastExecution;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = (global.fetch as any).mock.calls[0]?.[0];
    expect(fetchUrl).toBe("https://test-convex.example.com/stream/org");

    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.providerKey).toBe("byok_anthropic_prod");
    expect(fetchBody.projectId).toBe("proj_test");
  });

  it("forwards JAM-paid billing target via extraBodyFields", async () => {
    setupSuccessfulStream();

    // JAM-paid eval path: `runIterationViaBackend` builds
    // `extraBodyFields: { ...jamBillingTarget }` so Convex wallet rules
    // can attribute the cost. The engine must thread it untouched.
    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      // No endpointPath override → defaults to "/stream" (the JAM-paid endpoint).
      extraBodyFields: {
        projectId: "proj_jam_test",
      },
    });

    await lastExecution;

    const fetchUrl = (global.fetch as any).mock.calls[0]?.[0];
    expect(fetchUrl).toBe("https://test-convex.example.com/stream");

    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.projectId).toBe("proj_jam_test");
  });

  it("forwards eval-attribution fields verbatim via extraBodyFields (open-ended channel)", async () => {
    setupSuccessfulStream();

    // PR 3 may attach eval-run/iteration identifiers to extraBodyFields
    // for backend-side usage attribution. The engine doesn't (and
    // shouldn't) reject unknown fields — they ride alongside any known
    // keys per `feedback_bridge_preserves_unknown_fields`.
    await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      extraBodyFields: {
        providerKey: "byok_anthropic_prod",
        evalRunId: "run_12345",
        evalIterationId: "iter_abc",
        evalSuiteId: "suite_98765",
      },
    });

    await lastExecution;

    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
    );
    expect(fetchBody.evalRunId).toBe("run_12345");
    expect(fetchBody.evalIterationId).toBe("iter_abc");
    expect(fetchBody.evalSuiteId).toBe("suite_98765");
    // Verify they don't displace known fields.
    expect(fetchBody.providerKey).toBe("byok_anthropic_prod");
  });

  it("accepts selectedServerIds (engine consumes inspector-side for history scrubbing)", async () => {
    setupSuccessfulStream();

    // Eval pre-builds the tool set via `prepareChatV2` and passes it as
    // `tools`. Tool definitions sent to Convex come straight from that
    // map via `serializeToolsForConvex(tools)`. `selectedServerIds` is
    // a separate signal threaded into the engine for MCP-Apps /
    // ChatGPT-Apps tool-result history scrubbing
    // (`scrubMcpAppsToolResultsForBackend` /
    // `scrubChatGPTAppsToolResultsForBackend` consume it before the
    // messages are forwarded). It does NOT filter the tool set and does
    // NOT appear in the request body. PR 3 will still pass it for
    // parity with chat; assert the call succeeds with the option
    // present.
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Hi." }] as any,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      selectedServerIds: ["srv-alpha", "srv-beta"],
    });

    await lastExecution;

    // Documents the inspector-side consumption: option accepted, call
    // completes, transcript captured. Wire-body assertion intentionally
    // omitted — adding one would be testing an implementation detail
    // outside the contract.
    expect(result.turnTrace).toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the caller's input messages array", async () => {
    setupSuccessfulStream();

    // Eval's per-turn loop reuses a `conversation` array as the
    // accumulator: pre-call snapshot must remain untouched until the
    // caller decides to overwrite it from `result.messages`. The engine
    // already shallow-copies internally; this asserts no regression.
    const inputMessages = [{ role: "user", content: "Hi." }] as any;
    const originalLength = inputMessages.length;

    const result = await runAssistantTurn({
      messages: inputMessages,
      modelDefinition: baseModelDefinition,
      systemPrompt: "",
      tools: {},
      mcpClientManager: mcpClientManagerStub,
      authContext: {
        kind: "user_bearer",
        token: "Bearer convex-auth-token",
      },
      sourceType: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
    });

    await lastExecution;

    expect(inputMessages).toHaveLength(originalLength);
    // The result's `messages` is a separate array the engine assembled.
    expect(result.messages).not.toBe(inputMessages);
  });
});
