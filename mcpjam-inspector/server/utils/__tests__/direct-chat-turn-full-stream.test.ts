import { describe, expect, it, vi } from "vitest";
import { consumeDirectChatTurnFullStream } from "../direct-chat-turn-full-stream";

const assistant = { role: "assistant", content: "done" } as const;

function partStream(parts: unknown[], failWith?: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      if (failWith !== undefined) throw failWith;
    },
  };
}

function fakeHandle(overrides: {
  fullStream?: unknown;
  response?: unknown;
  streamError?: unknown;
  responseMessages?: unknown[];
  rejectedIds?: string[];
}) {
  const cleanup = vi.fn();
  const consumeStream = vi.fn(async () => {});
  const handle = {
    rejectedToolCallIds: new Set(overrides.rejectedIds),
    result: {
      fullStream: overrides.fullStream,
      consumeStream,
      response: Promise.resolve(overrides.response ?? { modelId: "m-2026" }),
      responseMessages: Promise.resolve(overrides.responseMessages ?? [assistant]),
      steps: Promise.resolve([{ stepNumber: 0 }]),
      totalUsage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }),
      finishReason: Promise.resolve("stop"),
    },
    traceContext: {
      recordedSpans: [{ id: "span-1" }],
      recordedRequestPayloads: [],
    },
    traceTurn: {
      turnId: "turn-1",
      promptIndex: 0,
      turnStartedAt: 100,
      turnUsage: { totalTokens: 3 },
    },
    modelId: "m",
    cleanup,
    isAborted: () => false,
    lastStreamError: () => overrides.streamError,
  };
  return { handle: handle as never, cleanup, consumeStream };
}

describe("consumeDirectChatTurnFullStream", () => {
  it("hands every part over in order, then returns the terminal state", async () => {
    const parts = [
      { type: "text-delta", text: "do" },
      { type: "finish-step", usage: { inputTokens: 2 } },
    ];
    const { handle, cleanup } = fakeHandle({ fullStream: partStream(parts) });
    const onPart = vi.fn();

    const result = await consumeDirectChatTurnFullStream(handle, onPart);

    expect(onPart.mock.calls.map(([part]) => part)).toEqual(parts);
    expect(result).toMatchObject({
      messages: [assistant],
      steps: [{ stepNumber: 0 }],
      totalUsage: { inputTokens: 2, outputTokens: 1 },
      finishReason: "stop",
      upstreamModel: "m-2026",
      aborted: false,
      turnTrace: {
        turnId: "turn-1",
        spans: [{ id: "span-1" }],
        usage: { totalTokens: 3 },
        finishReason: "stop",
        modelId: "m",
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("marks only the refused call when streaming an eval", async () => {
    const calls = ["refused", "retry"].map((toolCallId) => ({
      type: "tool-call", toolName: "echo", toolCallId, input: {},
    }));
    const { handle } = fakeHandle({
      responseMessages: [{ role: "assistant", content: calls }],
      rejectedIds: ["refused"],
    });
    const result = await consumeDirectChatTurnFullStream(handle, vi.fn());
    expect(result.messages).toEqual([{ role: "assistant", content: [
      { ...calls[0], providerOptions: { mcpjam: { rejectedToolCall: true } } },
      calls[1],
    ] }]);
  });

  it("drains with consumeStream when the stream exposes no parts", async () => {
    const { handle, consumeStream } = fakeHandle({
      fullStream: undefined,
      response: { id: "resp-1" },
    });
    const onPart = vi.fn();

    const result = await consumeDirectChatTurnFullStream(handle, onPart);

    expect(consumeStream).toHaveBeenCalledTimes(1);
    expect(onPart).not.toHaveBeenCalled();
    expect(result.messages).toEqual([assistant]);
    // A response that names no model reports none rather than a guess.
    expect(result.upstreamModel).toBeUndefined();
  });

  it("rethrows what the stream threw, after its error part reached onPart", async () => {
    const providerError = new Error("429 from provider");
    const thrown = new Error("No output generated.");
    const { handle, cleanup } = fakeHandle({
      fullStream: partStream([{ type: "error", error: providerError }], thrown),
      streamError: providerError,
    });
    const onPart = vi.fn();

    await expect(consumeDirectChatTurnFullStream(handle, onPart)).rejects.toBe(
      thrown,
    );
    expect(onPart).toHaveBeenCalledWith({
      type: "error",
      error: providerError,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
