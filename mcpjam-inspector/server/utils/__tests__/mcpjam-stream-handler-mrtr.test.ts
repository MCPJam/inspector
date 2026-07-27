import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeToolCallsFromMessages } from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import type { MrtrEngineResume } from "../mrtr-hosted-chat.js";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

const buildSsePayload = (events: any[]) =>
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;

const createSseResponse = (events: any[]) => {
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

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = { write: vi.fn((chunk) => writtenChunks.push(chunk)) };
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi
      .fn()
      .mockReturnValue(
        new Response("{}", { headers: { "Content-Type": "text/event-stream" } }),
      ),
  };
});

vi.mock("@/shared/http-tool-calls", async () => {
  const actual = await vi.importActual<typeof import("@/shared/http-tool-calls")>(
    "@/shared/http-tool-calls",
  );
  return {
    ...actual,
    hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
    executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

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

const textStep = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "all done" },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop" },
];

const toolCallStep = [
  {
    type: "tool-input-available",
    toolCallId: "call-1",
    toolName: "do_thing",
    input: { x: 1 },
  },
  { type: "finish", finishReason: "stop" },
];

describe("mcpjam-stream-handler — hosted MRTR (§12.5)", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    writtenChunks = [];
    lastExecution = null;
    vi.clearAllMocks();
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
    global.fetch = vi.fn().mockResolvedValue(createSseResponse(textStep));
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("suspends WITHOUT blocking the worker when a tool call returns input_required", async () => {
    // Model emits a tool-call; executing it throws the suspend signal.
    global.fetch = vi.fn().mockResolvedValue(createSseResponse(toolCallStep));
    vi.mocked(executeToolCallsFromMessages).mockRejectedValue(
      Object.assign(new Error("suspended"), { code: "MRTR_SUSPENDED" }),
    );
    const onConversationComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "do it" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: { do_thing: { _serverId: "srv" } } as any,
      mcpClientManager: managerStub(),
      onConversationComplete,
    } as any);
    await lastExecution;

    // Worker returned control: the turn finished (persisted) instead of hanging,
    // and no error chunk was emitted for the suspend.
    expect(onConversationComplete).toHaveBeenCalledTimes(1);
    expect(writtenChunks.some((c) => c?.type === "error")).toBe(false);
    // The suspended tool-call is still UNRESOLVED in the persisted history.
    const history = onConversationComplete.mock.calls[0][0] as any[];
    const hasUnresolved =
      history.some(
        (m) =>
          m?.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "tool-call"),
      ) && !history.some((m) => m?.role === "tool");
    expect(hasUnresolved).toBe(true);
  });

  it("resumes: drives the leg, splices the result, and runs the model to a final assistant message", async () => {
    const resolve = vi.fn(async () => ({
      kind: "complete" as const,
      toolResultMessage: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "do_thing",
            output: { type: "json", value: { ok: true } },
            result: { ok: true },
            serverId: "srv",
          },
        ],
      } as any,
    }));
    const mrtrResume: MrtrEngineResume = { toolCallId: "call-1", resolve };
    const onConversationComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "do_thing", input: {} },
          ],
        },
      ] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: { do_thing: { _serverId: "srv" } } as any,
      mcpClientManager: managerStub(),
      mrtrResume,
      onConversationComplete,
    } as any);
    await lastExecution;

    expect(resolve).toHaveBeenCalledTimes(1);
    // The model WAS called after the splice (agent loop resumed).
    expect(global.fetch).toHaveBeenCalled();
    const history = onConversationComplete.mock.calls[0][0] as any[];
    // The driven tool-result is spliced in...
    expect(
      history.some(
        (m) =>
          m?.role === "tool" &&
          m.content.some((p: any) => p.toolCallId === "call-1"),
      ),
    ).toBe(true);
    // ...and a final assistant text message followed.
    const finalText = history
      .filter((m) => m?.role === "assistant")
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .some((p: any) => p?.type === "text" && String(p.text).includes("all done"));
    expect(finalText).toBe(true);
  });

  it("re-suspends on resume (next round) WITHOUT calling the model", async () => {
    const resolve = vi.fn(async () => ({ kind: "suspended" as const, round: 2 }));
    const onConversationComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "do_thing", input: {} },
          ],
        },
      ] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: { do_thing: { _serverId: "srv" } } as any,
      mcpClientManager: managerStub(),
      mrtrResume: { toolCallId: "call-1", resolve } as MrtrEngineResume,
      onConversationComplete,
    } as any);
    await lastExecution;

    expect(resolve).toHaveBeenCalledTimes(1);
    // Paused again: the model was NOT run.
    expect(global.fetch).not.toHaveBeenCalled();
    // Still persisted (partial), with the tool-call unresolved.
    expect(onConversationComplete).toHaveBeenCalledTimes(1);
  });

  it("halts on an indeterminate resume WITHOUT fabricating a result or calling the model", async () => {
    const resolve = vi.fn(async () => ({
      kind: "halted" as const,
      outcome: "indeterminate" as const,
      reason: "lease expired",
    }));
    const onConversationComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "do_thing", input: {} },
          ],
        },
      ] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: { do_thing: { _serverId: "srv" } } as any,
      mcpClientManager: managerStub(),
      mrtrResume: { toolCallId: "call-1", resolve } as MrtrEngineResume,
      onConversationComplete,
    } as any);
    await lastExecution;

    expect(global.fetch).not.toHaveBeenCalled();
    const history = onConversationComplete.mock.calls[0][0] as any[];
    // No tool-result was fabricated for the indeterminate side-effecting op.
    expect(history.some((m) => m?.role === "tool")).toBe(false);
  });
});
