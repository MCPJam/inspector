import type { ModelMessage } from "ai";
import type { EvalTraceBlobV1, EvalTraceSpan } from "./eval-trace";

export type LiveChatTraceUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LiveChatTraceToolCall = {
  toolCallId?: string;
  toolName: string;
  arguments: Record<string, any>;
  serverId?: string;
};

export type LiveChatTraceSnapshot = {
  traceVersion: 1;
  promptIndex: number;
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  usage?: LiveChatTraceUsage;
  actualToolCalls?: LiveChatTraceToolCall[];
};

export type LiveChatTraceTurnSummary = {
  turnId: string;
  promptIndex: number;
  durationMs: number;
  usage?: LiveChatTraceUsage;
  actualToolCalls?: LiveChatTraceToolCall[];
};

export type LiveChatTraceEnvelope = EvalTraceBlobV1 & {
  usage?: LiveChatTraceUsage;
  actualToolCalls?: LiveChatTraceToolCall[];
  events?: LiveChatTraceEvent[];
  turns?: LiveChatTraceTurnSummary[];
  /**
   * Wall-clock bounds for the merged timeline (first turn_start through last span offset).
   * Used by TraceTimeline the same way as eval iteration timestamps.
   */
  traceStartedAtMs?: number;
  traceEndedAtMs?: number;
};

export type LiveChatTraceEvent =
  | {
      type: "turn_start";
      turnId: string;
      promptIndex: number;
      startedAtMs: number;
    }
  | {
      type: "text_delta";
      turnId: string;
      promptIndex: number;
      stepIndex: number;
      delta: string;
    }
  | {
      type: "tool_call";
      turnId: string;
      promptIndex: number;
      stepIndex: number;
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      serverId?: string;
    }
  | {
      type: "tool_result";
      turnId: string;
      promptIndex: number;
      stepIndex: number;
      toolCallId: string;
      toolName: string;
      output?: unknown;
      errorText?: string;
      serverId?: string;
    }
  | {
      type: "trace_snapshot";
      turnId: string;
      promptIndex: number;
      snapshot: LiveChatTraceSnapshot;
    }
  | {
      type: "turn_finish";
      turnId: string;
      promptIndex: number;
      finishReason?: string;
      usage?: LiveChatTraceUsage;
    }
  | {
      type: "error";
      turnId: string;
      promptIndex: number;
      stepIndex?: number;
      errorText: string;
    };

export function mergeLiveChatTraceUsage(
  base?: LiveChatTraceUsage,
  delta?: LiveChatTraceUsage,
): LiveChatTraceUsage | undefined {
  if (!base && !delta) {
    return undefined;
  }

  const next: LiveChatTraceUsage = {};
  const inputTokens = (base?.inputTokens ?? 0) + (delta?.inputTokens ?? 0);
  const outputTokens = (base?.outputTokens ?? 0) + (delta?.outputTokens ?? 0);
  const totalTokens = (base?.totalTokens ?? 0) + (delta?.totalTokens ?? 0);

  if (inputTokens > 0) {
    next.inputTokens = inputTokens;
  }
  if (outputTokens > 0) {
    next.outputTokens = outputTokens;
  }
  if (totalTokens > 0) {
    next.totalTokens = totalTokens;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function getTraceSpansDurationMs(
  spans: EvalTraceSpan[] | null | undefined,
): number {
  if (!Array.isArray(spans) || spans.length === 0) {
    return 0;
  }

  return spans.reduce((max, span) => Math.max(max, span.endMs), 0);
}

export function rebaseTraceSpans(
  spans: EvalTraceSpan[] | null | undefined,
  offsetMs: number,
): EvalTraceSpan[] {
  if (!Array.isArray(spans) || spans.length === 0) {
    return [];
  }

  return spans.map((span) => ({
    ...span,
    startMs: span.startMs + offsetMs,
    endMs: span.endMs + offsetMs,
  }));
}
