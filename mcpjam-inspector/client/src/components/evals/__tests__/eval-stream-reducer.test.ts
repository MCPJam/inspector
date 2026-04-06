import { describe, expect, it } from "vitest";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import {
  initialEvalStreamState,
  mergeStreamingTrace,
  reduceEvalStreamEvent,
} from "../eval-stream-reducer";

describe("eval-stream-reducer", () => {
  it("replaces draft state with authoritative trace snapshots", () => {
    const draftState = [
      { type: "turn_start", turnIndex: 0, prompt: "Hello" },
      { type: "text_delta", content: "Working" },
      {
        type: "tool_call",
        toolName: "search_docs",
        toolCallId: "call-1",
        args: { q: "hello" },
      },
    ].reduce(reduceEvalStreamEvent, initialEvalStreamState);

    const snapshotEvent: EvalStreamEvent = {
      type: "trace_snapshot",
      turnIndex: 0,
      stepIndex: 0,
      snapshotKind: "step_finish",
      trace: {
        traceVersion: 1,
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: "search_docs",
                toolCallId: "call-1",
                input: { q: "hello" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                result: { ok: true },
              },
            ],
          },
        ],
        spans: [
          {
            id: "step-1",
            type: "step",
            name: "Step 1",
            promptIndex: 0,
            stepIndex: 0,
            startMs: 0,
            endMs: 10,
            status: "ok",
          },
        ],
      },
      actualToolCalls: [{ toolName: "search_docs", arguments: { q: "hello" } }],
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
    };

    const state = reduceEvalStreamEvent(draftState, snapshotEvent);

    expect(state.trace).toEqual(snapshotEvent.trace);
    expect(state.draftMessages).toEqual([]);
    expect(state.actualToolCalls).toEqual(snapshotEvent.actualToolCalls);
    expect(state.tokensUsed).toBe(5);
    expect(state.toolCallCount).toBe(1);
  });

  it("merges post-snapshot draft messages for chat/raw while keeping spans authoritative", () => {
    const trace = {
      traceVersion: 1 as const,
      messages: [{ role: "user", content: "Hello" }],
      spans: [
        {
          id: "step-1",
          type: "step" as const,
          name: "Step 1",
          promptIndex: 0,
          stepIndex: 0,
          startMs: 0,
          endMs: 10,
          status: "ok" as const,
        },
      ],
    };

    const merged = mergeStreamingTrace(trace, [
      { role: "assistant", content: "Draft answer" },
    ]);

    expect(merged).toEqual({
      traceVersion: 1,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Draft answer" },
      ],
      spans: trace.spans,
    });
  });
});
