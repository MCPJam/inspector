/**
 * Shared `DirectChatTurnTraceEvents` factory for the two routes that drive
 * `runDirectChatTurn` through an SSE writer:
 *
 *   - Route 4 (user API-key) — `streamDirectChatWithLiveTrace` in
 *     `routes/mcp/chat-v2.ts`.
 *   - Route 3 (local-org BYOK) — `handleLocalOrgChatModel` in
 *     `org-model-stream-handler.ts`.
 *
 * Both routes need byte-identical SSE wire output (the client trace
 * stream is the same `live-chat-trace` event stream). Extracting the
 * callback factory keeps them in lockstep — any future trace event
 * added here lands on both routes at once.
 *
 * `eval`'s `stream-adapter.ts` is the headless analogue and stays
 * separate — eval's `streamSink: "none"` consumers want the parity
 * top-level callbacks (`onLiveTextDelta` / `onStepFinish` /
 * `onEngineError`), not the SSE writer.
 */

import type { UIMessageChunk } from "ai";
import type { DirectChatTurnTraceEvents } from "./direct-chat-turn.js";
import {
  emitRequestPayload,
  emitTraceSnapshot,
  writeTraceEvent,
} from "./live-chat-trace-stream.js";
import { buildResolvedModelRequestPayload } from "./model-request-payload.js";

export type DirectChatSseWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Build the `traceEvents` bag for the SSE terminal of `runDirectChatTurn`.
 * Returns a fresh object on each call so the caller can layer additional
 * route-specific behavior by spreading + overriding individual fields.
 */
export function buildDirectChatTraceCallbacks(
  writer: DirectChatSseWriter,
): DirectChatTurnTraceEvents {
  return {
    onTurnStart: (event) => {
      writeTraceEvent(writer, {
        type: "turn_start",
        turnId: event.turnId,
        promptIndex: event.promptIndex,
        startedAtMs: event.startedAtMs,
      });
    },
    onRequestPayload: (event) => {
      emitRequestPayload(writer, {
        turnId: event.turnId,
        promptIndex: event.promptIndex,
        stepIndex: event.stepIndex,
        payload: buildResolvedModelRequestPayload({
          systemPrompt: event.systemPrompt,
          tools: event.tools,
          messages: event.messages,
        }),
      });
    },
    onTextDelta: (event) => {
      writeTraceEvent(writer, {
        type: "text_delta",
        turnId: event.turnId,
        promptIndex: event.promptIndex,
        stepIndex: event.stepIndex,
        delta: event.delta,
      });
    },
    onToolCallChunk: (event) => {
      writeTraceEvent(writer, {
        type: "tool_call",
        turnId: event.turnId,
        promptIndex: event.promptIndex,
        stepIndex: event.stepIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        serverId: event.serverId,
      });
    },
    onToolResultChunk: (event) => {
      writeTraceEvent(writer, {
        type: "tool_result",
        turnId: event.turnId,
        promptIndex: event.promptIndex,
        stepIndex: event.stepIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        serverId: event.serverId,
      });
    },
    onStepSnapshot: ({ traceHistory, tracedTools, traceTurn }) => {
      emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
    },
    onTurnError: ({
      turnId,
      promptIndex,
      stepIndex,
      errorText,
      traceTurn,
      tracedTools,
      traceHistory,
    }) => {
      emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
      writeTraceEvent(writer, {
        type: "error",
        turnId,
        promptIndex,
        stepIndex,
        errorText,
      });
      writeTraceEvent(writer, {
        type: "turn_finish",
        turnId,
        promptIndex,
        usage: traceTurn.turnUsage,
      });
    },
    onTurnFinish: ({ turnId, promptIndex, finishReason, usage }) => {
      writeTraceEvent(writer, {
        type: "turn_finish",
        turnId,
        promptIndex,
        finishReason,
        usage,
      });
    },
  };
}
