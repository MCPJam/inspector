import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "./eval-trace";
import type { LiveChatTraceEvent } from "./live-chat-trace";

const STEP_SEGMENT_MS = 120;
const MIN_BLOCK_MS = 80;
/** Cap relative growth from character count so the axis stays usable. */
const MAX_DELTA_STRETCH_MS = 12_000;

type StepAgg = {
  stepIndex: number;
  stepId: string;
  llmId: string;
  llmStartMs: number;
  llmEndMs: number;
  deltaChars: number;
  tools: EvalTraceSpan[];
};

/**
 * Stream events for `activeTurnId` until (exclusive) the first `trace_snapshot`
 * for that turn (snapshots replace preview).
 */
export function filterEventsForActiveTurnPreview(
  events: LiveChatTraceEvent[],
  activeTurnId: string,
): LiveChatTraceEvent[] {
  const out: LiveChatTraceEvent[] = [];
  for (const ev of events) {
    if (ev.type === "trace_snapshot" && ev.turnId === activeTurnId) {
      break;
    }
    if ("turnId" in ev && ev.turnId === activeTurnId) {
      out.push(ev);
    }
  }
  return out;
}

/**
 * Provisional waterfall spans for the active turn before the first `trace_snapshot`.
 * Replay-safe: pass full filtered event history each time.
 */
export function buildLiveChatPreviewSpans(options: {
  events: LiveChatTraceEvent[];
  activeTurnId: string | null;
  /** Wall-clock ms since turn_start; grows the open LLM bar while streaming. */
  previewWallElapsedMs?: number;
}): EvalTraceSpan[] {
  const { events, activeTurnId, previewWallElapsedMs } = options;
  if (!activeTurnId) {
    return [];
  }

  const relevant = filterEventsForActiveTurnPreview(events, activeTurnId);
  if (relevant.length === 0) {
    return [];
  }

  const byStep = new Map<number, StepAgg>();
  let cursor = 0;
  let turnStarted = false;
  let promptIndex = 0;
  let lastTextDeltaStep: number | null = null;

  const ensureStep = (stepIndex: number, pIdx: number): StepAgg => {
    promptIndex = pIdx;
    let agg = byStep.get(stepIndex);
    if (agg) {
      return agg;
    }
    const base = cursor;
    agg = {
      stepIndex,
      stepId: `pv-st-${activeTurnId}-${stepIndex}`,
      llmId: `pv-llm-${activeTurnId}-${stepIndex}`,
      llmStartMs: base,
      llmEndMs: base + MIN_BLOCK_MS,
      deltaChars: 0,
      tools: [],
    };
    byStep.set(stepIndex, agg);
    cursor = Math.max(cursor, agg.llmEndMs);
    return agg;
  };

  for (const ev of relevant) {
    switch (ev.type) {
      case "turn_start": {
        turnStarted = true;
        cursor = 0;
        promptIndex = ev.promptIndex;
        break;
      }
      case "text_delta": {
        const agg = ensureStep(ev.stepIndex, ev.promptIndex);
        agg.deltaChars += ev.delta.length;
        agg.llmEndMs = Math.max(
          agg.llmEndMs,
          agg.llmStartMs + MIN_BLOCK_MS,
          agg.llmStartMs + Math.min(agg.deltaChars * 3, MAX_DELTA_STRETCH_MS),
        );
        cursor = Math.max(cursor, agg.llmEndMs);
        lastTextDeltaStep = ev.stepIndex;
        break;
      }
      case "tool_call": {
        const agg = ensureStep(ev.stepIndex, ev.promptIndex);
        const toolStart = Math.max(agg.llmEndMs, cursor);
        agg.llmEndMs = toolStart;
        const toolSpan: EvalTraceSpan = {
          id: `pv-tool-${ev.toolCallId}`,
          parentId: agg.stepId,
          name: ev.toolName,
          category: "tool",
          promptIndex: ev.promptIndex,
          stepIndex: ev.stepIndex,
          status: "ok",
          startMs: toolStart,
          endMs: toolStart + STEP_SEGMENT_MS,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          serverId: ev.serverId,
        };
        agg.tools.push(toolSpan);
        cursor = toolSpan.endMs;
        break;
      }
      case "tool_result": {
        const agg = ensureStep(ev.stepIndex, ev.promptIndex);
        const toolSpan = agg.tools.find((t) => t.toolCallId === ev.toolCallId);
        if (toolSpan) {
          const err = Boolean(ev.errorText?.trim());
          toolSpan.endMs = Math.max(
            toolSpan.endMs,
            toolSpan.startMs + STEP_SEGMENT_MS,
          );
          toolSpan.status = err ? "error" : "ok";
          cursor = Math.max(cursor, toolSpan.endMs);
        }
        break;
      }
      default:
        break;
    }
  }

  if (turnStarted && byStep.size === 0) {
    ensureStep(0, promptIndex);
    lastTextDeltaStep = 0;
  }

  if (
    previewWallElapsedMs != null &&
    previewWallElapsedMs > 0 &&
    lastTextDeltaStep != null
  ) {
    const agg = byStep.get(lastTextDeltaStep);
    if (agg) {
      agg.llmEndMs = Math.max(
        agg.llmEndMs,
        agg.llmStartMs + Math.min(previewWallElapsedMs, 120_000),
      );
      cursor = Math.max(cursor, agg.llmEndMs);
    }
  }

  const sortedSteps = [...byStep.values()].sort(
    (a, b) => a.stepIndex - b.stepIndex,
  );
  const spans: EvalTraceSpan[] = [];

  for (const agg of sortedSteps) {
    const stepEndMs = Math.max(
      agg.llmEndMs,
      ...agg.tools.map((t) => t.endMs),
      agg.llmStartMs + MIN_BLOCK_MS,
    );
    spans.push({
      id: agg.stepId,
      name: `Step ${agg.stepIndex + 1}`,
      category: "step",
      promptIndex,
      stepIndex: agg.stepIndex,
      status: "ok",
      startMs: agg.llmStartMs,
      endMs: stepEndMs,
    });
    spans.push({
      id: agg.llmId,
      parentId: agg.stepId,
      name: "Agent",
      category: "llm",
      promptIndex,
      stepIndex: agg.stepIndex,
      status: "ok",
      startMs: agg.llmStartMs,
      endMs: agg.llmEndMs,
    });
    const toolsSorted = [...agg.tools].sort((a, b) => a.startMs - b.startMs);
    spans.push(...toolsSorted);
  }

  if (spans.length === 0) {
    return [];
  }

  const minStart = Math.min(...spans.map((s) => s.startMs));
  if (minStart !== 0) {
    const shift = -minStart;
    for (const s of spans) {
      s.startMs += shift;
      s.endMs += shift;
    }
  }

  return spans;
}

const PREVIEW_SPAN_ID_PREFIX = "pv-";

/**
 * Prefer UI-derived transcript when it has more messages than the snapshot blob
 * (snapshot updates only on trace_snapshot, so follow-up user turns stay stale).
 */
export function pickTranscriptForLiveTracePreview(options: {
  snapshotMessages: ModelMessage[] | undefined;
  transcriptFromUi: ModelMessage[] | null | undefined;
}): ModelMessage[] {
  const snap = options.snapshotMessages ?? [];
  const ui = options.transcriptFromUi ?? [];
  if (ui.length > snap.length) {
    return ui;
  }
  return snap;
}

/**
 * Map each preview span's promptIndex to the transcript index of that user turn
 * so TraceTimeline's prompt row shows the right "User: …" (not the first prompt).
 */
export function applyPreviewSpansUserMessageIndices(
  spans: EvalTraceSpan[],
  transcript: ModelMessage[],
): EvalTraceSpan[] {
  const userIndices: number[] = [];
  transcript.forEach((m, i) => {
    if (m.role === "user") {
      userIndices.push(i);
    }
  });

  return spans.map((s) => {
    if (!s.id.startsWith(PREVIEW_SPAN_ID_PREFIX)) {
      return s;
    }
    const p = s.promptIndex;
    if (typeof p !== "number" || p < 0 || p >= userIndices.length) {
      return s;
    }
    const idx = userIndices[p]!;
    return {
      ...s,
      messageStartIndex: idx,
      messageEndIndex: idx,
    };
  });
}
