/**
 * Load-bearing byte-equivalence snapshot for `handleMCPJamFreeChatModel`.
 *
 * Stage 1 of the synthetic-chatbox refactor extracts a new
 * `runAssistantTurn` public surface that the live chat handler is
 * expected to delegate to. This test pins the SSE chunk sequence
 * emitted by the engine for a fixed input fixture so the refactor can
 * be validated as a true no-behavior-change rewrite.
 *
 * The fixture intentionally exercises:
 *   - turn_start trace event
 *   - request_payload trace event
 *   - text streaming (text-start, text-delta, text-end)
 *   - one tool call with a server-execute result
 *   - trace snapshots between steps
 *   - finish chunk with usage metadata
 *
 * If you legitimately need to change the chunk shape (e.g. a new trace
 * event), update the snapshot in the same commit as the engine change
 * and call it out in the PR. Drift caught here usually means the new
 * code path is no longer byte-equivalent with the live chat path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";

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
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response("{}", {
        headers: { "Content-Type": "text/event-stream" },
      })
    ),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn(),
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
  serializeToolsForConvex: vi.fn(() => [
    { name: "fetch_doc", description: "Fetch a doc", inputSchema: {} },
  ]),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

/**
 * Strip non-deterministic fields from chunks so the snapshot is stable
 * across runs. The agent loop stamps timestamps and ids into trace
 * events; only the chunk *shape* is load-bearing here.
 */
function normalizeChunk(chunk: any): any {
  if (!chunk || typeof chunk !== "object") return chunk;
  const clone = JSON.parse(JSON.stringify(chunk));
  walkAndScrub(clone);
  return clone;
}

function walkAndScrub(node: any): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAndScrub(item);
    return;
  }
  for (const key of Object.keys(node)) {
    if (
      key === "turnId" ||
      key === "startedAtMs" ||
      key === "startedAt" ||
      key === "endedAt" ||
      key === "promptStartedAt" ||
      key === "stepStartedAt"
    ) {
      if (typeof node[key] === "number") node[key] = "<timestamp>";
      else if (typeof node[key] === "string") node[key] = "<id>";
    } else if (key === "spans" && Array.isArray(node[key])) {
      node[key] = node[key].map(() => "<span>");
    } else {
      walkAndScrub(node[key]);
    }
  }
}

describe("handleMCPJamFreeChatModel SSE byte-equivalence snapshot", () => {
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

  it("emits a stable SSE chunk sequence for a text-only turn", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hello " },
        { type: "text-delta", id: "text-1", delta: "world." },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      ])
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Greet me." }] as any,
      modelId: "openai/gpt-oss-120b",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      heartbeatIntervalMs: 0,
    });

    await lastExecution;

    expect(writtenChunks.map(normalizeChunk)).toMatchSnapshot();
  });

  it("emits a stable SSE chunk sequence for a single-tool-call turn", async () => {
    // First call: assistant emits a tool call, then we expect the loop
    // to mark unresolved tool calls and run executeToolCallsFromMessages.
    // Second call: assistant emits a final text response and finish.
    let fetchCallIndex = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      const callIndex = fetchCallIndex++;
      if (callIndex === 0) {
        return Promise.resolve(
          createSseResponse([
            {
              type: "tool-input-available",
              toolCallId: "call-1",
              toolName: "fetch_doc",
              input: { id: "abc" },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            },
          ])
        );
      }
      return Promise.resolve(
        createSseResponse([
          { type: "text-start", id: "text-2" },
          { type: "text-delta", id: "text-2", delta: "Got it." },
          { type: "text-end", id: "text-2" },
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
          },
        ])
      );
    });

    // After the first /stream call lands the tool-call, the loop checks
    // hasUnresolvedToolCalls and runs executeToolCallsFromMessages. The
    // mock returns a tool result and the loop continues with a second
    // /stream call that produces the text response.
    let unresolvedSeen = 0;
    vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
      const wasUnresolved = unresolvedSeen === 0;
      unresolvedSeen += 1;
      return wasUnresolved;
    });
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "fetch_doc",
            output: { type: "json", value: { ok: true } },
          },
        ],
      } as any,
    ]);

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Fetch doc abc." }] as any,
      modelId: "openai/gpt-oss-120b",
      systemPrompt: "You are helpful",
      tools: {
        fetch_doc: {
          description: "Fetch a doc",
          inputSchema: {} as any,
          execute: vi.fn(),
        } as any,
      },
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      heartbeatIntervalMs: 0,
    });

    await lastExecution;

    expect(writtenChunks.map(normalizeChunk)).toMatchSnapshot();
  });
});
