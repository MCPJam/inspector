/**
 * Tool extraction utilities for AI SDK generateText results
 */

import type { ToolCall } from "./types.js";

type SourceToolCall = {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
};

/**
 * The part of a `generateText` result these read. Structural, so it holds
 * across AI SDK majors (whose `GenerateTextResult` generics keep changing).
 */
type ToolCallSource = {
  steps?: ReadonlyArray<{ toolCalls?: ReadonlyArray<SourceToolCall> }>;
  toolCalls?: ReadonlyArray<SourceToolCall>;
};

/**
 * Extract all tool calls from an AI SDK generateText result.
 * Collects tool calls from all steps in the agentic loop.
 *
 * @param result - The result from AI SDK's generateText
 * @returns Array of ToolCall objects with toolName and arguments
 */
export function extractToolCalls(
  result: ToolCallSource,
  options: {
    /**
     * Calls a tool-policy gate refused. They never reached a server, so they
     * are not calls the case can be graded on — the same exclusion the hosted
     * runner applies (`extractToolCallsExcludingPolicyBlocks`).
     */
    excludeToolCallIds?: ReadonlySet<string>;
  } = {}
): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const excluded = options.excludeToolCallIds;
  const keep = (toolCallId: unknown) =>
    !excluded ||
    typeof toolCallId !== "string" ||
    !excluded.has(toolCallId);

  // Extract from steps (multi-step agentic loop)
  if (result.steps && Array.isArray(result.steps)) {
    for (const step of result.steps) {
      if (step.toolCalls && Array.isArray(step.toolCalls)) {
        for (const tc of step.toolCalls) {
          if (!keep(tc.toolCallId)) continue;
          toolCalls.push({
            toolName: tc.toolName,
            arguments: (tc.input ?? {}) as Record<string, unknown>,
          });
        }
      }
    }
  }

  // If no steps, check top-level toolCalls (single-step result)
  if (
    toolCalls.length === 0 &&
    result.toolCalls &&
    Array.isArray(result.toolCalls)
  ) {
    for (const tc of result.toolCalls) {
      if (!keep(tc.toolCallId)) continue;
      toolCalls.push({
        toolName: tc.toolName,
        arguments: (tc.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return toolCalls;
}

/**
 * Extract tool names from an AI SDK generateText result.
 * Convenience function that returns just the tool names.
 *
 * @param result - The result from AI SDK's generateText
 * @returns Array of tool names that were called
 */
export function extractToolNames(result: ToolCallSource): string[] {
  return extractToolCalls(result).map((tc) => tc.toolName);
}
