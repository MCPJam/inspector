import { describe, expect, it } from "vitest";
import {
  applyPreviewSpansUserMessageIndices,
  buildLiveChatPreviewSpans,
  filterEventsForActiveTurnPreview,
  pickTranscriptForLiveTracePreview,
} from "../live-chat-trace-preview";
import type { LiveChatTraceEvent } from "../live-chat-trace";

const TURN = "trace_turn_1";

describe("filterEventsForActiveTurnPreview", () => {
  it("stops before trace_snapshot for the active turn", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 100 },
      {
        type: "text_delta",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        delta: "hi",
      },
      {
        type: "trace_snapshot",
        turnId: TURN,
        promptIndex: 0,
        snapshot: {
          traceVersion: 1,
          promptIndex: 0,
          messages: [],
          spans: [],
        },
      },
    ];
    const filtered = filterEventsForActiveTurnPreview(events, TURN);
    expect(filtered.map((e) => e.type)).toEqual(["turn_start", "text_delta"]);
  });

  it("ignores other turns", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: "other", promptIndex: 0, startedAtMs: 1 },
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 2 },
    ];
    expect(filterEventsForActiveTurnPreview(events, TURN).length).toBe(1);
  });
});

describe("buildLiveChatPreviewSpans", () => {
  it("returns empty when no active turn", () => {
    expect(
      buildLiveChatPreviewSpans({
        events: [],
        activeTurnId: null,
      }),
    ).toEqual([]);
  });

  it("emits step + Agent after turn_start only", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 10_000 },
    ];
    const spans = buildLiveChatPreviewSpans({ events, activeTurnId: TURN });
    expect(spans.map((s) => s.category)).toEqual(["step", "llm"]);
    expect(spans[1]!.name).toBe("Agent");
    expect(spans[1]!.parentId).toBe(spans[0]!.id);
  });

  it("extends llm bar for text_delta and adds tool spans", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 10_000 },
      {
        type: "text_delta",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        delta: "hello",
      },
      {
        type: "tool_call",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        toolCallId: "tc1",
        toolName: "search",
        input: { q: "x" },
        serverId: "srv1",
      },
      {
        type: "tool_result",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        toolCallId: "tc1",
        toolName: "search",
        output: { ok: true },
      },
    ];
    const spans = buildLiveChatPreviewSpans({ events, activeTurnId: TURN });
    const tool = spans.find((s) => s.category === "tool");
    expect(tool).toMatchObject({
      category: "tool",
      toolCallId: "tc1",
      toolName: "search",
      serverId: "srv1",
      status: "ok",
    });
    const order = spans.map((s) => s.category);
    expect(order).toContain("step");
    expect(order).toContain("llm");
    expect(order).toContain("tool");
  });

  it("marks tool error when tool_result has errorText", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 1 },
      {
        type: "tool_call",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        toolCallId: "tc-err",
        toolName: "bad",
        input: {},
      },
      {
        type: "tool_result",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        toolCallId: "tc-err",
        toolName: "bad",
        errorText: "boom",
      },
    ];
    const spans = buildLiveChatPreviewSpans({ events, activeTurnId: TURN });
    const tool = spans.find((s) => s.toolCallId === "tc-err");
    expect(tool?.status).toBe("error");
  });

  it("grows llm with previewWallElapsedMs for last text step", () => {
    const events: LiveChatTraceEvent[] = [
      { type: "turn_start", turnId: TURN, promptIndex: 0, startedAtMs: 1 },
      {
        type: "text_delta",
        turnId: TURN,
        promptIndex: 0,
        stepIndex: 0,
        delta: "a",
      },
    ];
    const noWall = buildLiveChatPreviewSpans({ events, activeTurnId: TURN });
    const withWall = buildLiveChatPreviewSpans({
      events,
      activeTurnId: TURN,
      previewWallElapsedMs: 5000,
    });
    const llmNo = noWall.find((s) => s.category === "llm")!;
    const llmYes = withWall.find((s) => s.category === "llm")!;
    expect(llmYes.endMs).toBeGreaterThan(llmNo.endMs);
  });
});

describe("pickTranscriptForLiveTracePreview", () => {
  it("prefers UI transcript when longer than snapshot", () => {
    const snap = [
      { role: "user" as const, content: "old" },
      { role: "assistant" as const, content: "a" },
    ];
    const ui = [...snap, { role: "user" as const, content: "new" }];
    expect(
      pickTranscriptForLiveTracePreview({
        snapshotMessages: snap,
        transcriptFromUi: ui,
      }),
    ).toEqual(ui);
  });

  it("keeps snapshot when UI is shorter or equal", () => {
    const snap = [{ role: "user" as const, content: "u" }];
    expect(
      pickTranscriptForLiveTracePreview({
        snapshotMessages: snap,
        transcriptFromUi: [],
      }),
    ).toEqual(snap);
  });
});

describe("applyPreviewSpansUserMessageIndices", () => {
  it("tags preview spans with the user message index for promptIndex", () => {
    const transcript = [
      { role: "user" as const, content: "draw a dog" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "save checkpoint" },
    ];
    const spans = [
      {
        id: "pv-st-1-0",
        name: "Step 1",
        category: "step" as const,
        promptIndex: 1,
        stepIndex: 0,
        status: "ok" as const,
        startMs: 0,
        endMs: 100,
      },
    ];
    const next = applyPreviewSpansUserMessageIndices(spans, transcript);
    expect(next[0]).toMatchObject({
      messageStartIndex: 2,
      messageEndIndex: 2,
    });
  });
});
