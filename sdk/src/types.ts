/**
 * Core types for SDK evals functionality
 */

/**
 * Supported LLM providers
 */
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "azure"
  | "deepseek"
  | "google"
  | "ollama"
  | "mistral"
  | "litellm"
  | "openrouter"
  | "xai";

/**
 * Configuration for an LLM
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
}

/**
 * Represents a tool call made by the LLM
 */
export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Raw query result data (used internally)
 */
export interface QueryResultData {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  latencyMs: number;
  error?: string;
}
