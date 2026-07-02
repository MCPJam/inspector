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
import {
  mcpCallToolResultToModelOutput,
  type McpModelVisibleToolResultPolicy,
} from "@mcpjam/sdk/browser";

export interface PreludeTraceExecution {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  modelOutput?: unknown;
  state: "output-available" | "output-error";
  errorText?: string;
}

export type PreludeTraceOptions = McpModelVisibleToolResultPolicy;

export function hostStyleSupportsModelVisibleMcpToolImages(
  _hostStyle: string | null | undefined
): McpModelVisibleToolResultPolicy {
  return {
    modelVisibleMcpToolResults: {
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: true } },
    },
  };
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

function toMcpImageModelOutput(
  result: unknown,
  options: PreludeTraceOptions
): LanguageModelV2ToolResultOutput | undefined {
  try {
    return mcpCallToolResultToModelOutput(
      result as Parameters<typeof mcpCallToolResultToModelOutput>[0],
      options
    );
  } catch {
    return undefined;
  }
}

function toTraceToolResultOutput(
  execution: PreludeTraceExecution,
  options: PreludeTraceOptions = {}
): LanguageModelV2ToolResultOutput {
  if (execution.state === "output-error") {
    return {
      type: "error-text",
      value: execution.errorText ?? "Tool execution failed",
    };
  }

  if (execution.modelOutput) {
    return execution.modelOutput as LanguageModelV2ToolResultOutput;
  }

  const modelOutput = toMcpImageModelOutput(execution.result, options);
  if (modelOutput) {
    return modelOutput;
  }

  return {
    type: "json",
    value: toTraceJsonValue(execution.result),
  };
}

export function buildPreludeTraceEnvelope(
  executions: PreludeTraceExecution[],
  options: PreludeTraceOptions = {}
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
    const toolResultOutput = toTraceToolResultOutput(execution, options);

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
      ],
    } satisfies ModelMessage);
    const toolMessageIndex = messages.length;
    messages.push({
      role: "tool",
      content: [
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
      messageEndIndex: toolMessageIndex,
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
      messageEndIndex: toolMessageIndex,
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
        messageEndIndex: toolMessageIndex,
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
          ? execution.errorText ?? "Tool execution failed"
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
