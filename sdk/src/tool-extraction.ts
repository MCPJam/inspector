/**
 * Tool extraction utilities for AI SDK generateText results
 */

import { GenerateTextResult, ToolSet } from "ai";
import type { ToolCall } from "./types.js";

/**
 * Extract all tool calls from an AI SDK generateText result.
 * Collects tool calls from all steps in the agentic loop.
 *
 * @param result - The result from AI SDK's generateText
 * @returns Array of ToolCall objects with toolName and arguments
 */
export function extractToolCalls(
  result: GenerateTextResult<ToolSet, never>
): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Extract from steps (multi-step agentic loop)
  if (result.steps && Array.isArray(result.steps)) {
    for (const step of result.steps) {
      if (step.toolCalls && Array.isArray(step.toolCalls)) {
        for (const tc of step.toolCalls) {
          toolCalls.push({
            toolName: tc.toolName,
            arguments: tc.input ?? {},
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
      toolCalls.push({
        toolName: tc.toolName,
        arguments: tc.input ?? {},
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
export function extractToolNames(
  result: GenerateTextResult<ToolSet, never>
): string[] {
  return extractToolCalls(result).map((tc) => tc.toolName);
}
