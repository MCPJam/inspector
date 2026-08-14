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
