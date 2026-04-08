import type {
  LanguageModelV2ToolResultOutput,
  JSONValue,
} from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type {
  LiveChatTraceEnvelope,
  LiveChatTraceEvent,
  LiveChatTraceToolCall,
} from "@/shared/live-chat-trace";
import type { EvalTraceSpan } from "@/shared/eval-trace";

export interface PreludeTraceExecution {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  state: "output-available" | "output-error";
  errorText?: string;
}

function toTraceJsonValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}

function toTraceToolResultOutput(
  execution: PreludeTraceExecution,
): LanguageModelV2ToolResultOutput {
  if (execution.state === "output-error") {
    return {
      type: "error-text",
      value: execution.errorText ?? "Tool execution failed",
    };
  }

  return {
    type: "json",
    value: toTraceJsonValue(execution.result),
  };
}

export function buildPreludeTraceEnvelope(
  executions: PreludeTraceExecution[],
): LiveChatTraceEnvelope | null {
  if (executions.length === 0) {
    return null;
  }

  const messages: ModelMessage[] = [];
  const spans: EvalTraceSpan[] = [];
  const turns: Array<{
    turnId: string;
    promptIndex: number;
    durationMs: number;
    actualToolCalls: LiveChatTraceToolCall[];
  }> = [];
  const events: LiveChatTraceEvent[] = [];
  const actualToolCalls: LiveChatTraceToolCall[] = [];
  const durationMs = 60;

  executions.forEach((execution, index) => {
    const startMs = index * durationMs;
    const endMs = startMs + durationMs;
    const userMessageIndex = messages.length;
    const assistantMessageIndex = userMessageIndex + 1;
    const promptIndex = index;
    const toolCall: LiveChatTraceToolCall = {
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      arguments: execution.params,
    };
    const toolResultOutput = toTraceToolResultOutput(execution);

    messages.push({
      role: "user",
      content: `Execute \`${execution.toolName}\``,
    } satisfies ModelMessage);
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: execution.toolCallId,
          toolName: execution.toolName,
          input: execution.params,
        },
        {
          type: "tool-result" as const,
          toolCallId: execution.toolCallId,
          toolName: execution.toolName,
          output: toolResultOutput,
        },
      ],
    } satisfies ModelMessage);

    const stepId = `prelude-step-${execution.toolCallId}`;
    spans.push({
      id: stepId,
      name: "Manual tool run",
      category: "step",
      promptIndex,
      stepIndex: 0,
      status: execution.state === "output-error" ? "error" : "ok",
      startMs,
      endMs,
      messageStartIndex: assistantMessageIndex,
      messageEndIndex: assistantMessageIndex,
    });
    spans.push({
      id: `prelude-tool-${execution.toolCallId}`,
      parentId: stepId,
      name: execution.toolName,
      category: "tool",
      promptIndex,
      stepIndex: 0,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      status: execution.state === "output-error" ? "error" : "ok",
      startMs,
      endMs,
      messageStartIndex: assistantMessageIndex,
      messageEndIndex: assistantMessageIndex,
    });
    if (execution.state === "output-error") {
      spans.push({
        id: `prelude-error-${execution.toolCallId}`,
        parentId: stepId,
        name: execution.errorText ?? "Tool error",
        category: "error",
        promptIndex,
        stepIndex: 0,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: "error",
        startMs,
        endMs,
        messageStartIndex: assistantMessageIndex,
        messageEndIndex: assistantMessageIndex,
      });
    }

    turns.push({
      turnId: execution.toolCallId,
      promptIndex,
      durationMs,
      actualToolCalls: [toolCall],
    });
    actualToolCalls.push(toolCall);
    events.push({
      type: "turn_start",
      turnId: execution.toolCallId,
      promptIndex,
      startedAtMs: startMs,
    });
    events.push({
      type: "tool_call",
      turnId: execution.toolCallId,
      promptIndex,
      stepIndex: 0,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      input: execution.params,
    });
    events.push({
      type: "tool_result",
      turnId: execution.toolCallId,
      promptIndex,
      stepIndex: 0,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      output: toolResultOutput,
      errorText:
        execution.state === "output-error"
          ? (execution.errorText ?? "Tool execution failed")
          : undefined,
    });
    events.push({
      type: "turn_finish",
      turnId: execution.toolCallId,
      promptIndex,
    });
  });

  return {
    traceVersion: 1,
    messages,
    spans,
    actualToolCalls,
    events,
    turns,
  };
}
