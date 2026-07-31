import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import type { MrtrEngineResume } from "../mrtr-hosted-chat.js";

const buildSsePayload = (events: unknown[]) =>
  `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

const createSseResponse = (events: unknown[]) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(buildSsePayload(events)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const managerStub = () =>
  ({
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    hasServer: vi.fn().mockReturnValue(true),
    listServers: vi.fn().mockReturnValue(["srv"]),
    readResource: vi.fn(),
  }) as any;

describe("mcpjam stream handler — scope step-up resume wire", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        { type: "text-start", id: "t1" },
        {
          type: "text-delta",
          id: "t1",
          delta: "The protected write completed.",
        },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop" },
      ])
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("streams a previous-response tool result and final assistant text", async () => {
    const scopeStepUpResume: MrtrEngineResume = {
      toolCallId: "call-1",
      resolve: vi.fn(async () => ({
        kind: "complete" as const,
        toolResultMessage: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "bench_write",
              output: { type: "json", value: { ok: true } },
              result: { ok: true },
              serverId: "srv",
            },
          ],
        } as any,
      })),
    };
    const onConversationComplete = vi.fn();

    const response = await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "write it" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "bench_write",
              input: { value: "hello" },
            },
          ],
        },
      ] as any,
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "sys",
      tools: {},
      authHeader: "Bearer test",
      mcpClientManager: managerStub(),
      scopeStepUpResume,
      onConversationComplete,
    } as any);

    const body = await response.text();

    expect(body).toContain('"type":"tool-output-available"');
    expect(body).toContain('"toolCallId":"call-1"');
    expect(body).toContain("The protected write completed.");
    expect(body).toContain("data: [DONE]");
    expect(onConversationComplete).toHaveBeenCalledTimes(1);
  });
});
