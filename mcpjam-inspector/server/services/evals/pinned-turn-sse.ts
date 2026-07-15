/**
 * pinned-turn-sse.ts — synthesize the live SSE sequence for a model-free
 * pinned (`toolCall`) turn. A pinned turn has no model stream to translate,
 * so the streaming runners emit this fixed sequence instead:
 *
 *   turn_start → step_status(toolCall, running) → tool_call → tool_result →
 *   trace_snapshot(failure|turn_finish) → turn_finish →
 *   step_status(toolCall, ok|fail[, detail]) → error?
 *
 * This module owns `PinnedTurnSsePayload`; the local and hosted streaming
 * paths both call `emitPinnedTurnSse`, so the event ordering cannot drift
 * between them.
 */

import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ToolCall, ToolErrorRecord } from "@/shared/eval-matching";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import type { UsageTotals } from "./types";

export interface PinnedTurnSseDeps {
  emit: (event: EvalStreamEvent) => void;
  withSystemPrefix: (msgs: ModelMessage[]) => ModelMessage[];
  /** The runner's local `buildTraceSnapshotEvent` (unexported → passed in to
   *  avoid a cycle, same pattern as `HostedEvalSinksDeps`). */
  buildTraceSnapshotEvent: (params: {
    turnIndex: number;
    stepIndex?: number;
    snapshotKind: "step_finish" | "failure" | "turn_finish";
    messages: ModelMessage[];
    spans: EvalTraceSpan[];
    usage: UsageTotals;
    actualToolCalls: ToolCall[];
  }) => EvalStreamEvent;
}

export interface PinnedTurnSsePayload {
  turnIndex: number;
  /** The synthesized user line (`PinnedTurnAccounting.prompt`). */
  prompt: string;
  /** Iteration-cumulative transcript including the pinned message pair. */
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  usage: UsageTotals;
  toolCall?: ToolCall;
  toolCallId?: string;
  toolResult?: unknown;
  toolResultIsError?: boolean;
  toolError?: ToolErrorRecord;
  /** Set ⇒ the pinned call failed before an MCP call ran (server not connected). */
  iterationError?: string;
}

export function emitPinnedTurnSse(
  deps: PinnedTurnSseDeps,
  payload: PinnedTurnSsePayload
): void {
  const { emit, withSystemPrefix, buildTraceSnapshotEvent } = deps;
  const {
    turnIndex,
    prompt,
    messages,
    spans,
    usage,
    toolCall,
    toolCallId,
    toolResult,
    toolResultIsError,
    toolError,
    iterationError,
  } = payload;
  const failureDetail =
    iterationError ??
    toolError?.message ??
    (toolResultIsError ? "Pinned tool call failed" : undefined);
  emit({ type: "turn_start", turnIndex, prompt });
  emit({
    type: "step_status",
    turnIndex,
    kind: "toolCall",
    status: "running",
  });
  if (toolCall && toolCallId) {
    emit({
      type: "tool_call",
      toolName: toolCall.toolName,
      toolCallId,
      args: toolCall.arguments,
    });
    emit({
      type: "tool_result",
      toolCallId,
      result: toolResult,
      ...(toolResultIsError ? { isError: true } : {}),
    });
  }
  emit(
    buildTraceSnapshotEvent({
      turnIndex,
      snapshotKind: failureDetail ? "failure" : "turn_finish",
      messages: withSystemPrefix(messages),
      spans,
      actualToolCalls: toolCall ? [toolCall] : [],
      usage,
    })
  );
  emit({ type: "turn_finish", turnIndex });
  emit({
    type: "step_status",
    turnIndex,
    kind: "toolCall",
    status: failureDetail ? "fail" : "ok",
    ...(failureDetail ? { detail: failureDetail } : {}),
  });
  if (failureDetail) {
    emit({ type: "error", message: failureDetail });
  }
}
