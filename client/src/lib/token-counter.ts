/**
 * Token counting using tiktoken (same as online token counters)
 * Counts BOTH input and output tokens for accurate context window tracking
 */

import { ChatMessage } from "@/lib/chat-types";
import { ModelDefinition } from "@/shared/types.js";

/**
 * Get accurate token count using tiktoken (same library as online counters)
 */
export async function getTokenCount(
  text: string,
  model: string = "gpt-4",
): Promise<number> {
  try {
    // Dynamic import to handle potential missing dependency
    const { getEncoding } = await import("js-tiktoken");

    // Map models to encodings (same as online token counters)
    const encodingMap = {
      // OpenAI models
      "gpt-4o": "o200k_base" as const,
      "gpt-4o-mini": "o200k_base" as const,
      "gpt-4.1": "o200k_base" as const,
      "gpt-4.1-mini": "o200k_base" as const,
      "gpt-4.1-nano": "o200k_base" as const,
      "gpt-5": "o200k_base" as const,
      "gpt-4": "cl100k_base" as const,
      "gpt-4-turbo": "cl100k_base" as const,
      "gpt-3.5-turbo": "cl100k_base" as const,

      // Claude models (use cl100k_base as approximation)
      "claude-opus-4-0": "cl100k_base" as const,
      "claude-sonnet-4-0": "cl100k_base" as const,
      "claude-3-7-sonnet-latest": "cl100k_base" as const,
      "claude-3-5-sonnet-latest": "cl100k_base" as const,
      "claude-3-5-haiku-latest": "cl100k_base" as const,

      // Google Gemini models (use cl100k_base as approximation)
      "gemini-2.5-pro": "cl100k_base" as const,
      "gemini-2.5-flash": "cl100k_base" as const,
      "gemini-2.5-flash-lite": "cl100k_base" as const,
      "gemini-2.0-flash-exp": "cl100k_base" as const,
      "gemini-1.5-pro": "cl100k_base" as const,
      "gemini-1.5-pro-002": "cl100k_base" as const,
      "gemini-1.5-flash": "cl100k_base" as const,
      "gemini-1.5-flash-002": "cl100k_base" as const,
      "gemini-1.5-flash-8b": "cl100k_base" as const,
      "gemini-1.5-flash-8b-001": "cl100k_base" as const,

      // Google Gemma models
      "gemma-3-2b": "cl100k_base" as const,
      "gemma-3-9b": "cl100k_base" as const,
      "gemma-3-27b": "cl100k_base" as const,
      "gemma-2-2b": "cl100k_base" as const,
      "gemma-2-9b": "cl100k_base" as const,
      "gemma-2-27b": "cl100k_base" as const,
      "codegemma-2b": "cl100k_base" as const,
      "codegemma-7b": "cl100k_base" as const,

      // DeepSeek models
      "deepseek-chat": "cl100k_base" as const,
      "deepseek-reasoner": "cl100k_base" as const,
    };

    const encoding =
      encodingMap[model as keyof typeof encodingMap] || "cl100k_base";
    const tokenizer = getEncoding(encoding);
    const tokens = tokenizer.encode(text);
    return tokens.length;
  } catch (error) {
    console.warn("Tiktoken not available, using estimation:", error);
    // Fallback: ~4 characters per token (rough average)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Get token count for a single message (includes OpenAI formatting overhead)
 */
export async function getMessageTokens(
  message: ChatMessage,
  model?: ModelDefinition,
): Promise<number> {
  const modelId = model?.id || "gpt-4";
  let tokens = await getTokenCount(message.content, modelId);

  // OpenAI adds ~4 tokens per message for formatting (role, etc.)
  tokens += 4;

  // Add tokens for tool calls if present
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      tokens += await getTokenCount(toolCall.name, modelId);
      tokens += await getTokenCount(
        JSON.stringify(toolCall.parameters),
        modelId,
      );
    }
  }

  // Add tokens for tool results if present
  if (message.toolResults && message.toolResults.length > 0) {
    for (const toolResult of message.toolResults) {
      tokens += await getTokenCount(JSON.stringify(toolResult.result), modelId);
    }
  }

  return tokens;
}

/**
 * Get total token count for ENTIRE conversation
 * This includes BOTH user inputs AND assistant responses
 * This is critical because responses consume context window too!
 */
export async function getConversationTokens(
  messages: ChatMessage[],
  systemPrompt?: string,
  model?: ModelDefinition,
): Promise<number> {
  const modelId = model?.id || "gpt-4";
  let totalTokens = 0;

  // Add system prompt tokens if present
  if (systemPrompt) {
    totalTokens += (await getTokenCount(systemPrompt, modelId)) + 4; // Base overhead
  }

  // Count ALL messages (user inputs AND assistant responses)
  for (const message of messages) {
    totalTokens += await getMessageTokens(message, model);
  }

  return totalTokens + 3; // Base conversation overhead
}

/**
 * Calculate context window usage percentage
 */
export function getContextUsagePercentage(
  tokenCount: number,
  model: ModelDefinition | null,
): number {
  if (!model || !model.contextWindow) {
    return 0;
  }

  return Math.min((tokenCount / model.contextWindow) * 100, 100);
}

/**
 * Get context window status with color coding
 */
export function getContextStatus(percentage: number) {
  if (percentage < 70) {
    return { status: "safe", color: "green" };
  } else if (percentage < 90) {
    return { status: "warning", color: "orange" };
  } else {
    return { status: "critical", color: "red" };
  }
}

/**
 * Format token count for display
 */
export function formatTokenCount(tokenCount: number): string {
  if (tokenCount < 1000) {
    return tokenCount.toString();
  } else if (tokenCount < 1000000) {
    return `${(tokenCount / 1000).toFixed(1)}K`;
  } else {
    return `${(tokenCount / 1000000).toFixed(1)}M`;
  }
}
