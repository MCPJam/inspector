import { MCPClientManager } from "@mcpjam/sdk";
import { tool, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runChatEngineLoop } from "../mcpjam-stream-handler.js";

/**
 * The OpenAI Responses API replays an earlier reply by item id, and refuses a
 * message item whose reasoning item is missing. So the `rs_…` the backend
 * streamed has to survive into the NEXT request this turn makes — including
 * when the model asked for no reasoning summary and the block is empty, which
 * is the ordinary case.
 *
 * This drives the real chunk path: backend stream in, outbound request out.
 */

// These tests exercise the hosted engine, which does not invoke a harness.
vi.mock("../harness/run-harness-turn", () => ({ runHarnessTurn: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const ping = tool({
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

const OPENAI_REASONING_METADATA = {
  openai: { itemId: "rs_1", reasoningEncryptedContent: null },
};

/** What the Responses API streams for a reasoning block with no summary. */
const emptyReasoning = [
  {
    type: "reasoning-start",
    id: "rs_1:0",
    providerMetadata: OPENAI_REASONING_METADATA,
  },
  {
    type: "reasoning-end",
    id: "rs_1:0",
    providerMetadata: OPENAI_REASONING_METADATA,
  },
];

const finish = {
  type: "finish",
  finishReason: "stop",
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

/** Step 1 reasons and calls a tool; step 2 answers. */
function captureHostedRequests(): Array<{ messages: ModelMessage[] }> {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  const requests: Array<{ messages: ModelMessage[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ messages: JSON.parse(body.messages) });
      return sse(
        requests.length === 1
          ? [
              ...emptyReasoning,
              {
                type: "tool-input-available",
                toolCallId: "ping-1",
                toolName: "ping",
                input: {},
              },
              finish,
            ]
          : [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Done." },
              { type: "text-end", id: "answer" },
              finish,
            ],
      );
    }),
  );
  return requests;
}

function reasoningPartsOf(messages: ModelMessage[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === "reasoning");
}

describe("Responses reasoning on the hosted path", () => {
  it("carries a streamed empty reasoning item into the next request", async () => {
    const requests = captureHostedRequests();

    await runChatEngineLoop(
      {
        messages: [{ role: "user", content: "think, then ping" }],
        modelId: "gpt-5",
        provider: "openai",
        systemPrompt: "",
        tools: { ping },
        mcpClientManager: new MCPClientManager(),
        endpointPath: "/stream/org",
        extraBodyFields: { providerKey: "openai" },
      },
      "none",
    );

    expect(requests).toHaveLength(2);
    // Without the item id the converter emits no reasoning item at all, and
    // OpenAI rejects the reply's `msg_…` reference that goes with it.
    expect(reasoningPartsOf(requests[1].messages)).toEqual([
      { type: "reasoning", text: "", providerOptions: OPENAI_REASONING_METADATA },
    ]);
  });
});
