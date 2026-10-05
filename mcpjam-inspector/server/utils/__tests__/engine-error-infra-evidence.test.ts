/**
 * The emulated engine hands the eval classifier only what our backend TYPED.
 *
 * Both of the backend's failure deliveries — a non-OK `/stream` response and
 * an error chunk on a 200 stream — carry the categorized `{code, statusCode}`
 * envelope. `infra` on the engine event is that envelope and nothing else: the
 * backend's code, and the UPSTREAM provider's status from the body. Our own
 * response status must never stand in for the provider's, because `/stream`
 * answers every failure it could not categorize with `unknown_error` and a
 * bare 500 — which the classifier must leave unclassified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import {
  handleMCPJamFreeChatModel,
  type MCPJamEngineErrorEvent,
} from "../mcpjam-stream-handler";
import { classifyEvalInfraError } from "../../services/evals/infra-error-classification";

let lastExecution: Promise<void> | null = null;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = { write: vi.fn() };
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
  captureOriginErrorToSentry: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

/** As the runner classifies a `/stream` failure: on MCPJam's own keys. */
function classifyOnPlatform(infra: MCPJamEngineErrorEvent["infra"]) {
  return infra
    ? classifyEvalInfraError({ ...infra, endpoint: "platform" })
    : undefined;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function runTurn(response: Response): Promise<MCPJamEngineErrorEvent[]> {
  global.fetch = vi.fn().mockResolvedValue(response);
  const events: MCPJamEngineErrorEvent[] = [];
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
    onEngineError: (event: MCPJamEngineErrorEvent) => events.push(event),
  } as any);
  await lastExecution;
  return events;
}

describe("infra evidence on a non-OK /stream response", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("an uncategorized 500 (`unknown_error`) carries no status and classifies as nothing", async () => {
    const [event] = await runTurn(
      jsonResponse(
        { ok: false, code: "unknown_error", error: "Cannot read properties" },
        500,
      ),
    );
    // Our response status stays a diagnostic...
    expect(event).toMatchObject({ httpStatus: 500, stepIndex: 0 });
    // ...and never becomes the provider's.
    expect(event!.infra).toEqual({
      source: "backend_model",
      code: "unknown_error",
    });
    expect(classifyOnPlatform(event!.infra)).toBeUndefined();
  });

  it("a categorized provider failure carries the UPSTREAM status from the body", async () => {
    const [event] = await runTurn(
      jsonResponse(
        {
          ok: false,
          code: "provider_error",
          error: "The AI provider is temporarily unavailable.",
          statusCode: 503,
          isRetryable: true,
        },
        503,
      ),
    );
    expect(event!.infra).toEqual({
      source: "backend_model",
      code: "provider_error",
      httpStatus: 503,
    });
    expect(classifyOnPlatform(event!.infra)).toMatchObject({
      class: "provider_unavailable",
      layer: "model",
    });
  });

  it("an overload minted from message text (no upstream status) stays unclassified", async () => {
    const [event] = await runTurn(
      jsonResponse(
        {
          ok: false,
          code: "provider_overloaded",
          error: "That model is temporarily overloaded.",
          isRetryable: true,
        },
        500,
      ),
    );
    expect(event!.infra).toEqual({
      source: "backend_model",
      code: "provider_overloaded",
    });
    expect(classifyOnPlatform(event!.infra)).toBeUndefined();
  });

  it("agent_turn_limit is the platform's admission cap, not a timeout", async () => {
    const [event] = await runTurn(
      jsonResponse(
        {
          ok: false,
          code: "agent_turn_limit",
          gatedBy: "burst",
          error: "Too many Ask MCPJam turns in a row. Retry in a moment.",
          isRetryable: true,
          retryAfterMs: 4000,
        },
        429,
      ),
    );
    expect(classifyOnPlatform(event!.infra)).toEqual({
      class: "account_limit",
      layer: "platform",
      retryable: false,
      code: "agent_turn_limit",
    });
  });

  it("a non-JSON body carries no evidence at all", async () => {
    const [event] = await runTurn(new Response("Bad Gateway", { status: 502 }));
    expect(event).toMatchObject({ httpStatus: 502 });
    expect(event).not.toHaveProperty("infra");
  });
});

describe("infra evidence on a mid-stream error chunk", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("carries the backend's code and the provider's status to the outer catch", async () => {
    const events = await runTurn(
      sseResponse([
        { type: "start" },
        {
          type: "error",
          errorText: JSON.stringify({
            code: "mcpjam_rate_limit",
            message: "MCPJam is experiencing high demand.",
            statusCode: 429,
            isRetryable: true,
          }),
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.infra).toEqual({
      source: "backend_model",
      code: "mcpjam_rate_limit",
      httpStatus: 429,
    });
    expect(classifyOnPlatform(events[0]!.infra)).toMatchObject({
      class: "rate_limited",
    });
  });

  it("a non-JSON error chunk carries no evidence", async () => {
    const events = await runTurn(
      sseResponse([
        { type: "start" },
        { type: "error", errorText: "something broke" },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("infra");
  });
});
