/**
 * Tool extraction utilities for AI SDK generateText results
 */

import type { ToolCall } from "./types.js";

/**
 * Represents a tool call from AI SDK's generateText result.
 * Made flexible to handle different AI SDK versions.
 */
interface AISDKToolCall {
  toolName: string;
  /** Arguments - 'args' in v3+ format */
  args?: Record<string, unknown>;
  toolCallId?: string;
}

/**
 * Represents a step from AI SDK's generateText result
 */
interface AISDKStep {
  toolCalls?: AISDKToolCall[];
}

/**
 * Token usage format from AI SDK.
 * Supports both older (promptTokens/completionTokens) and newer (inputTokens/outputTokens) formats.
 */
export interface AISDKUsage {
  // Older format
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // Newer format (AI SDK v6+)
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Minimal interface for AI SDK's GenerateTextResult
 * We only extract what we need to avoid tight coupling.
 */
export interface GenerateTextResultLike {
  text: string;
  steps?: AISDKStep[];
  toolCalls?: AISDKToolCall[];
  /** Token usage for the final step */
  usage?: AISDKUsage;
  /** Total token usage across all steps (for multi-step generations) */
  totalUsage?: AISDKUsage;
}

/**
 * Extract all tool calls from an AI SDK generateText result.
 * Collects tool calls from all steps in the agentic loop.
 *
 * @param result - The result from AI SDK's generateText
 * @returns Array of ToolCall objects with toolName and arguments
 */
export function extractToolCalls(result: GenerateTextResultLike): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Extract from steps (multi-step agentic loop)
  if (result.steps && Array.isArray(result.steps)) {
    for (const step of result.steps) {
      if (step.toolCalls && Array.isArray(step.toolCalls)) {
        for (const tc of step.toolCalls) {
          toolCalls.push({
            toolName: tc.toolName,
            arguments: tc.args ?? {},
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
        arguments: tc.args ?? {},
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
export function extractToolNames(result: GenerateTextResultLike): string[] {
  return extractToolCalls(result).map((tc) => tc.toolName);
}
