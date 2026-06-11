/**
 * Contract tests for `consumeFullStreamAsEvalEvents` (PR 5a of the
 * engine consolidation in `~/mcpjam-docs/unification.md`).
 *
 * Pre-PR-5a these chunk-to-event translations lived inline in
 * `streamIterationWithAiSdk`. The adapter is byte-shape-equivalent;
 * these tests lock that contract so future stream consumers
 * (PR 5b's backend stream runner; chat reuse) can trust the helper.
 */
import { describe, expect, it } from "vitest";
import { consumeFullStreamAsEvalEvents } from "../stream-adapter";

function asyncStream<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

describe("consumeFullStreamAsEvalEvents", () => {
  it("emits `text_delta` for text-delta chunks", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        { type: "text-delta", id: "t1", text: "Hello " },
        { type: "text-delta", id: "t2", text: "world" },
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([
      { type: "text_delta", content: "Hello " },
      { type: "text_delta", content: "world" },
    ]);
  });

  it("emits `tool_call` for tool-call chunks with normalized args", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "tool_call",
          toolCallId: "tc_1",
          toolName: "lookup",
          input: { q: "hello" },
          dynamic: true,
        },
      ] as any) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    // Adapter listens for `tool-call` not `tool_call` — verify the
    // exact chunk type the AI SDK emits.
    expect(events).toEqual([]);
  });

  it("emits `tool_call` for tool-call chunks (hyphenated chunk type)", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "lookup",
          input: { q: "hello" },
        } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([
      {
        type: "tool_call",
        toolName: "lookup",
        toolCallId: "tc_1",
        args: { q: "hello" },
      },
    ]);
  });

  it("defaults tool-call args to `{}` when input is undefined", async () => {
    // Pre-PR-5a the inline switch used `(part.input ?? {})` for the
    // `args:` field — lock that fallback in case the AI SDK ever
    // surfaces a no-arg tool call as undefined.
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "tool-call",
          toolCallId: "tc_noargs",
          toolName: "ping",
        } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events[0]).toMatchObject({
      type: "tool_call",
      toolName: "ping",
      toolCallId: "tc_noargs",
      args: {},
    });
  });

  it("emits `tool_result` (isError:false) for tool-result chunks", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "tool-result",
          toolCallId: "tc_1",
          toolName: "lookup",
          output: { ok: true },
        } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([
      {
        type: "tool_result",
        toolCallId: "tc_1",
        result: { ok: true },
        isError: false,
      },
    ]);
  });

  it("emits `tool_result` (isError:true) for tool-error chunks", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "tool-error",
          toolCallId: "tc_2",
          toolName: "lookup",
          error: { message: "boom" },
        } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([
      {
        type: "tool_result",
        toolCallId: "tc_2",
        result: { message: "boom" },
        isError: true,
      },
    ]);
  });

  it("emits `step_finish` with the runner-managed step index + usage", async () => {
    // The runner owns the step counter (also used to gate trace span
    // emission and SSE snapshot stepIndex); the adapter reads via
    // `getStepIndex()` so the runner's view stays authoritative.
    let stepIndex = 3;
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        {
          type: "finish-step",
          usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          finishReason: "stop",
        } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => stepIndex },
    );
    expect(events).toEqual([
      {
        type: "step_finish",
        stepNumber: 3,
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    ]);
  });

  it("defaults step_finish usage to zeros when not reported", async () => {
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([{ type: "finish-step" } as any]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events[0]).toMatchObject({
      type: "step_finish",
      stepNumber: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("ignores chunk types outside the eval vocabulary", async () => {
    // AI SDK emits chunk types the runner doesn't translate
    // (text-start, text-end, finish, raw, file, source). The runner
    // consumes terminal state via `result.response` / `.totalUsage`
    // after the stream completes; the adapter MUST stay silent on
    // these so the SSE event stream shape is preserved.
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        { type: "text-start", id: "t1" } as any,
        { type: "text-end", id: "t1" } as any,
        { type: "raw", chunk: "anything" } as any,
        { type: "finish" } as any,
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([]);
  });

  it("preserves chunk order in the emitted event stream", async () => {
    // Snapshot test of a representative multi-event sequence — locks
    // the exact ordering future runners will produce.
    const events: any[] = [];
    await consumeFullStreamAsEvalEvents(
      asyncStream([
        { type: "text-delta", id: "t", text: "Looking up... " },
        {
          type: "tool-call",
          toolCallId: "tc",
          toolName: "lookup",
          input: { q: "x" },
        } as any,
        {
          type: "tool-result",
          toolCallId: "tc",
          toolName: "lookup",
          output: { found: true },
        } as any,
        {
          type: "finish-step",
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        } as any,
        { type: "text-delta", id: "t2", text: "Found it." },
      ]) as any,
      { emit: (e) => events.push(e), getStepIndex: () => 0 },
    );
    expect(events).toEqual([
      { type: "text_delta", content: "Looking up... " },
      {
        type: "tool_call",
        toolName: "lookup",
        toolCallId: "tc",
        args: { q: "x" },
      },
      {
        type: "tool_result",
        toolCallId: "tc",
        result: { found: true },
        isError: false,
      },
      {
        type: "step_finish",
        stepNumber: 0,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { type: "text_delta", content: "Found it." },
    ]);
  });
});
