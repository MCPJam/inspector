import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { SCOPE_STEP_UP_SUSPEND_CODE } from "@/shared/scope-step-up";
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

describe("mcpjam-stream-handler — a sibling suspends while a step drains before an approval pause", () => {
  // One step, three calls: one that needs approval, one that does not and
  // completes, and one that does not and SUSPENDS (MRTR or scope step-up).
  // The step pauses for the approval, so it first drains the two
  // approval-free calls. The REAL executor is used on purpose: what matters is
  // what it does on a suspend — splice the completed sibling's result into the
  // history, then rethrow.
  const originalFetch = global.fetch;
  let suspendCode = "MRTR_SUSPENDED";
  const suspendSignal = () =>
    Object.assign(new Error("operation suspended"), { code: suspendCode });
  const threeCallStep = [
    {
      type: "tool-input-available",
      toolCallId: "gated-1",
      toolName: "delete_thing",
      input: { id: 7 },
    },
    {
      type: "tool-input-available",
      toolCallId: "free-1",
      toolName: "list_things",
      input: {},
    },
    {
      type: "tool-input-available",
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: {},
    },
    { type: "finish", finishReason: "tool-calls" },
  ];
  const buildTools = () => {
    const gated = vi.fn(async () => ({
      content: [{ type: "text", text: "deleted" }],
    }));
    const free = vi.fn(async () => ({
      content: [{ type: "text", text: "listed" }],
    }));
    const ask = vi.fn(async () => {
      throw suspendSignal();
    });
    return {
      spies: { gated, free, ask },
      tools: {
        delete_thing: { _serverId: "srv", needsApproval: true, execute: gated },
        list_things: { _serverId: "srv", execute: free },
        ask_user: { _serverId: "srv", execute: ask },
      } as any,
    };
  };
  const outputsFor = (toolCallId: string) =>
    writtenChunks.filter(
      (chunk) =>
        chunk?.type === "tool-output-available" &&
        chunk.toolCallId === toolCallId,
    );

  beforeEach(async () => {
    writtenChunks = [];
    lastExecution = null;
    suspendCode = "MRTR_SUSPENDED";
    vi.clearAllMocks();
    const actual = await vi.importActual<
      typeof import("@/shared/http-tool-calls")
    >("@/shared/http-tool-calls");
    vi.mocked(executeToolCallsFromMessages).mockImplementation(
      actual.executeToolCallsFromMessages,
    );
    vi.mocked(hasUnresolvedToolCalls).mockImplementation(
      actual.hasUnresolvedToolCalls,
    );
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    ["an MRTR", "MRTR_SUSPENDED"],
    ["a scope step-up", SCOPE_STEP_UP_SUSPEND_CODE],
  ])(
    "emits the completed sibling's result when %s suspend interrupts the drain, persists it, and still pauses for the approval",
    async (_label, code) => {
      suspendCode = code;
      global.fetch = vi
        .fn()
        .mockResolvedValue(createSseResponse(threeCallStep));
      const { spies, tools } = buildTools();
      const onConversationComplete = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "clean up" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "sys",
        tools,
        mcpClientManager: managerStub(),
        clientSuppliedHistory: true,
        onConversationComplete,
      } as any);
      await lastExecution;

      expect(spies.free).toHaveBeenCalledTimes(1);
      expect(spies.ask).toHaveBeenCalledTimes(1);
      expect(spies.gated).not.toHaveBeenCalled();
      // The client is told the completed sibling's result, exactly once.
      expect(outputsFor("free-1")).toHaveLength(1);
      // The suspended call has no result, and the gated call waits for its pill.
      expect(outputsFor("ask-1")).toHaveLength(0);
      expect(
        writtenChunks.some(
          (chunk) =>
            chunk?.type === "tool-approval-request" &&
            chunk.toolCallId === "gated-1",
        ),
      ).toBe(true);
      expect(writtenChunks.some((chunk) => chunk?.type === "error")).toBe(
        false,
      );
      const history = onConversationComplete.mock.calls[0]?.[0] as any[];
      const resultIds = history
        .filter((message) => message?.role === "tool")
        .flatMap((message) => message.content)
        .filter((part: any) => part.type === "tool-result")
        .map((part: any) => part.toolCallId);
      expect(resultIds).toEqual(["free-1"]);
    },
  );

  it("does not leave the turn stuck: the MRTR resume and then the approval resume complete it without re-running or disowning the sibling", async () => {
    // Request 1: the pause above, to learn the approval id the server minted.
    global.fetch = vi.fn().mockResolvedValue(createSseResponse(threeCallStep));
    const first = buildTools();
    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "clean up" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: first.tools,
      mcpClientManager: managerStub(),
      clientSuppliedHistory: true,
    } as any);
    await lastExecution;
    const approvalId = writtenChunks.find(
      (chunk) => chunk?.type === "tool-approval-request",
    )?.approvalId;
    expect(approvalId).toBeTruthy();
    const freeOutput = outputsFor("free-1")[0]?.output;
    expect(freeOutput).toBeDefined();

    // What the browser now holds: the three calls, the pill, and the
    // completed sibling's result.
    const assistant = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "gated-1",
          toolName: "delete_thing",
          input: { id: 7 },
        },
        { type: "tool-approval-request", approvalId, toolCallId: "gated-1" },
        {
          type: "tool-call",
          toolCallId: "free-1",
          toolName: "list_things",
          input: {},
        },
        {
          type: "tool-call",
          toolCallId: "ask-1",
          toolName: "ask_user",
          input: {},
        },
      ],
    };
    const freeResult = {
      type: "tool-result",
      toolCallId: "free-1",
      toolName: "list_things",
      output: { type: "json", value: freeOutput },
    };
    const askResult = {
      type: "tool-result",
      toolCallId: "ask-1",
      toolName: "ask_user",
      output: { type: "json", value: { answer: "yes" } },
    };

    // Request 2: the user answers the MRTR prompt first. The resume resolves
    // the suspended call; the turn stays paused ONLY because the approval is
    // still open — the drained sibling is neither re-run nor answered.
    writtenChunks = [];
    lastExecution = null;
    global.fetch = vi.fn().mockResolvedValue(createSseResponse(textStep));
    const second = buildTools();
    const resolve = vi.fn(async () => ({
      kind: "complete" as const,
      toolResultMessage: { role: "tool", content: [askResult] } as any,
    }));
    await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "clean up" },
        assistant,
        { role: "tool", content: [freeResult] },
      ] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: second.tools,
      mcpClientManager: managerStub(),
      clientSuppliedHistory: true,
      mrtrResume: { toolCallId: "ask-1", resolve } as MrtrEngineResume,
    } as any);
    await lastExecution;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(second.spies.free).not.toHaveBeenCalled();
    expect(outputsFor("free-1")).toHaveLength(0);
    expect(outputsFor("ask-1")).toHaveLength(1);

    // Request 3: the user approves. The approved call runs, nothing is
    // answered "not run", and the model finishes the turn.
    writtenChunks = [];
    lastExecution = null;
    global.fetch = vi.fn().mockResolvedValue(createSseResponse(textStep));
    const third = buildTools();
    const onConversationComplete = vi.fn();
    await handleMCPJamFreeChatModel({
      messages: [
        { role: "user", content: "clean up" },
        assistant,
        {
          role: "tool",
          content: [
            freeResult,
            askResult,
            { type: "tool-approval-response", approvalId, approved: true },
          ],
        },
      ] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "sys",
      tools: third.tools,
      mcpClientManager: managerStub(),
      clientSuppliedHistory: true,
      onConversationComplete,
    } as any);
    await lastExecution;
    expect(third.spies.gated).toHaveBeenCalledTimes(1);
    expect(third.spies.free).not.toHaveBeenCalled();
    expect(third.spies.ask).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalled();
    expect(JSON.stringify(writtenChunks)).not.toContain("Not run");
    const finalHistory = onConversationComplete.mock.calls[0]?.[0] as any[];
    expect(
      finalHistory
        .filter((message) => message?.role === "assistant")
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .some(
          (part: any) =>
            part?.type === "text" && String(part.text).includes("all done"),
        ),
    ).toBe(true);
  });
});
