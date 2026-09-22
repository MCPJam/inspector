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

  it("accumulates per-step status across step_status events", () => {
    const events: EvalStreamEvent[] = [
      { type: "step_status", turnIndex: 0, kind: "prompt", status: "running" },
      { type: "step_status", turnIndex: 0, kind: "prompt", status: "ok" },
      {
        type: "step_status",
        turnIndex: 1,
        kind: "interact",
        status: "fail",
        detail: "widget not mounted",
      },
    ];
    const state = events.reduce(reduceEvalStreamEvent, initialEvalStreamState);

    // Latest status for a (turn,kind) key wins; distinct keys coexist.
    expect(state.stepStatus["turn-0-prompt"]).toEqual({
      turnIndex: 0,
      stepId: undefined,
      kind: "prompt",
      status: "ok",
      detail: undefined,
    });
    expect(state.stepStatus["turn-1-interact"]).toEqual({
      turnIndex: 1,
      stepId: undefined,
      kind: "interact",
      status: "fail",
      detail: "widget not mounted",
    });
  });

  it("keys step_status by stepId when present", () => {
    const state = reduceEvalStreamEvent(initialEvalStreamState, {
      type: "step_status",
      turnIndex: 0,
      stepId: "step-abc",
      kind: "assert",
      status: "ok",
    });
    expect(state.stepStatus["step-abc"]?.status).toBe("ok");
  });
});

describe("reduceEvalStreamEvent — live browser frames", () => {
  const frame = (over: Record<string, unknown> = {}) => ({
    sequence: 1,
    promptIndex: 0,
    toolCallId: "tc-1",
    stepIndex: 0,
    action: "left_click",
    coordinateX: 12,
    coordinateY: 34,
    thumbnailBase64: "aGk=",
    thumbnailMediaType: "image/jpeg" as const,
    ts: 5_000,
    ...over,
  });

  it("projects a frame onto the persisted step-view shape", () => {
    const state = reduceEvalStreamEvent(initialEvalStreamState, {
      type: "browser_frame",
      frame: frame(),
    } as EvalStreamEvent);

    expect(state.liveBrowserSteps).toHaveLength(1);
    expect(state.liveBrowserSteps[0]).toMatchObject({
      toolCallId: "tc-1",
      stepIndex: 0,
      promptIndex: 0,
      action: "left_click",
      coordinateX: 12,
      // The live channel carries the bytes, not a storage reference — the
      // durable upload hasn't happened yet at capture time.
      screenshotUrl: "data:image/jpeg;base64,aGk=",
    });
    // No video exists until the run ends, so there is nothing to seek to.
    expect(state.liveBrowserSteps[0]?.videoOffsetMs).toBeUndefined();
  });

  it("appends distinct clicks and replaces a re-delivered one", () => {
    let state = reduceEvalStreamEvent(initialEvalStreamState, {
      type: "browser_frame",
      frame: frame(),
    } as EvalStreamEvent);
    state = reduceEvalStreamEvent(state, {
      type: "browser_frame",
      frame: frame({ sequence: 2, stepIndex: 1, action: "type" }),
    } as EvalStreamEvent);
    // A NEWER frame for a click we already have (the harness can re-shoot the
    // same step) replaces it in place — one click, one filmstrip entry.
    state = reduceEvalStreamEvent(state, {
      type: "browser_frame",
      frame: frame({ sequence: 3, stepIndex: 1, action: "type", ts: 9_999 }),
    } as EvalStreamEvent);

    expect(state.liveBrowserSteps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(state.liveBrowserSteps[1]?.ts).toBe(9_999);
  });

  it("merges live steps into the envelope as browserInteractionSteps", () => {
    const state = reduceEvalStreamEvent(initialEvalStreamState, {
      type: "browser_frame",
      frame: frame(),
    } as EvalStreamEvent);

    // No trace snapshot yet — a widget rendered and got clicked inside turn 0.
    // The Replay tab still has to open, so an envelope is still produced.
    const merged = mergeStreamingTrace(
      state.trace,
      state.draftMessages,
      state.liveBrowserSteps,
    );
    expect(merged?.browserInteractionSteps).toHaveLength(1);
  });

  it("ignores a frame whose sequence is not newer", () => {
    let state = reduceEvalStreamEvent(initialEvalStreamState, {
      type: "browser_frame",
      frame: frame({ sequence: 5, stepIndex: 0 }),
    } as EvalStreamEvent);
    // A delayed or replayed frame must not move the view backwards.
    state = reduceEvalStreamEvent(state, {
      type: "browser_frame",
      frame: frame({ sequence: 4, stepIndex: 1 }),
    } as EvalStreamEvent);
    state = reduceEvalStreamEvent(state, {
      type: "browser_frame",
      frame: frame({ sequence: 5, stepIndex: 2 }),
    } as EvalStreamEvent);

    expect(state.liveBrowserSteps.map((s) => s.stepIndex)).toEqual([0]);
    expect(state.liveBrowserFrameSequence).toBe(5);

    // A genuinely newer one still lands.
    state = reduceEvalStreamEvent(state, {
      type: "browser_frame",
      frame: frame({ sequence: 6, stepIndex: 1 }),
    } as EvalStreamEvent);
    expect(state.liveBrowserSteps.map((s) => s.stepIndex)).toEqual([0, 1]);
  });

  it("leaves the envelope null when there is nothing at all", () => {
    expect(mergeStreamingTrace(null, [], [])).toBeNull();
  });
});
