import type {
  UIMessageChunk,
  ToolSet,
  ToolModelMessage,
  AssistantModelMessage,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type {
  LiveChatTraceEvent,
  LiveChatTraceSnapshot,
  LiveChatTraceToolCall,
  LiveChatTraceUsage,
} from "@/shared/live-chat-trace";

export interface LiveTraceEventWriter {
  write: (chunk: UIMessageChunk) => void;
}

export interface LiveTraceSnapshotTurnContext {
  turnId: string;
  promptIndex: number;
  promptMessageStartIndex: number;
  turnSpans: EvalTraceSpan[];
  turnUsage?: LiveChatTraceUsage;
}

export function generateLiveTraceTurnId(): string {
  return `trace_turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneTraceValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getPromptIndex(messageHistory: ModelMessage[]): number {
  const userCount = messageHistory.reduce(
    (count, message) => count + (message?.role === "user" ? 1 : 0),
    0,
  );
  return Math.max(0, userCount - 1);
}

function getLatestUserMessageIndex(messageHistory: ModelMessage[]): number {
  for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
    if (messageHistory[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

export function getPromptMessageStartIndex(
  messageHistory: ModelMessage[],
): number {
  const latestUserMessageIndex = getLatestUserMessageIndex(messageHistory);
  if (latestUserMessageIndex < 0) {
    return Math.max(0, messageHistory.length);
  }
  return Math.min(latestUserMessageIndex + 1, messageHistory.length);
}

export function readToolServerId(
  tools: ToolSet,
  toolName: string,
): string | undefined {
  const tool = tools[toolName] as { _serverId?: unknown } | undefined;
  return typeof tool?._serverId === "string" ? tool._serverId : undefined;
}

export function toTraceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function writeTraceEvent(
  writer: LiveTraceEventWriter,
  event: LiveChatTraceEvent,
): void {
  writer.write({
    type: "data-trace-event",
    data: event,
    transient: true,
  } as unknown as UIMessageChunk);
}

export function collectActualToolCalls(
  messageHistory: ModelMessage[],
  tools: ToolSet,
  promptMessageStartIndex: number,
): LiveChatTraceToolCall[] {
  const actualToolCalls: LiveChatTraceToolCall[] = [];
  const seen = new Set<string>();

  for (
    let messageIndex = promptMessageStartIndex;
    messageIndex < messageHistory.length;
    messageIndex += 1
  ) {
    const message = messageHistory[messageIndex];
    if (message?.role !== "assistant") {
      continue;
    }

    const assistantMessage = message as AssistantModelMessage;
    if (!Array.isArray(assistantMessage.content)) {
      continue;
    }

    for (const part of assistantMessage.content) {
      if (part.type !== "tool-call") {
        continue;
      }

      const dedupeKey =
        typeof part.toolCallId === "string" && part.toolCallId.length > 0
          ? part.toolCallId
          : `${part.toolName}:${JSON.stringify(part.input ?? {})}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      actualToolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        arguments: toTraceRecord(part.input),
        serverId: readToolServerId(tools, part.toolName),
      });
    }
  }

  return actualToolCalls;
}

export function emitTraceSnapshot(
  writer: LiveTraceEventWriter,
  messageHistory: ModelMessage[],
  tools: ToolSet,
  traceTurn: LiveTraceSnapshotTurnContext,
): void {
  const snapshot: LiveChatTraceSnapshot = {
    traceVersion: 1,
    promptIndex: traceTurn.promptIndex,
    messages: cloneTraceValue(messageHistory),
    spans: cloneTraceValue(traceTurn.turnSpans),
    usage: traceTurn.turnUsage
      ? cloneTraceValue(traceTurn.turnUsage)
      : undefined,
    actualToolCalls: collectActualToolCalls(
      messageHistory,
      tools,
      traceTurn.promptMessageStartIndex,
    ),
  };

  writeTraceEvent(writer, {
    type: "trace_snapshot",
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    snapshot,
  });
}

export function setToolSpanMessageRangesFromResults(
  spans: EvalTraceSpan[],
  messageHistory: ModelMessage[],
  promptIndex: number,
  stepIndex: number,
  toolCallIds: Set<string>,
): void {
  if (toolCallIds.size === 0) {
    return;
  }

  const toolMessageIndexByCallId = new Map<string, number>();
  for (
    let messageIndex = 0;
    messageIndex < messageHistory.length;
    messageIndex += 1
  ) {
    const message = messageHistory[messageIndex];
    if (message?.role !== "tool") {
      continue;
    }
    const toolMessage = message as ToolModelMessage;
    for (const part of toolMessage.content) {
      if (
        part.type === "tool-result" &&
        typeof part.toolCallId === "string" &&
        toolCallIds.has(part.toolCallId)
      ) {
        toolMessageIndexByCallId.set(part.toolCallId, messageIndex);
      }
    }
  }

  for (const span of spans) {
    if (
      span.category !== "tool" ||
      (span.promptIndex ?? 0) !== promptIndex ||
      span.stepIndex !== stepIndex ||
      typeof span.toolCallId !== "string"
    ) {
      continue;
    }

    const toolMessageIndex = toolMessageIndexByCallId.get(span.toolCallId);
    if (typeof toolMessageIndex === "number") {
      span.messageStartIndex = toolMessageIndex;
      span.messageEndIndex = toolMessageIndex;
    }
  }
}
