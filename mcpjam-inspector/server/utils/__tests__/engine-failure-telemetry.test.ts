/**
 * Mid-stream failures must produce exactly one typed telemetry call — and
 * aborts must produce none.
 *
 * The chat engine answers over a 200 SSE stream, so the HTTP failure events
 * never see anything that goes wrong after headers. `failureReporter`
 * (stream-failure-reporter.ts) is the seam that records those failures as
 * `route.operation.failed`. This suite drives `handleMCPJamFreeChatModel`
 * with the same mocked-backend harness as the SSE snapshot test and pins:
 *   - one reporter call + one `{type:"error"}` wire chunk per failure
 *   - the backend-stream site's hop split (transport failure vs recognized
 *     user-owned denial)
 *   - aborts stay silent in both directions
 *   - the wire error chunk shape is unchanged (client contract)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { originOf } from "@mcpjam/sdk";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import type {
  StreamFailureEvent,
  StreamFailureReporter,
} from "../stream-failure-reporter";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

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
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response("{}", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn(),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function makeReporter(): {
  reporter: StreamFailureReporter;
  calls: StreamFailureEvent[];
} {
  const calls: StreamFailureEvent[] = [];
  const reporter: StreamFailureReporter = (e) => {
    calls.push(e);
    return {
      normalized: e.normalized ?? ({ slug: "internal/unknown" } as any),
      origin: "ambiguous",
    };
  };
  return { reporter, calls };
}

function errorChunks() {
  return writtenChunks.filter((c) => c?.type === "error");
}

/**
 * A real 200 SSE body, so the failure travels the way it does in production:
 * through `parseJsonEventStream` and the chunk switch, not around them.
 */
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function runTurn(overrides: Record<string, unknown> = {}) {
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Hi." }] as any,
    modelId: "openai/gpt-oss-120b",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue([]),
    } as any,
    heartbeatIntervalMs: 0,
    ...overrides,
  } as any);
  await lastExecution;
}

describe("engine failure telemetry", () => {
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

  it("reports a backend /stream transport failure once, with the internal hop", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const { reporter, calls } = makeReporter();

    await runTurn({ failureReporter: reporter });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: "mcp.chat-v2.backend-stream",
      hop: "mcpjam_internal",
      transport: "http_stream",
    });
    // The site classifies from the response itself and passes it through so
    // the reporter never re-derives.
    expect(calls[0].normalized).toBeDefined();
    expect(calls[0].context).toMatchObject({ httpStatus: 502 });

    // Exactly one error chunk on the wire, exact client contract shape.
    const chunks = errorChunks();
    expect(chunks).toHaveLength(1);
    expect(Object.keys(chunks[0]).sort()).toEqual(["errorText", "type"]);
  });

  it("keeps a recognized user-owned denial on the user hop", async () => {
    // HTTP 200 + JSON body = the backend working correctly and refusing for
    // a user-owned reason. It must still be recorded (the turn failed from
    // the user's seat) but on the user hop, so it can never promote to a
    // page.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code: "user_rate_limit",
          error: "Daily limit reached",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { reporter, calls } = makeReporter();

    await runTurn({ failureReporter: reporter });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: "mcp.chat-v2.backend-stream",
      hop: "user_server_hop",
      errorCode: "user_rate_limit",
    });
  });

  it("owns a 401 whose body names MCPJam's own managed key", async () => {
    // End-to-end guard for the blind spot: the backend's `categorizeError`
    // mirrors the UPSTREAM provider's 401 onto its own response when MCPJam's
    // managed Gateway/OpenRouter key is revoked. Classified by status alone
    // that is `provider/auth_error` → `user_config`, and `mcpjam_internal`
    // promotes only `ambiguous` — so a total hosted-chat outage reached the
    // reporter labelled as the user's expired key and could never page.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code: "mcpjam_api_error",
          error: "MCPJam is experiencing a configuration issue.",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { reporter, calls } = makeReporter();

    await runTurn({ failureReporter: reporter });

    expect(calls).toHaveLength(1);
    expect(calls[0].errorCode).toBe("mcpjam_api_error");
    // Not a recognized user-owned denial, so the internal hop still applies —
    // but the verdict no longer depends on it.
    expect(calls[0].hop).toBe("mcpjam_internal");
    expect(originOf(calls[0].normalized)).toBe("mcpjam");
  });

  it("fails the turn on a mid-stream error chunk instead of succeeding", async () => {
    // The second delivery path, and the one HTTP status can never see. The
    // backend's `toUIMessageStreamResponse({onError})` categorizes the failure
    // and serializes it into an error PART on a stream whose headers already
    // said 200. That chunk used to fall into processStream's `default:` and be
    // forwarded verbatim; the loop then returned normally and the turn was
    // recorded as COMPLETED. The user saw an error, telemetry saw a success.
    global.fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: "start" },
      {
        type: "error",
        errorText: JSON.stringify({
          code: "mcpjam_api_error",
          message: "MCPJam is experiencing a configuration issue.",
          statusCode: 401,
          isRetryable: false,
        }),
      },
    ]));
    const { reporter, calls } = makeReporter();
    const onConversationComplete = vi.fn();
    const onEngineError = vi.fn();

    await runTurn({
      failureReporter: reporter,
      onConversationComplete,
      onEngineError,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("mcp.chat-v2.agentic-loop");
    expect(calls[0].errorCode).toBe("mcpjam_api_error");
    // Classified at the chunk, where the structured body still existed.
    // `describeError` on the rethrown Error could only see the sentence.
    expect(originOf(calls[0].normalized)).toBe("mcpjam");

    // The turn took the failure path: engine error fired, and the successful
    // conversation was never persisted.
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onConversationComplete).not.toHaveBeenCalled();

    // Still exactly one error chunk on the wire — site 3's `emitError` writes
    // it, and the raw chunk is deliberately not also forwarded.
    const chunks = errorChunks();
    expect(chunks).toHaveLength(1);
    expect(Object.keys(chunks[0]).sort()).toEqual(["errorText", "type"]);
    // The parsed sentence, not the raw JSON envelope.
    expect(chunks[0].errorText).toBe(
      "MCPJam is experiencing a configuration issue.",
    );
  });

  it("does not claim a mid-stream provider 5xx as MCPJam's", async () => {
    // `statusCode` in an error chunk is the UPSTREAM provider's, copied off
    // its error — not our backend's response status. Reading it with the
    // non-OK path's `>= 500 → mcpjam` rule would page us every time someone
    // else's model was overloaded.
    global.fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: "start" },
      {
        type: "error",
        errorText: JSON.stringify({
          code: "provider_error",
          message: "The AI provider is temporarily unavailable.",
          statusCode: 503,
        }),
      },
    ]));
    const { reporter, calls } = makeReporter();

    await runTurn({ failureReporter: reporter });

    expect(calls).toHaveLength(1);
    expect(originOf(calls[0].normalized)).toBe("ambiguous");
  });

  it("still fails the turn on a non-JSON error chunk", async () => {
    // Any other producer's error chunk. No code, so no ownership claim — but
    // the turn must still not be recorded as a success.
    global.fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: "start" },
      { type: "error", errorText: "something broke" },
    ]));
    const { reporter, calls } = makeReporter();
    const onConversationComplete = vi.fn();

    await runTurn({ failureReporter: reporter, onConversationComplete });

    expect(calls).toHaveLength(1);
    expect(onConversationComplete).not.toHaveBeenCalled();
    expect(errorChunks()[0].errorText).toBe("something broke");
  });

  it("stays completely silent on abort — no report, no error chunk", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(
        Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        }),
      );
    });
    const { reporter, calls } = makeReporter();

    await runTurn({
      failureReporter: reporter,
      abortSignal: controller.signal,
    });

    expect(calls).toHaveLength(0);
    expect(errorChunks()).toHaveLength(0);
  });

  it("stays silent when a NON-abort error lands after the signal fired", async () => {
    // Exercises the `abortSignal?.aborted` arm, not the error-shape arm: the
    // rejection is a plain TypeError, so only the engine actually consulting
    // the signal keeps this silent. Catches a regression where the engine
    // stops listening to abortSignal entirely.
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError("socket hang up"));
    });
    const { reporter, calls } = makeReporter();

    await runTurn({
      failureReporter: reporter,
      abortSignal: controller.signal,
    });

    expect(calls).toHaveLength(0);
  });

  it("reports an unexpected engine throw via the agentic-loop site", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed: ECONNRESET"));
    const { reporter, calls } = makeReporter();

    await runTurn({ failureReporter: reporter });

    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("mcp.chat-v2.agentic-loop");
    expect(calls[0].transport).toBe("http_stream");
    expect(errorChunks()).toHaveLength(1);
  });
});
