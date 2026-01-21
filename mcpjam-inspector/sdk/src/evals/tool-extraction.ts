/**
 * Tool call extraction utilities for extracting tool calls from AI SDK results.
 *
 * Extracted from server/services/evals-runner.ts:303-369.
 * Handles multiple tool call formats from steps and messages.
 */

import type { ToolCall } from "./types.js";

/**
 * Message type that may contain tool calls.
 * Compatible with AI SDK's CoreMessage format.
 */
interface MessageWithToolCalls {
  role: string;
  content?: unknown;
  toolCalls?: unknown[];
}

/**
 * Step type from AI SDK's generateText result.
 */
interface StepWithToolCalls {
  toolCalls?: Array<{
    toolName?: string;
    name?: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
  }>;
}

/**
 * Content item that may be a tool call.
 */
interface ToolCallContentItem {
  type?: string;
  toolName?: string;
  name?: string;
  input?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

/**
 * Result type from AI SDK's generateText function.
 */
export interface GenerateTextResult {
  steps?: StepWithToolCalls[];
  response?: {
    messages?: MessageWithToolCalls[];
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  text?: string;
}

/**
 * Extracts all tool calls from a generateText result.
 *
 * This function handles multiple sources of tool calls:
 * 1. result.steps - More reliable for multi-step conversations
 * 2. result.response.messages - Fallback for additional tool calls
 *
 * It also handles multiple tool call formats:
 * - toolCalls array on steps
 * - content array with type: "tool-call" items
 * - Legacy toolCalls array on assistant messages
 *
 * @param result - The result from generateText
 * @param messages - Optional messages array to also extract from
 * @returns Array of extracted tool calls with name and arguments
 *
 * @example
 * ```typescript
 * const result = await generateText({
 *   model,
 *   messages: [{ role: "user", content: "Create a task" }],
 *   tools,
 * });
 *
 * const toolCalls = extractToolCalls(result);
 * // [{ toolName: "create_task", arguments: { title: "New Task" } }]
 * ```
 */
export function extractToolCalls(
  result: GenerateTextResult,
  messages?: MessageWithToolCalls[],
): ToolCall[] {
  const toolsCalled: ToolCall[] = [];

  // First, extract from result.steps if available (more reliable for multi-step conversations)
  if (result.steps && Array.isArray(result.steps)) {
    for (const step of result.steps) {
      const stepToolCalls = step.toolCalls || [];
      for (const call of stepToolCalls) {
        if (call?.toolName || call?.name) {
          toolsCalled.push({
            toolName: call.toolName ?? call.name!,
            arguments: call.args ?? call.input ?? {},
          });
        }
      }
    }
  }

  // Get final messages from result or use provided messages
  const finalMessages =
    messages ?? (result.response?.messages as MessageWithToolCalls[]) ?? [];

  // Fallback: also check messages (in case steps don't have all info)
  for (const msg of finalMessages) {
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const item of msg.content as ToolCallContentItem[]) {
        if (item?.type === "tool-call") {
          const name = item.toolName ?? item.name;
          if (name) {
            const args = item.input ?? item.parameters ?? item.args ?? {};
            // Check if not already added from steps
            const alreadyAdded = toolsCalled.some(
              (tc) =>
                tc.toolName === name &&
                JSON.stringify(tc.arguments) === JSON.stringify(args),
            );
            if (!alreadyAdded) {
              toolsCalled.push({
                toolName: name,
                arguments: args,
              });
            }
          }
        }
      }
    }

    // Also check legacy toolCalls array format
    if (msg?.role === "assistant" && Array.isArray(msg.toolCalls)) {
      for (const call of msg.toolCalls as ToolCallContentItem[]) {
        if (call?.toolName || call?.name) {
          const name = (call.toolName ?? call.name)!;
          const args = call.args ?? call.input ?? {};
          const alreadyAdded = toolsCalled.some(
            (tc) =>
              tc.toolName === name &&
              JSON.stringify(tc.arguments) === JSON.stringify(args),
          );
          if (!alreadyAdded) {
            toolsCalled.push({
              toolName: name,
              arguments: args,
            });
          }
        }
      }
    }
  }

  return toolsCalled;
}

/**
 * Extracts just the tool names from a generateText result.
 *
 * @param result - The result from generateText
 * @param messages - Optional messages array to also extract from
 * @returns Array of tool names that were called
 *
 * @example
 * ```typescript
 * const toolNames = extractToolNames(result);
 * // ["create_task", "update_task"]
 * ```
 */
export function extractToolNames(
  result: GenerateTextResult,
  messages?: MessageWithToolCalls[],
): string[] {
  const toolCalls = extractToolCalls(result, messages);
  return toolCalls.map((tc) => tc.toolName);
}

/**
 * Extracts unique tool names from a generateText result.
 *
 * @param result - The result from generateText
 * @param messages - Optional messages array to also extract from
 * @returns Array of unique tool names that were called
 */
export function extractUniqueToolNames(
  result: GenerateTextResult,
  messages?: MessageWithToolCalls[],
): string[] {
  return [...new Set(extractToolNames(result, messages))];
}
