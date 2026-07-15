import { describe, it, expect } from "vitest";
import {
  StreamTurnDriver,
  type ChunkWriter,
} from "../stream-turn-driver.js";
import type { EvalTraceSpan } from "@/shared/eval-trace";

function collectingWriter(): { writer: ChunkWriter; chunks: any[] } {
  const chunks: any[] = [];
  return { writer: { write: (c) => chunks.push(c) }, chunks };
}

function makeSpan(id: string): EvalTraceSpan {
  return {
    id,
    name: "span",
    category: "llm",
    startMs: 0,
    endMs: 1,
  };
}

function makeDriver(spans: EvalTraceSpan[] = [], onStepFinish?: any) {
  return new StreamTurnDriver({
    turnId: "turn-1",
    promptIndex: 0,
    modelId: "anthropic/claude",
    engine: "emulated",
    traceBaseMs: 1000,
    spans,
    onStepFinish,
  });
}

describe("StreamTurnDriver", () => {
  it("emitTurnStart writes a turn_start trace event and flips traceStarted", () => {
    const { writer, chunks } = collectingWriter();
    const d = makeDriver();
    expect(d.traceStarted).toBe(false);
    d.emitTurnStart(writer);
    expect(d.traceStarted).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "data-trace-event",
      transient: true,
      data: {
        type: "turn_start",
        turnId: "turn-1",
        promptIndex: 0,
        startedAtMs: 1000,
        engine: "emulated",
      },
    });
  });

  it("can annotate harness-backed turns", () => {
    const { writer, chunks } = collectingWriter();
    const d = new StreamTurnDriver({
      turnId: "turn-1",
      promptIndex: 0,
      modelId: "anthropic/claude",
      engine: "harness",
      harness: "claude-code",
      traceBaseMs: 1000,
      spans: [],
    });

    d.emitTurnStart(writer);

    expect(chunks[0]).toMatchObject({
      data: {
        type: "turn_start",
        engine: "harness",
        harness: "claude-code",
      },
    });
  });

  it("fireStepFinish passes cumulative usage + a DEFENSIVE turnSpans copy", () => {
    const spans = [makeSpan("a")];
    const events: any[] = [];
    const d = makeDriver(spans, (e: any) => events.push(e));
    d.usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
    d.fireStepFinish(0, false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stepIndex: 0,
      promptIndex: 0,
      settledWithError: false,
      turnUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
    // Defensive copy: mutating the shared array after the call must not
    // mutate the snapshot the consumer retained.
    expect(events[0].turnSpans).toHaveLength(1);
    spans.push(makeSpan("b"));
    expect(events[0].turnSpans).toHaveLength(1);
  });

  it("fireStepFinish omits turnUsage when unset and is a no-op without a callback", () => {
    const events: any[] = [];
    const d = makeDriver([], (e: any) => events.push(e));
    d.fireStepFinish(2, true);
    expect(events[0]).toMatchObject({ stepIndex: 2, settledWithError: true });
    expect(events[0].turnUsage).toBeUndefined();

    // No callback → no throw.
    const d2 = makeDriver([]);
    expect(() => d2.fireStepFinish(0, false)).not.toThrow();
  });

  it("fireStepFinish swallows a throwing consumer", () => {
    const d = makeDriver([], () => {
      throw new Error("boom");
    });
    expect(() => d.fireStepFinish(0, false)).not.toThrow();
  });

  it("finishTurn writes the engine finish chunk then turn_finish and marks success", () => {
    const { writer, chunks } = collectingWriter();
    const d = makeDriver();
    d.usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    d.finishReason = "stop";
    const finishChunk = { type: "finish", finishReason: "stop" } as any;
    d.finishTurn(writer, { finishChunk });

    expect(d.runSucceeded).toBe(true);
    expect(chunks[0]).toEqual(finishChunk);
    expect(chunks[1]).toMatchObject({
      type: "data-trace-event",
      data: {
        type: "turn_finish",
        turnId: "turn-1",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
  });

  it("finishTurn does not double-write the finish chunk when alreadyEmittedFinish", () => {
    const { writer, chunks } = collectingWriter();
    const d = makeDriver();
    d.finishTurn(writer, {
      finishChunk: { type: "finish" } as any,
      alreadyEmittedFinish: true,
    });
    // Only turn_finish, no finish chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].data.type).toBe("turn_finish");
  });

  it("emitErrorTurnFinish stays phantom-free before turn_start", () => {
    const { writer, chunks } = collectingWriter();
    const d = makeDriver();
    d.emitErrorTurnFinish(writer);
    expect(chunks).toHaveLength(0); // not started → nothing
    d.emitTurnStart(writer);
    chunks.length = 0;
    d.emitErrorTurnFinish(writer);
    expect(chunks[0].data.type).toBe("turn_finish");
  });

  it("snapshotContext exposes the shared spans + usage", () => {
    const spans = [makeSpan("a")];
    const d = makeDriver(spans);
    d.usage = { totalTokens: 9 };
    const ctx = d.snapshotContext([{ role: "user", content: "hi" } as any]);
    expect(ctx.turnId).toBe("turn-1");
    expect(ctx.promptIndex).toBe(0);
    expect(ctx.turnSpans).toBe(spans); // live ref for the snapshot helper
    expect(ctx.turnUsage).toEqual({ totalTokens: 9 });
  });

  it("buildPersistedTrace captures spans, usage, finishReason, modelId", () => {
    const spans = [makeSpan("a"), makeSpan("b")];
    const d = makeDriver(spans);
    d.usage = { totalTokens: 4 };
    d.finishReason = "length";
    const trace = d.buildPersistedTrace();
    expect(trace).toMatchObject({
      turnId: "turn-1",
      startedAt: 1000,
      promptIndex: 0,
      finishReason: "length",
      modelId: "anthropic/claude",
      usage: { totalTokens: 4 },
    });
    expect(trace.spans).toHaveLength(2);
    // Detached copy: later span pushes don't leak into the persisted trace.
    spans.push(makeSpan("c"));
    expect(trace.spans).toHaveLength(2);
  });
});
