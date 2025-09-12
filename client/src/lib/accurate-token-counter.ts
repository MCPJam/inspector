/**
 * High-accuracy token counter using real tokenizers
 * Supports OpenAI (GPT), Anthropic (Claude), Google (Gemini), and DeepSeek models
 */

import { get_encoding, Tiktoken } from "tiktoken";
import { ChatMessage } from "@/lib/chat-types";
import { ModelDefinition } from "@/shared/types.js";

// Cache tokenizers to avoid re-initialization
const tokenizerCache = new Map<string, Tiktoken>();

/**
 * Model-specific tokenizer configurations
 */
const TOKENIZER_CONFIGS = {
  // OpenAI models
  "gpt-4": "cl100k_base",
  "gpt-4-turbo": "cl100k_base",
  "gpt-4o": "o200k_base", // GPT-4o uses a newer encoding
  "gpt-4o-mini": "o200k_base",
  "gpt-4.1": "o200k_base",
  "gpt-4.1-mini": "o200k_base",
  "gpt-4.1-nano": "o200k_base",
  "gpt-5": "o200k_base",
  "gpt-3.5-turbo": "cl100k_base",

  // For non-OpenAI models, we'll use cl100k_base as approximation
  // since it's the most common modern tokenizer
  "claude-3-5-sonnet-latest": "cl100k_base",
  "claude-3-5-haiku-latest": "cl100k_base",
  "claude-3-7-sonnet-latest": "cl100k_base",
  "claude-opus-4-0": "cl100k_base",
  "claude-sonnet-4-0": "cl100k_base",
  "deepseek-chat": "cl100k_base",
  "deepseek-reasoner": "cl100k_base",
  "gemini-1.5-pro": "cl100k_base",
  "gemini-1.5-flash": "cl100k_base",
  "gemini-2.5-pro": "cl100k_base",
  "gemini-2.5-flash": "cl100k_base",
  "gemini-2.0-flash-experimental": "cl100k_base",
} as const;

/**
 * Get or create a tokenizer for a specific model
 */
function getTokenizer(modelId: string): Tiktoken {
  const cacheKey = modelId;

  if (tokenizerCache.has(cacheKey)) {
    return tokenizerCache.get(cacheKey)!;
  }

  // Get the encoding name for this model
  const encodingName =
    TOKENIZER_CONFIGS[modelId as keyof typeof TOKENIZER_CONFIGS] ||
    "cl100k_base";

  try {
    const tokenizer = get_encoding(encodingName);
    tokenizerCache.set(cacheKey, tokenizer);
    return tokenizer;
  } catch (error) {
    console.warn(
      `Failed to load tokenizer for ${modelId}, falling back to cl100k_base:`,
      error,
    );
    // Fallback to the most common encoding
    const fallbackTokenizer = get_encoding("cl100k_base");
    tokenizerCache.set(cacheKey, fallbackTokenizer);
    return fallbackTokenizer;
  }
}

/**
 * Count tokens using the actual model tokenizer
 */
export function getAccurateTokenCount(
  text: string,
  model: ModelDefinition,
): number {
  if (!text) return 0;

  try {
    const tokenizer = getTokenizer(model.id as string);
    const tokens = tokenizer.encode(text);
    return tokens.length;
  } catch (error) {
    console.warn("Tokenizer failed, falling back to estimation:", error);
    // Fallback to our original estimation method
    return Math.ceil(text.length / 4);
  }
}

/**
 * Count tokens for a complete message with accurate tokenization
 */
export function getAccurateMessageTokens(
  message: ChatMessage,
  model: ModelDefinition,
): number {
  let tokens = 0;

  // Base message overhead (varies by model but ~3-4 tokens is typical)
  tokens += getMessageOverhead(model);

  // Content tokens using real tokenizer
  tokens += getAccurateTokenCount(message.content, model);

  // Tool calls tokens
  if (message.toolCalls && message.toolCalls.length > 0) {
    message.toolCalls.forEach((toolCall) => {
      tokens += getAccurateTokenCount(toolCall.name, model);
      tokens += getAccurateTokenCount(
        JSON.stringify(toolCall.parameters),
        model,
      );
      // Additional tokens for tool call structure
      tokens += 10; // Rough estimate for JSON structure overhead
    });
  }

  // Tool results tokens
  if (message.toolResults && message.toolResults.length > 0) {
    message.toolResults.forEach((toolResult) => {
      tokens += getAccurateTokenCount(JSON.stringify(toolResult.result), model);
      // Additional tokens for tool result structure
      tokens += 8; // Rough estimate for JSON structure overhead
    });
  }

  // Attachment tokens (just names for now)
  if (message.attachments && message.attachments.length > 0) {
    message.attachments.forEach((attachment) => {
      tokens += getAccurateTokenCount(attachment.name, model);
    });
  }

  return tokens;
}

/**
 * Get message overhead tokens based on model provider
 */
function getMessageOverhead(model: ModelDefinition): number {
  switch (model.provider) {
    case "openai":
      return 3; // OpenAI messages have ~3 tokens overhead
    case "anthropic":
      return 4; // Claude messages have ~4 tokens overhead
    case "google":
      return 2; // Gemini messages have ~2 tokens overhead
    case "deepseek":
      return 3; // DeepSeek similar to OpenAI
    default:
      return 4; // Conservative default
  }
}

/**
 * Calculate total tokens for conversation with accurate tokenization
 */
export function getAccurateConversationTokens(
  messages: ChatMessage[],
  model: ModelDefinition,
  systemPrompt?: string,
): number {
  let totalTokens = 0;

  // System prompt tokens
  if (systemPrompt) {
    totalTokens += getAccurateTokenCount(systemPrompt, model);
    totalTokens += getMessageOverhead(model); // System message overhead
  }

  // Message tokens
  messages.forEach((message) => {
    totalTokens += getAccurateMessageTokens(message, model);
  });

  // Conversation-level overhead (for chat completion format)
  totalTokens += getConversationOverhead(model, messages.length);

  return totalTokens;
}

/**
 * Get conversation-level token overhead
 */
function getConversationOverhead(
  model: ModelDefinition,
  messageCount: number,
): number {
  switch (model.provider) {
    case "openai":
      // OpenAI has additional tokens for conversation framing
      return Math.max(2, Math.floor(messageCount * 0.1));
    case "anthropic":
      // Claude has minimal conversation overhead
      return 1;
    case "google":
      // Gemini has variable overhead
      return Math.max(1, Math.floor(messageCount * 0.05));
    case "deepseek":
      // Similar to OpenAI
      return Math.max(2, Math.floor(messageCount * 0.1));
    default:
      return 2;
  }
}

/**
 * Compare accuracy between estimation and real tokenization
 */
export function compareTokenizationMethods(
  text: string,
  model: ModelDefinition,
): {
  estimated: number;
  accurate: number;
  accuracy: number;
} {
  const estimated = Math.ceil(text.length / 4);
  const accurate = getAccurateTokenCount(text, model);
  const accuracy =
    (Math.min(estimated, accurate) / Math.max(estimated, accurate)) * 100;

  return { estimated, accurate, accuracy };
}

/**
 * Cleanup tokenizers (call this when component unmounts or model changes)
 */
export function cleanupTokenizers(): void {
  tokenizerCache.forEach((tokenizer) => {
    try {
      tokenizer.free();
    } catch (error) {
      console.warn("Error freeing tokenizer:", error);
    }
  });
  tokenizerCache.clear();
}

/**
 * Check if accurate tokenization is available for a model
 */
export function isAccurateTokenizationAvailable(
  model: ModelDefinition,
): boolean {
  try {
    const encodingName =
      TOKENIZER_CONFIGS[model.id as keyof typeof TOKENIZER_CONFIGS];
    return encodingName !== undefined;
  } catch {
    return false;
  }
}
