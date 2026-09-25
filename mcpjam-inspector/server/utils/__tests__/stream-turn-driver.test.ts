import { describe, it, expect } from "vitest";
import {
  StreamTurnDriver,
  TurnOutcomeBuilder,
  classifyCatch,
  createCancellationReason,
  turnCancellationSourceOf,
  type ChunkWriter,
  type TurnOutcomeBuilderOptions,
} from "../stream-turn-driver.js";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  pauseKindOf,
  terminationOf,
  turnOutcomeRecordZ,
} from "@/shared/turn-outcome";

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

// ---------------------------------------------------------------------------
// TurnOutcomeBuilder — the race table from the contract's Layer 2.
//
// These are not defensive assertions about a state machine; each row is a race
// that actually happens in production, and the wrong answer to it is a wrong
// claim in a persisted record. They are written as the table rather than as
// prose so a later edit to the transitions has to change the table too.
// ---------------------------------------------------------------------------

function makeBuilder(
  overrides: Partial<TurnOutcomeBuilderOptions> = {},
): TurnOutcomeBuilder {
  let tick = 0;
  return new TurnOutcomeBuilder({
    engine: "emulated",
    modelAccess: "hosted",
    now: () => 1_750_000_000_000 + tick++,
    ...overrides,
  });
}

describe("TurnOutcomeBuilder state machine", () => {
  it("running → any terminal settles on that terminal", () => {
    expect(
      (() => {
        const b = makeBuilder();
        b.markCompleted("stop");
        return b.record().lifecycle;
      })(),
    ).toBe("completed");
    expect(
      (() => {
        const b = makeBuilder();
        b.markCancelled("client_disconnect");
        return b.record().lifecycle;
      })(),
    ).toBe("cancelled");
    expect(
      (() => {
        const b = makeBuilder();
        b.markTimedOut({ clock: "turn", budgetMs: 10, elapsedMs: 11 });
        return b.record().lifecycle;
      })(),
    ).toBe("timed_out");
    expect(
      (() => {
        const b = makeBuilder();
        b.markFailed({ errorSource: "setup" });
        return b.record().lifecycle;
      })(),
    ).toBe("failed");
  });

  it("STOP RACES COMPLETION: a cancel that arrives after the finish is superseded", () => {
    // `finishTurn` already ran, so the abort changed nothing about this turn.
    // Recording it as cancelled would report a turn the user actually received
    // as one they stopped.
    const b = makeBuilder();
    b.markCompleted("stop");
    b.markCancelled("client_disconnect");
    const record = b.record();
    expect(record.lifecycle).toBe("completed");
    // `completed` FORBIDS a termination, so the superseded diagnosis is dropped
    // rather than smuggled in beside a completion.
    expect(terminationOf(record)).toBeUndefined();
  });

  it("STOP BEFORE COMPLETION: a late stream completion is superseded", () => {
    const b = makeBuilder();
    b.markCancelled("client_disconnect");
    b.markCompleted("stop");
    const record = b.record();
    expect(record.lifecycle).toBe("cancelled");
    expect(terminationOf(record)?.cancellationSource).toBe("client_disconnect");
    expect(terminationOf(record)?.superseded).toEqual([
      { mark: "completed", at: expect.any(Number) },
    ]);
  });

  it("FAILURE THEN COMPLETION: the provider's `onFinish` does not undo `onError`", () => {
    // `streamText` fires `onError` and THEN `onFinish` for a terminal stream
    // error, so the engine's completion mark genuinely lands on a turn that
    // already failed. Letting it win would report the most expensive kind of
    // wrong answer this contract can produce: a turn that broke, filed as one
    // that worked, with a partial transcript to back it up.
    const b = makeBuilder();
    b.markFailed({ errorSource: "model", errorCode: "provider_5xx" });
    b.markCompleted("stop");
    const record = b.record();
    expect(record.lifecycle).toBe("failed");
    expect(terminationOf(record)?.errorCode).toBe("provider_5xx");
    expect(terminationOf(record)?.superseded).toEqual([
      { mark: "completed", at: expect.any(Number) },
    ]);
  });

  it("PAUSE THEN CLEANUP FAILURE: a pause whose commit failed is not a pause", () => {
    // The harness approval pause commits its sidecar standalone; if that commit
    // fails the lease is released and the pause is LOST. Still claiming
    // `paused` would promise a resume that can never happen.
    const b = makeBuilder({ engine: "harness", harness: "claude-code" });
    b.markPaused("tool_approval");
    b.markFailed({ errorSource: "setup", errorCode: "harness_finalize_failed" });
    const record = b.record();
    expect(record.lifecycle).toBe("failed");
    expect(pauseKindOf(record)).toBeUndefined();
    expect(terminationOf(record)?.errorCode).toBe("harness_finalize_failed");
  });

  it("PAUSE THEN CANCEL: a paused turn the user stopped is cancelled", () => {
    const b = makeBuilder();
    b.markPaused("tool_approval");
    b.markCancelled("caller");
    expect(b.record().lifecycle).toBe("cancelled");
  });

  it("PAUSE THEN COMPLETE / TIMEOUT: ignored, the pause stands", () => {
    const completed = makeBuilder();
    completed.markPaused("scope_step_up");
    completed.markCompleted("stop");
    expect(completed.record().lifecycle).toBe("paused");

    const timedOut = makeBuilder();
    timedOut.markPaused("tool_approval");
    timedOut.markTimedOut({ clock: "turn", budgetMs: 1, elapsedMs: 2 });
    const record = timedOut.record();
    expect(record.lifecycle).toBe("paused");
    expect(pauseKindOf(record)).toBe("tool_approval");
    expect(terminationOf(record)?.superseded?.map((s) => s.mark)).toEqual([
      "timed_out",
    ]);
  });

  it("terminal → anything is ignored and appended to superseded", () => {
    const b = makeBuilder();
    b.markFailed({ errorSource: "model", errorCode: "UPSTREAM_ERROR" });
    b.markTimedOut({ clock: "run", budgetMs: 1, elapsedMs: 2 });
    b.markCancelled("lease_lost");
    const record = b.record();
    expect(record.lifecycle).toBe("failed");
    expect(terminationOf(record)?.errorCode).toBe("UPSTREAM_ERROR");
    expect(terminationOf(record)?.timeout).toBeUndefined();
    expect(terminationOf(record)?.cancellationSource).toBeUndefined();
    expect(terminationOf(record)?.superseded?.map((s) => s.mark)).toEqual([
      "timed_out",
      "cancelled",
    ]);
  });

  it("NO TERMINAL MARK degrades to failed/setup — never to completed", () => {
    // A path that forgot to mark its ending is a bug. Reporting it as success
    // is how the original defect stayed invisible.
    const record = makeBuilder().record();
    expect(record.lifecycle).toBe("failed");
    expect(terminationOf(record)?.errorSource).toBe("setup");
    expect(terminationOf(record)?.errorCode).toBe("no_terminal_mark");
  });

  it("carries the harness id even on the emulated engine (scope step-up resume)", () => {
    const b = makeBuilder({ engine: "emulated", harness: "claude-code" });
    b.markPaused("scope_step_up");
    expect(b.record().runtime).toEqual({
      engine: "emulated",
      harness: "claude-code",
      modelAccess: "hosted",
    });
  });

  it("every record it produces satisfies the contract's invariants", () => {
    const cases: Array<(b: TurnOutcomeBuilder) => void> = [
      (b) => b.markCompleted("stop"),
      (b) => b.markCancelled("liveness_lost"),
      (b) => b.markTimedOut({ clock: "session", budgetMs: 5, elapsedMs: 6 }),
      (b) => b.markFailed({ errorSource: "model", errorHttpStatus: 529 }),
      (b) => b.markPaused("tool_approval"),
      () => {},
    ];
    for (const apply of cases) {
      const b = makeBuilder();
      apply(b);
      const parsed = turnOutcomeRecordZ.safeParse(b.record());
      expect(parsed.success).toBe(true);
    }
  });
});

describe("TurnOutcomeBuilder tool dispatch/settle", () => {
  it("distinguishes a call that never started from one whose outcome is unknown", () => {
    const b = makeBuilder();
    b.markToolDispatched("call-dispatched");
    b.markToolDispatched("call-settled");
    b.markToolSettled("call-settled");
    expect(b.unresolvedToolCallState("call-dispatched")).toBe(
      "outcome_unknown",
    );
    // A settled call is not unresolved at all; asked about anyway, it reads as
    // the harmless state — callers only ask about calls with no result.
    expect(b.unresolvedToolCallState("call-settled")).toBe("never_started");
    expect(b.unresolvedToolCallState("call-never-seen")).toBe("never_started");
  });

  it("records the unresolved list the caller hands it", () => {
    const b = makeBuilder();
    b.markCancelled("client_disconnect");
    const record = b.record([
      {
        toolCallId: "c1",
        toolName: "create_invoice",
        state: "outcome_unknown",
      },
    ]);
    expect(terminationOf(record)?.unresolvedToolCalls).toEqual([
      { toolCallId: "c1", toolName: "create_invoice", state: "outcome_unknown" },
    ]);
  });

  it("merges calls the BUILDER witnessed that the transcript does not carry", () => {
    // The harness flushes its assistant segment after the stream settles, so a
    // turn cancelled mid-stream has the tool call nowhere in the history. A
    // record derived from the transcript alone would report NO unresolved calls
    // for exactly the turn most likely to have left one running in a sandbox.
    const b = makeBuilder({ engine: "harness", harness: "claude-code" });
    b.markToolDispatched("call-in-sandbox", "charge_card");
    b.markCancelled("client_disconnect");
    // Nothing from the transcript — it is empty.
    const record = b.record([]);
    expect(terminationOf(record)?.unresolvedToolCalls).toEqual([
      {
        toolCallId: "call-in-sandbox",
        toolName: "charge_card",
        state: "outcome_unknown",
      },
    ]);
  });

  it("does not duplicate a call the transcript already listed", () => {
    const b = makeBuilder();
    b.markToolDispatched("call-1", "charge_card");
    b.markCancelled("caller");
    const record = b.record([
      {
        toolCallId: "call-1",
        toolName: "charge_card",
        state: "outcome_unknown",
      },
    ]);
    expect(terminationOf(record)?.unresolvedToolCalls).toHaveLength(1);
  });

  it("a SETTLED call is never listed, however it was witnessed", () => {
    const b = makeBuilder();
    b.markToolDispatched("call-1", "charge_card");
    b.markToolSettled("call-1");
    b.markCancelled("caller");
    expect(terminationOf(b.record([]))?.unresolvedToolCalls).toBeUndefined();
  });

  it("a completed turn never carries an unresolved list", () => {
    const b = makeBuilder();
    b.markCompleted("stop");
    const record = b.record([
      { toolCallId: "c1", toolName: "t", state: "never_started" },
    ]);
    expect(terminationOf(record)).toBeUndefined();
  });
});

describe("classifyCatch resolves by evidence, not arrival order", () => {
  const deadlineReason = (clock: string, budgetMs: number) =>
    Object.assign(new Error(`${clock} budget expired`), {
      name: "AbortError",
      clock,
      budgetMs,
    });

  function abortedSignal(reason: unknown): AbortSignal {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  }

  it("a fired deadline reads as timed_out even when a fresh AbortError was thrown", () => {
    // This is the real shape: provider SDKs raise their OWN unstamped
    // AbortError on abort, so the caught error carries none of the deadline's
    // attribution and only the signal's reason does.
    const b = makeBuilder();
    const lifecycle = classifyCatch(b, {
      error: Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
      signal: abortedSignal(deadlineReason("turn", 360_000)),
      errorSource: "model",
      startedAtMs: 1_000,
      now: () => 361_412,
    });
    expect(lifecycle).toBe("timed_out");
    expect(terminationOf(b.record())?.timeout).toEqual({
      clock: "turn",
      budgetMs: 360_000,
      elapsedMs: 360_412,
    });
  });

  it("falls back to the caught error when the signal carries no reason", () => {
    const b = makeBuilder();
    expect(
      classifyCatch(b, {
        error: deadlineReason("iteration", 120_000),
        signal: abortedSignal(undefined),
        errorSource: "model",
        startedAtMs: 0,
        now: () => 120_003,
      }),
    ).toBe("timed_out");
    expect(terminationOf(b.record())?.timeout?.clock).toBe("iteration");
  });

  it("an abort with no clock is a cancellation, sourced from the typed reason", () => {
    const b = makeBuilder();
    expect(
      classifyCatch(b, {
        error: new Error("boom"),
        signal: abortedSignal(
          createCancellationReason("lease_lost", "harness lease lost"),
        ),
        errorSource: "model",
        startedAtMs: 0,
      }),
    ).toBe("cancelled");
    expect(terminationOf(b.record())?.cancellationSource).toBe("lease_lost");
  });

  it("an untyped abort falls back to the caller's declared default", () => {
    const b = makeBuilder({ defaultCancellationSource: "client_disconnect" });
    classifyCatch(b, {
      error: new Error("boom"),
      signal: abortedSignal(undefined),
      errorSource: "model",
      startedAtMs: 0,
    });
    expect(terminationOf(b.record())?.cancellationSource).toBe(
      "client_disconnect",
    );
  });

  it("an error with NO abort is a failure, attributed by errorSource", () => {
    const b = makeBuilder();
    expect(
      classifyCatch(b, {
        error: new Error("provider exploded"),
        signal: undefined,
        errorSource: "setup",
        errorCode: "MCP_CONNECT_FAILED",
        startedAtMs: 0,
      }),
    ).toBe("failed");
    const record = b.record();
    expect(terminationOf(record)?.errorSource).toBe("setup");
    expect(terminationOf(record)?.errorCode).toBe("MCP_CONNECT_FAILED");
  });

  it("reads a deadline through a cause chain", () => {
    const b = makeBuilder();
    const wrapped = Object.assign(new Error("wrapped"), {
      cause: deadlineReason("sandboxCapacity", 60_000),
    });
    expect(
      classifyCatch(b, {
        error: wrapped,
        signal: abortedSignal(wrapped),
        errorSource: "setup",
        startedAtMs: 0,
        now: () => 60_001,
      }),
    ).toBe("timed_out");
    expect(terminationOf(b.record())?.timeout?.clock).toBe("sandboxCapacity");
  });
});

describe("turnCancellationSourceOf", () => {
  it("reads the typed source, including through a cause chain", () => {
    expect(
      turnCancellationSourceOf(
        createCancellationReason("reservation_lost", "gone"),
      ),
    ).toBe("reservation_lost");
    expect(
      turnCancellationSourceOf({
        cause: createCancellationReason("liveness_lost", "gone"),
      }),
    ).toBe("liveness_lost");
  });

  it("returns undefined for an untyped or unknown reason", () => {
    expect(turnCancellationSourceOf(new Error("plain"))).toBeUndefined();
    expect(turnCancellationSourceOf(undefined)).toBeUndefined();
    expect(
      turnCancellationSourceOf({ turnCancellationSource: "network" }),
    ).toBeUndefined();
  });

  it("survives a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(turnCancellationSourceOf(a)).toBeUndefined();
  });
});

describe("StreamTurnDriver stamps the outcome onto the trace", () => {
  it("buildPersistedTrace carries outcomeAtTurn when a builder is wired", () => {
    const outcome = makeBuilder();
    outcome.markCancelled("client_disconnect");
    const driver = new StreamTurnDriver({
      turnId: "turn-1",
      promptIndex: 0,
      modelId: "anthropic/claude",
      engine: "emulated",
      traceBaseMs: 1000,
      spans: [],
      outcome,
    });
    const trace = driver.buildPersistedTrace({
      unresolvedToolCalls: [
        { toolCallId: "c1", toolName: "t", state: "outcome_unknown" },
      ],
    });
    expect(trace.outcomeAtTurn?.lifecycle).toBe("cancelled");
    expect(
      terminationOf(trace.outcomeAtTurn)?.unresolvedToolCalls,
    ).toHaveLength(
      1,
    );
  });

  it("omits outcomeAtTurn entirely when no builder is wired", () => {
    // Absent means UNRECORDED, and must never be laundered into a claim.
    const trace = makeDriver().buildPersistedTrace();
    expect("outcomeAtTurn" in trace).toBe(false);
  });
});
